import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

// Validate the compiler's complete expected output set, including wildcard exports
// and their internal imports. Merely finding dist/index.js is insufficient.
export function verifyCompiledOutputs(packageRoot) {
  const root = resolve(packageRoot);
  const require = createRequire(join(root, "package.json"));
  const ts = require("typescript");
  const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  if (!config || config.errors.length || config.options.noEmit || !config.options.outDir) {
    throw new Error(`Cannot determine compiled output contract: ${root}`);
  }
  const outputs = config.fileNames.flatMap(file => ts.getOutputFileNames(config, file, false));
  if (!outputs.length) throw new Error(`No compiled outputs expected: ${root}`);
  for (const file of outputs) {
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) {
      throw new Error(`Incomplete build output: ${file}. Rebuild before consuming or packaging dist.`);
    }
  }
  return outputs.length;
}
