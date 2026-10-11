import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const destination = resolve(dirname(fileURLToPath(import.meta.url)), "../public/pdfjs");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const asset of ["build/pdf.worker.min.mjs", "cmaps", "standard_fonts", "wasm"]) {
  await cp(resolve(packageRoot, asset), resolve(destination, asset.replace("build/", "")), { recursive: true });
}
