import { createHash } from "crypto";
import { createReadStream } from "fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { dirname, relative, resolve, sep } from "path";
import { Readable } from "stream";

export type SkillPackageStorageBody = Buffer | Uint8Array | string | Readable;

export interface SkillPackageStorageObjectMetadata {
  key: string;
  backend: string;
  sha256: string;
  sizeBytes: number;
  contentType?: string;
  updatedAt?: Date;
}

export interface PutSkillPackageStorageObjectInput {
  key: string;
  body: SkillPackageStorageBody;
  sha256?: string;
  contentType?: string;
}

export interface GetSkillPackageStorageObjectResult extends SkillPackageStorageObjectMetadata {
  body: Readable;
}

export interface SkillPackageStorageAdapter {
  readonly backend: string;
  putObject(input: PutSkillPackageStorageObjectInput): Promise<SkillPackageStorageObjectMetadata>;
  getObject(key: string): Promise<GetSkillPackageStorageObjectResult>;
  statObject(key: string): Promise<SkillPackageStorageObjectMetadata>;
  listObjects(prefix?: string): Promise<SkillPackageStorageObjectMetadata[]>;
  deleteObject(key: string): Promise<void>;
}

export interface LocalSkillPackageStorageOptions {
  maxObjectBytes?: number;
}

export class LocalSkillPackageStorageAdapter implements SkillPackageStorageAdapter {
  readonly backend = "local";

  private readonly rootDir: string;

  constructor(baseDir: string, private readonly options: LocalSkillPackageStorageOptions = {}) {
    this.rootDir = resolve(baseDir);
  }

  async putObject(input: PutSkillPackageStorageObjectInput): Promise<SkillPackageStorageObjectMetadata> {
    const body = await readStorageBody(input.body);
    if (this.options.maxObjectBytes !== undefined && body.byteLength > this.options.maxObjectBytes) {
      throw new Error(`Skill package object exceeds max size of ${this.options.maxObjectBytes} bytes`);
    }

    const sha256 = sha256Hex(body);
    if (input.sha256 && input.sha256 !== sha256) {
      throw new Error("Skill package object sha256 mismatch");
    }

    const filePath = this.resolveObjectPath(input.key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);

    return {
      key: normalizeObjectKey(input.key),
      backend: this.backend,
      sha256,
      sizeBytes: body.byteLength,
      contentType: input.contentType,
      updatedAt: new Date(),
    };
  }

  async getObject(key: string): Promise<GetSkillPackageStorageObjectResult> {
    const metadata = await this.statObject(key);
    return {
      ...metadata,
      body: createReadStream(this.resolveObjectPath(key)),
    };
  }

  async statObject(key: string): Promise<SkillPackageStorageObjectMetadata> {
    const filePath = this.resolveObjectPath(key);
    const [fileStat, body] = await Promise.all([stat(filePath), readFile(filePath)]);
    if (!fileStat.isFile()) {
      throw new Error(`Skill package storage key is not a file: ${key}`);
    }

    return {
      key: normalizeObjectKey(key),
      backend: this.backend,
      sha256: sha256Hex(body),
      sizeBytes: fileStat.size,
      updatedAt: fileStat.mtime,
    };
  }

  async listObjects(prefix = ""): Promise<SkillPackageStorageObjectMetadata[]> {
    const normalizedPrefix = prefix ? normalizeObjectKey(prefix) : "";
    const startPath = normalizedPrefix ? this.resolveObjectPath(normalizedPrefix) : this.rootDir;

    try {
      const startStat = await stat(startPath);
      if (startStat.isFile()) {
        return [await this.statObject(normalizedPrefix)];
      }
      if (!startStat.isDirectory()) {
        return [];
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    }

    const filePaths = await collectFiles(startPath);
    const objects = await Promise.all(filePaths.map((filePath) => this.statObject(toObjectKey(this.rootDir, filePath))));
    return objects.sort((a, b) => a.key.localeCompare(b.key));
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.resolveObjectPath(key), { force: true });
  }

  private resolveObjectPath(key: string): string {
    const normalizedKey = normalizeObjectKey(key);
    const resolvedPath = resolve(this.rootDir, normalizedKey);
    if (resolvedPath !== this.rootDir && !resolvedPath.startsWith(`${this.rootDir}${sep}`)) {
      throw new Error(`Skill package storage key escapes the storage root: ${key}`);
    }
    return resolvedPath;
  }
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeObjectKey(key: string): string {
  const normalizedSeparators = key.replace(/\\/g, "/");
  if (normalizedSeparators.startsWith("/") || normalizedSeparators.includes("\0")) {
    throw new Error(`Invalid skill package storage key: ${key}`);
  }

  const parts = normalizedSeparators.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid skill package storage key: ${key}`);
  }
  return parts.join("/");
}

async function readStorageBody(body: SkillPackageStorageBody): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }
    if (entry.isFile()) {
      return [entryPath];
    }
    return [];
  }));
  return nested.flat();
}

function toObjectKey(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
