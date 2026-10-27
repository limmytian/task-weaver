import { createHash, randomUUID } from "crypto";
import { constants, createReadStream, createWriteStream } from "fs";
import { mkdir, readdir, rm, stat, rename, realpath, lstat, open, mkdtemp, unlink } from "fs/promises";
import { tmpdir } from "os";
import { dirname, relative, resolve, sep } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

export type StorageBody = Buffer | Uint8Array | string | Readable;

export interface StorageObjectMetadata {
  key: string;
  backend: string;
  sha256: string;
  sizeBytes: number;
  contentType?: string;
  updatedAt?: Date;
}

export interface PutStorageObjectInput {
  key: string;
  body: StorageBody;
  sha256?: string;
  contentType?: string;
}

export interface GetStorageObjectResult extends StorageObjectMetadata {
  body: Readable;
}

export interface StorageAdapter {
  readonly backend: string;
  putObject(input: PutStorageObjectInput): Promise<StorageObjectMetadata>;
  getObject(key: string): Promise<GetStorageObjectResult>;
  statObject(key: string): Promise<StorageObjectMetadata>;
  listObjects(prefix?: string): Promise<StorageObjectMetadata[]>;
  deleteObject(key: string): Promise<void>;
}

export interface LocalStorageOptions {
  maxObjectBytes?: number;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly backend = "local";

  private readonly rootDir: string;

  constructor(baseDir: string, private readonly options: LocalStorageOptions = {}) {
    this.rootDir = resolve(baseDir);
  }

  async putObject(input: PutStorageObjectInput): Promise<StorageObjectMetadata> {
    const filePath = this.resolveObjectPath(input.key);
    await this.ensureSafeParent(filePath);
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const source = input.body instanceof Readable ? input.body : Readable.from([input.body]);
    const meter = new Transform({ transform: (chunk, _encoding, callback) => {
      sizeBytes += chunk.length;
      if (this.options.maxObjectBytes !== undefined && sizeBytes > this.options.maxObjectBytes) {
        callback(new Error(`Storage object exceeds max size of ${this.options.maxObjectBytes} bytes`)); return;
      }
      hash.update(chunk); callback(null, chunk);
    } });
    let sha256: string;
    try {
      await pipeline(source, meter, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
      sha256 = hash.digest("hex");
      if (input.sha256 && input.sha256 !== sha256) throw new Error("Storage object sha256 mismatch");
      await rename(tempPath, filePath);
    } catch (error) { await rm(tempPath, { force: true }); throw error; }

    return {
      key: normalizeObjectKey(input.key),
      backend: this.backend,
      sha256,
      sizeBytes,
      contentType: input.contentType,
      updatedAt: new Date(),
    };
  }

  async getObject(key: string): Promise<GetStorageObjectResult> {
    const metadata = await this.statObject(key);
    return {
      ...metadata,
      body: createReadStream(this.resolveObjectPath(key)),
    };
  }

  /** Verify a private snapshot before serving immutable attachment evidence. */
  async getVerifiedObject(key: string, expected: { sha256: string; sizeBytes: number }): Promise<GetStorageObjectResult> {
    const filePath = this.resolveObjectPath(key);
    await this.ensureSafeParent(filePath);
    if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 0) throw new Error("Storage object exceeds verification limit");
    const source = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let directory: string | undefined;
    try {
      const sourceStat = await source.stat();
      if (!sourceStat.isFile() || sourceStat.size !== expected.sizeBytes) throw new Error("Attachment storage integrity check failed");
      directory = await mkdtemp(resolve(tmpdir(), "tw-storage-"));
      const snapshot = resolve(directory, "snapshot");
      const hash = createHash("sha256"); let sizeBytes = 0;
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        sizeBytes += chunk.length;
        if (sizeBytes > expected.sizeBytes) { callback(new Error("Attachment storage integrity check failed")); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(source.createReadStream({ autoClose: false }), meter, createWriteStream(snapshot, { flags: "wx", mode: 0o600 }));
      if (sizeBytes !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) throw new Error("Attachment storage integrity check failed");
      const pinned = await open(snapshot, constants.O_RDONLY | constants.O_NOFOLLOW);
      // Unix can remove the path while retaining the verified descriptor.
      try { if (process.platform !== "win32") await unlink(snapshot); }
      catch (error) { await pinned.close(); throw error; }
      const body = pinned.createReadStream({ autoClose: true });
      const cleanup = directory; directory = undefined;
      body.once("close", () => { void rm(cleanup, { recursive: true, force: true }).catch(() => {}); });
      return { key: normalizeObjectKey(key), backend: this.backend, sha256: expected.sha256, sizeBytes, updatedAt: sourceStat.mtime, body };
    } finally {
      await source.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async statObject(key: string): Promise<StorageObjectMetadata> {
    const filePath = this.resolveObjectPath(key);
    await this.ensureSafeParent(filePath);
    const fileStat = await lstat(filePath);
    const hash = createHash("sha256");
    if (!fileStat.isFile()) throw new Error(`Storage key is not a regular file: ${key}`);
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    if (!fileStat.isFile()) {
      throw new Error(`Storage key is not a file: ${key}`);
    }

    return {
      key: normalizeObjectKey(key),
      backend: this.backend,
      sha256: hash.digest("hex"),
      sizeBytes: fileStat.size,
      updatedAt: fileStat.mtime,
    };
  }

  async listObjects(prefix = ""): Promise<StorageObjectMetadata[]> {
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
    const path = this.resolveObjectPath(key);
    await this.ensureSafeParent(path);
    await rm(path, { force: true });
  }

  private async ensureSafeParent(filePath: string) {
    await mkdir(this.rootDir, { recursive: true });
    const root = await realpath(this.rootDir);
    let parent = this.rootDir;
    for (const component of relative(this.rootDir, dirname(filePath)).split(sep).filter(Boolean)) {
      parent = resolve(parent, component);
      await mkdir(parent).catch(error => { if (error.code !== "EEXIST") throw error; });
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("Storage paths cannot contain symbolic links");
    }
    const actual = await realpath(dirname(filePath));
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("Storage path escapes root");
  }

  private resolveObjectPath(key: string): string {
    const normalizedKey = normalizeObjectKey(key);
    const resolvedPath = resolve(this.rootDir, normalizedKey);
    if (resolvedPath !== this.rootDir && !resolvedPath.startsWith(`${this.rootDir}${sep}`)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
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
    throw new Error(`Invalid storage key: ${key}`);
  }

  const parts = normalizedSeparators.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return parts.join("/");
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }
    if (entry.isFile() && !/\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
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
