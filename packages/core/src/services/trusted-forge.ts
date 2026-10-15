import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ValidationError } from "@task-weaver/contracts";

const connectionSchema = z.object({
  host: z.string().min(1),
  provider: z.enum(["github", "gitea"]),
  apiBaseUrl: z.string().url(),
  tokenFile: z.string().optional(),
  repositoryIds: z.array(z.string().uuid()).min(1),
  repositories: z.array(z.string().min(1)).min(1),
}).strict();
export type TrustedForgeConnection = z.infer<typeof connectionSchema>;
export type ForgeRepositoryIdentity = { id: string; host: string; namespace: string; name: string; provider: string };
const sha = z.string().regex(/^[0-9a-f]{40,64}$/i);
const responseSchema = z.object({
  number: z.number().int().positive(), html_url: z.string().url(), state: z.enum(["open", "closed"]),
  merged: z.boolean(), merged_at: z.string().datetime({ offset: true }).nullable(), merge_commit_sha: sha.nullable(),
  head: z.object({ sha, ref: z.string().min(1) }),
  base: z.object({ sha, ref: z.string().min(1), repo: z.object({ full_name: z.string().min(1) }) }),
});

export function parseTrustedPullRequestUrl(repository: ForgeRepositoryIdentity, value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError("Invalid pull request URL"); }
  const provider = repository.provider === "github" || repository.host === "github.com" ? "github" : repository.provider;
  if (!["github", "gitea"].includes(provider)) throw new ValidationError("Human reconciliation supports GitHub and Gitea repositories");
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.host.toLowerCase() !== repository.host.toLowerCase()
    || parts.length !== 4 || parts[2] !== (provider === "github" ? "pull" : "pulls") || !/^[1-9][0-9]*$/.test(parts[3]!)
    || `${parts[0]}/${parts[1]}`.toLowerCase() !== `${repository.namespace}/${repository.name}`.toLowerCase()) {
    throw new ValidationError("Pull request URL must match the linked repository");
  }
  return { provider: provider as "github" | "gitea", externalId: parts[3]!, url: `https://${repository.host}/${repository.namespace}/${repository.name}/${provider === "github" ? "pull" : "pulls"}/${parts[3]}` };
}

async function configuredConnection(repository: ForgeRepositoryIdentity, provider: string): Promise<TrustedForgeConnection> {
  const { host } = repository;
  const path = process.env.TW_FORGE_CONNECTIONS_FILE;
  let connections: TrustedForgeConnection[];
  try { connections = path ? z.array(connectionSchema).max(50).parse(JSON.parse(await readFile(path, "utf8"))) : []; }
  catch { throw new ValidationError("Trusted server forge connection configuration could not be loaded"); }
  const connection = connections.find(entry => entry.host.toLowerCase() === host.toLowerCase() && entry.provider === provider);
  if (connection) return connection;
  if (host === "github.com" && provider === "github") return { host, provider, apiBaseUrl: "https://api.github.com", repositoryIds: [repository.id], repositories: [`${repository.namespace}/${repository.name}`] };
  throw new ValidationError("A trusted server forge connection is required for this host");
}

/** Only operator-configured API origins receive requests or server credentials. */
export async function readTrustedPullRequest(repository: ForgeRepositoryIdentity, pullRequestUrl: string, options: {
  connection?: TrustedForgeConnection; fetch?: typeof fetch;
} = {}) {
  const reference = parseTrustedPullRequestUrl(repository, pullRequestUrl);
  const connection = options.connection ?? await configuredConnection(repository, reference.provider);
  const base = new URL(connection.apiBaseUrl);
  if (connection.host.toLowerCase() !== repository.host.toLowerCase() || connection.provider !== reference.provider
    || base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new ValidationError("Invalid trusted forge connection");
  if (!connection.repositoryIds.includes(repository.id) || !connection.repositories.some(name => name.toLowerCase() === `${repository.namespace}/${repository.name}`.toLowerCase())) throw new ValidationError("This repository is outside the trusted server forge connection scope");
  let token: string | undefined;
  try { token = connection.tokenFile ? (await readFile(connection.tokenFile, "utf8")).trim() : undefined; }
  catch { throw new ValidationError("Trusted server forge credential could not be read"); }
  if (connection.tokenFile && !token) throw new ValidationError("Trusted server forge credential is empty");
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "Task-Weaver" };
  if (token) headers.authorization = `${reference.provider === "gitea" ? "token" : "Bearer"} ${token}`;
  const apiUrl = `${base.href.replace(/\/$/, "")}/repos/${encodeURIComponent(repository.namespace)}/${encodeURIComponent(repository.name)}/pulls/${reference.externalId}`;
  let response: Response;
  try { response = await (options.fetch ?? fetch)(apiUrl, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ValidationError("Trusted forge request failed; retry after checking server connectivity"); }
  if (!response.ok) throw new ValidationError(`Trusted forge could not read this pull request (HTTP ${response.status}); check its URL and server connection permissions`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new ValidationError("Trusted forge response exceeds the supported size");
  let row: z.infer<typeof responseSchema>;
  try { row = responseSchema.parse(JSON.parse(text)); } catch { throw new ValidationError("Trusted forge returned incomplete pull request evidence"); }
  if (String(row.number) !== reference.externalId || row.base.repo.full_name.toLowerCase() !== `${repository.namespace}/${repository.name}`.toLowerCase()
    || parseTrustedPullRequestUrl(repository, row.html_url).url !== reference.url) throw new ValidationError("Trusted forge pull request identity does not match the linked repository");
  if (row.merged && (!row.merged_at || !row.merge_commit_sha || row.state !== "closed")) throw new ValidationError("Trusted forge returned incomplete merge evidence");
  return { ...reference, state: row.merged ? "merged" as const : row.state, headCommit: row.head.sha, headBranch: row.head.ref,
    baseCommit: row.base.sha, baseBranch: row.base.ref, mergeCommit: row.merged ? row.merge_commit_sha : null,
    mergedAt: row.merged_at, observedAt: new Date(), source: apiUrl };
}
