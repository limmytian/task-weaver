import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.env.TW_RELEASE_VERSION;
const namespace = process.env.TW_NAMESPACE ?? "task-weaver";
const apiImage = process.env.TW_API_IMAGE;
const webImage = process.env.TW_WEB_IMAGE;
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("TW_RELEASE_VERSION must be a semantic version.");
}
if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace) || namespace.length > 63) {
  throw new Error("TW_NAMESPACE must be a Kubernetes DNS label.");
}
for (const [name, image] of [["TW_API_IMAGE", apiImage], ["TW_WEB_IMAGE", webImage]]) {
  if (!image || !/^[a-z0-9][a-z0-9./_:-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error(`${name} must be an immutable OCI digest reference.`);
  }
}
const releaseName = `v${version.replace(/[^a-z0-9]/g, "-")}`;
const replacements = {
  TW_NAMESPACE: namespace,
  TW_API_IMAGE: apiImage,
  TW_WEB_IMAGE: webImage,
  TW_RELEASE_NAME: releaseName,
};
const output = resolve("release-artifacts/kubernetes");
mkdirSync(output, { recursive: true });
for (const name of ["base", "migration", "apps"]) {
  const template = readFileSync(resolve(`deploy/kubernetes/${name}.yaml.in`), "utf8");
  const rendered = template.replace(/\$\{([A-Z_]+)\}/g, (_match, key) => {
    if (!(key in replacements)) throw new Error(`Unknown Kubernetes template field: ${key}`);
    return replacements[key];
  });
  writeFileSync(resolve(output, `${name}.yaml`), rendered);
}
console.log(output);
