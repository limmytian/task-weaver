import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  type Database,
  skillPackages,
  skillPackageVersions,
} from "@task-weaver/db";
import type { Actor } from "../schemas/common";
import type { RegisterSkillPackageInput } from "../schemas/skill-packages";
import { registerPackage, updatePackageMetadata, updatePackageVersionStatus } from "./skill-packages";
import type { SkillPackageStorageAdapter } from "./skill-package-storage";
import { sha256Hex } from "./skill-package-storage";

/** Marker used to distinguish Git-managed presets from user-created global skills. */
export const GIT_MANAGED_PRESET_MARKER = "task-weaver-git-presets";
export const DEFAULT_PRESET_SKILLS_DIR = "skills";
export const PRESET_SYNC_ACTOR: Actor = {
  id: "system:skill-presets",
  type: "agent",
};
const SERVICE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export interface DiscoveredSkillPackage {
  directoryName: string;
  sourcePath: string;
  name: string;
  description?: string;
  summary?: string;
  keywords?: string[];
  tags?: string[];
  files: Array<{
    path: string;
    content: Buffer;
    contentType: string;
    isReadableText: boolean;
    isExecutable: boolean;
  }>;
  contentHash: string;
  version: string;
}

export interface PresetSkillSyncResult {
  sourceDirectory: string;
  discovered: number;
  imported: number;
  unchanged: number;
  archived: number;
  packageNames: string[];
}

/** Resolve the source directory copied from the Git checkout into the API image. */
export function resolvePresetSkillsDirectory(sourceDirectory = process.env.TW_PRESET_SKILLS_DIR) {
  // Resolve from the API/core package location so `pnpm --filter ... dev`, whose
  // working directory is apps/api, still finds the monorepo's Git checkout.
  const packageDefault = resolve(SERVICE_DIRECTORY, "../../../../", DEFAULT_PRESET_SKILLS_DIR);
  return resolve(sourceDirectory || packageDefault);
}

/**
 * Discover immediate skill package directories under a Git-managed skills root.
 * A package is a directory containing SKILL.md; all regular files below it are
 * shipped so package references and examples remain available to agents.
 */
export async function discoverGitManagedSkillPackages(
  sourceDirectory = resolvePresetSkillsDirectory(),
): Promise<DiscoveredSkillPackage[]> {
  const root = resolve(sourceDirectory);
  const rootStat = await stat(root).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!rootStat) throw new Error(`Preset skills directory does not exist: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Preset skills path is not a directory: ${root}`);

  const entries = await readdir(root, { withFileTypes: true });
  const packages: DiscoveredSkillPackage[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const packageDirectory = resolve(root, entry.name);
    const entryPath = resolve(packageDirectory, "SKILL.md");
    const entryStat = await stat(entryPath).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (!entryStat) continue;
    if (!entryStat.isFile()) throw new Error(`Skill package entry is not a file: ${entryPath}`);

    const filePaths = await collectPackageFiles(packageDirectory);
    const files = await Promise.all(filePaths.map(async (filePath) => {
      const content = await readFile(filePath);
      const path = relative(packageDirectory, filePath).split(sep).join("/");
      const isReadableText = isProbablyReadableText(path, content);
      return {
        path,
        content,
        contentType: inferContentType(path, isReadableText),
        isReadableText,
        isExecutable: false,
      };
    }));
    files.sort((a, b) => a.path.localeCompare(b.path));

    const entryContent = files.find((file) => file.path === "SKILL.md")?.content;
    if (!entryContent) throw new Error(`Skill package is missing SKILL.md: ${packageDirectory}`);
    const { meta } = parseFrontmatter(entryContent.toString("utf8"));
    const contentHash = hashPackageFiles(files);
    packages.push({
      directoryName: entry.name,
      sourcePath: relative(root, packageDirectory).split(sep).join("/"),
      name: stringMeta(meta.name) || entry.name,
      description: stringMeta(meta.description),
      summary: stringMeta(meta.summary),
      keywords: stringArrayMeta(meta.keywords),
      tags: stringArrayMeta(meta.tags),
      files,
      contentHash,
      version: `git-${contentHash.slice(0, 24)}`,
    });
  }
  return packages;
}

/**
 * Synchronize Git-managed global skill packages. The operation is safe to run
 * on every API start: content hashes make unchanged packages no-ops, updates
 * create a new immutable version, and removed presets are archived. An
 * advisory transaction lock prevents two API replicas from importing at once.
 */
export async function syncGitManagedSkillPackages(
  db: Database,
  storage: SkillPackageStorageAdapter,
  options: {
    sourceDirectory?: string;
    actor?: Actor;
  } = {},
): Promise<PresetSkillSyncResult> {
  const sourceDirectory = resolvePresetSkillsDirectory(options.sourceDirectory);
  const actor = options.actor ?? PRESET_SYNC_ACTOR;
  const discovered = await discoverGitManagedSkillPackages(sourceDirectory);

  return db.transaction(async (transaction) => {
    const lockedDb = transaction as unknown as Database;
    await lockedDb.execute(
      // hashtextextended gives a stable 64-bit advisory-lock key without adding a table.
      // The transaction-scoped lock is released automatically on commit/rollback.
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${GIT_MANAGED_PRESET_MARKER}, 0))`,
    );

    const existingPackages = await lockedDb.query.skillPackages.findMany({
      where: and(isNull(skillPackages.projectId), isNull(skillPackages.personalOwnerId)),
      with: {
        versions: {
          orderBy: (version, { desc }) => [desc(version.createdAt)],
        },
      },
    });
    const existingByName = new Map(existingPackages.map((pkg) => [pkg.name.toLowerCase(), pkg]));
    const desiredNames = new Set(discovered.map((pkg) => pkg.name.toLowerCase()));

    let imported = 0;
    let unchanged = 0;
    for (const preset of discovered) {
      const existing = existingByName.get(preset.name.toLowerCase());
      if (existing && existing.manifest?.managedBy !== GIT_MANAGED_PRESET_MARKER) {
        throw new Error(
          `Preset skill name collides with an unmanaged global package: ${preset.name}`,
        );
      }

      const matchingVersion = existing?.versions.find((version) => (
        version.manifest?.managedBy === GIT_MANAGED_PRESET_MARKER
        && version.manifest?.sourceHash === preset.contentHash
      ));
      const input = toRegisterInput(preset);
      let packageId = existing?.id;
      let activeVersionId = matchingVersion?.id;
      if (matchingVersion && existing) {
        unchanged += 1;
        packageId = existing.id;
        if (existing.status !== "active") {
          await updatePackageMetadata(lockedDb, {
            packageId: existing.id,
            status: "active",
          }, actor);
        }
        if (matchingVersion.status !== "active") {
          await updatePackageVersionStatus(lockedDb, {
            packageId: existing.id,
            version: matchingVersion.version,
            status: "active",
          }, actor);
        }
      } else {
        const registered = await registerPackage(lockedDb, input, actor, storage);
        imported += 1;
        packageId = registered.id;
        activeVersionId = registered.versions.find((version) => version.version === preset.version)?.id;
      }

      await deprecateOtherVersions(lockedDb, packageId!, activeVersionId);
    }

    let archived = 0;
    for (const existing of existingPackages) {
      if (existing.manifest?.managedBy !== GIT_MANAGED_PRESET_MARKER) continue;
      if (desiredNames.has(existing.name.toLowerCase())) continue;
      if (existing.status !== "archived") {
        await updatePackageMetadata(lockedDb, {
          packageId: existing.id,
          status: "archived",
        }, actor);
        archived += 1;
      }
      await lockedDb
        .update(skillPackageVersions)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(skillPackageVersions.packageId, existing.id), ne(skillPackageVersions.status, "archived")));
    }

    return {
      sourceDirectory,
      discovered: discovered.length,
      imported,
      unchanged,
      archived,
      packageNames: discovered.map((preset) => preset.name),
    };
  });
}

function toRegisterInput(preset: DiscoveredSkillPackage): RegisterSkillPackageInput {
  return {
    name: preset.name,
    description: preset.description,
    version: preset.version,
    sourceType: "seed",
    entryPath: "SKILL.md",
    manifest: {
      managedBy: GIT_MANAGED_PRESET_MARKER,
      sourcePath: preset.sourcePath,
      sourceHash: preset.contentHash,
    },
    summary: preset.summary,
    keywords: preset.keywords,
    tags: [...(preset.tags ?? []), "preset", "global"],
    storageBackend: "local",
    files: preset.files.map((file) => ({
      path: file.path,
      contentBase64: file.content.toString("base64"),
      contentType: file.contentType,
      isReadableText: file.isReadableText,
      isExecutable: file.isExecutable,
      metadata: {},
    })),
  };
}

async function deprecateOtherVersions(db: Database, packageId: string, activeVersionId?: string) {
  const conditions = [
    eq(skillPackageVersions.packageId, packageId),
    eq(skillPackageVersions.status, "active"),
  ];
  if (activeVersionId) conditions.push(ne(skillPackageVersions.id, activeVersionId));
  await db.update(skillPackageVersions)
    .set({ status: "deprecated", updatedAt: new Date() })
    .where(and(...conditions));
}

async function collectPackageFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectPackageFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function hashPackageFiles(files: Array<{ path: string; content: Buffer }>) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(sha256Hex(file.content));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw };

  const meta: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    meta[key] = parseFrontmatterValue(line.slice(separator + 1).trim());
  }
  return { meta, content: match[2]! };
}

function parseFrontmatterValue(value: string): unknown {
  if (!value) return "";
  if (value.startsWith("[") || value.startsWith("{") || value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return value.replace(/^['"]|['"]$/g, ""); }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value.replace(/^['"]|['"]$/g, "");
}

function stringMeta(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayMeta(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return result.length > 0 ? result : undefined;
}

function isProbablyReadableText(path: string, content: Buffer) {
  const extension = path.toLowerCase().split(".").pop();
  if (extension && new Set(["md", "mdx", "txt", "json", "yaml", "yml", "toml", "ts", "tsx", "js", "jsx", "css", "html", "sh", "py", "rb", "go", "rs"]).has(extension)) {
    return true;
  }
  return !content.includes(0) && !content.subarray(0, 4096).toString("utf8").includes("\uFFFD");
}

function inferContentType(path: string, readable: boolean) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  return readable ? "text/plain" : "application/octet-stream";
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
