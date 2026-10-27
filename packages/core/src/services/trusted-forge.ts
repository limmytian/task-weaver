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

type ForgeReadOptions = { connection?: TrustedForgeConnection; fetch?: typeof fetch };

/** Only operator-configured API origins receive requests or server credentials. */
async function trustedForgeRequest(repository: ForgeRepositoryIdentity, provider: "github" | "gitea", path: string, options: ForgeReadOptions) {
  const connection = options.connection ?? await configuredConnection(repository, provider);
  const base = new URL(connection.apiBaseUrl);
  if (connection.host.toLowerCase() !== repository.host.toLowerCase() || connection.provider !== provider
    || base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new ValidationError("Invalid trusted forge connection");
  if (!connection.repositoryIds.includes(repository.id) || !connection.repositories.some(name => name.toLowerCase() === `${repository.namespace}/${repository.name}`.toLowerCase())) throw new ValidationError("This repository is outside the trusted server forge connection scope");
  let token: string | undefined;
  try { token = connection.tokenFile ? (await readFile(connection.tokenFile, "utf8")).trim() : undefined; }
  catch { throw new ValidationError("Trusted server forge credential could not be read"); }
  if (connection.tokenFile && !token) throw new ValidationError("Trusted server forge credential is empty");
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "Task-Weaver" };
  if (token) headers.authorization = `${provider === "gitea" ? "token" : "Bearer"} ${token}`;
  const apiUrl = `${base.href.replace(/\/$/, "")}/repos/${encodeURIComponent(repository.namespace)}/${encodeURIComponent(repository.name)}/${path}`;
  let response: Response;
  try { response = await (options.fetch ?? fetch)(apiUrl, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ValidationError("Trusted forge request failed; retry after checking server connectivity"); }
  if (!response.ok) throw new ValidationError(`Trusted forge could not read delivery evidence (HTTP ${response.status}); check the server connection permissions`);
  const limit = 2_000_000;
  const advertised = response.headers.get("content-length");
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > limit) { await response.body?.cancel(); throw new ValidationError("Trusted forge response exceeds the supported size"); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) { await reader.cancel(); throw new ValidationError("Trusted forge response exceeds the supported size"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  const text = Buffer.concat(chunks, size).toString("utf8");
  try { return { data: JSON.parse(text) as unknown, source: apiUrl }; }
  catch { throw new ValidationError("Trusted forge returned invalid JSON evidence"); }
}

export async function readTrustedPullRequest(repository: ForgeRepositoryIdentity, pullRequestUrl: string, options: ForgeReadOptions = {}) {
  const reference = parseTrustedPullRequestUrl(repository, pullRequestUrl);
  const { data, source: apiUrl } = await trustedForgeRequest(repository, reference.provider, `pulls/${reference.externalId}`, options);
  let row: z.infer<typeof responseSchema>;
  try { row = responseSchema.parse(data); } catch { throw new ValidationError("Trusted forge returned incomplete pull request evidence"); }
  if (String(row.number) !== reference.externalId || row.base.repo.full_name.toLowerCase() !== `${repository.namespace}/${repository.name}`.toLowerCase()
    || parseTrustedPullRequestUrl(repository, row.html_url).url !== reference.url) throw new ValidationError("Trusted forge pull request identity does not match the linked repository");
  if (row.merged && (!row.merged_at || !row.merge_commit_sha || row.state !== "closed")) throw new ValidationError("Trusted forge returned incomplete merge evidence");
  return { ...reference, state: row.merged ? "merged" as const : row.state, headCommit: row.head.sha, headBranch: row.head.ref,
    baseCommit: row.base.sha, baseBranch: row.base.ref, mergeCommit: row.merged ? row.merge_commit_sha : null,
    mergedAt: row.merged_at, observedAt: new Date(), source: apiUrl };
}

/** Verify a direct integration against the server-observed target branch. */
export async function readTrustedDirectMerge(repository: ForgeRepositoryIdentity, baseBranch: string, commit: string, options: ForgeReadOptions = {}) {
  const provider = repository.provider === "github" || repository.host === "github.com" ? "github" : repository.provider;
  if (provider !== "github" && provider !== "gitea") throw new ValidationError("Direct integration verification supports GitHub and Gitea repositories");
  const deliveredCommit = sha.parse(commit).toLowerCase();
  const branchResult = await trustedForgeRequest(repository, provider, `branches/${encodeURIComponent(baseBranch)}`, options);
  const branch = z.object({ name: z.string(), commit: z.object({ sha }) }).safeParse(branchResult.data);
  if (!branch.success || branch.data.name !== baseBranch) throw new ValidationError("Trusted forge returned incomplete target branch evidence");
  const targetCommit = branch.data.commit.sha.toLowerCase();
  let source = branchResult.source;
  if (targetCommit !== deliveredCommit && provider === "github") {
    const comparison = await trustedForgeRequest(repository, provider, `compare/${deliveredCommit}...${targetCommit}`, options);
    const row = z.object({ status: z.enum(["ahead", "behind", "diverged", "identical"]), base_commit: z.object({ sha }), merge_base_commit: z.object({ sha }) }).safeParse(comparison.data);
    if (!row.success || !["ahead", "identical"].includes(row.data.status) || row.data.base_commit.sha.toLowerCase() !== deliveredCommit || row.data.merge_base_commit.sha.toLowerCase() !== deliveredCommit) throw new ValidationError("The delivered commit is not contained in the target branch");
    source = comparison.source;
  } else if (targetCommit !== deliveredCommit) {
    // Older Gitea comparisons omit ancestry metadata; verify parent objects instead.
    const pending = [targetCommit]; const seen = new Set<string>(); let found = false;
    const deadline = Date.now() + 20_000;
    while (pending.length && seen.size < 128 && Date.now() < deadline) {
      const next = pending.shift()!;
      if (next === deliveredCommit) { found = true; break; }
      if (seen.has(next)) continue;
      seen.add(next);
      const result = await trustedForgeRequest(repository, provider, `git/commits/${next}`, options);
      const row = z.object({ sha, parents: z.array(z.object({ sha })).max(100) }).safeParse(result.data);
      if (!row.success || row.data.sha.toLowerCase() !== next) throw new ValidationError("Trusted forge returned incomplete commit ancestry evidence");
      for (const parent of row.data.parents) {
        const value = parent.sha.toLowerCase();
        if (value === deliveredCommit) { found = true; break; }
        if (!seen.has(value)) pending.push(value);
      }
      if (found) break;
    }
    if (!found) throw new ValidationError("The delivered commit could not be verified within the target branch ancestry limit");
  }
  return { provider, headCommit: deliveredCommit, targetCommit, baseBranch, source, observedAt: new Date() };
}
