import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { scanSecrets } from "./release-gates.mjs";

const privateDirectories = new Set([".git", ".ssh", ".kube", ".config", ".task-weaver", ".codex", ".agents", "backups"]);
const placeholderUsers = new Set(["example", "me", "user", "username", "runner", "node"]);

/** Findings contain locations and categories, never matched private values. */
export function inspectPublicArtifactTree(root) {
  const findings = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        findings.push({ path, rule: "nonregular-artifact-entry" });
      } else if (stat.isDirectory()) {
        if (privateDirectories.has(entry.name)) findings.push({ path, rule: "private-state-directory" });
        else visit(absolute);
      } else if ((entry.name.startsWith(".env") && entry.name !== ".env.example")
        || /(?:^id_(?:rsa|ed25519|ecdsa)$|\.(?:dump|pem|key|kubeconfig)$|\.sql\.gz$)/i.test(entry.name)) {
        findings.push({ path, rule: "private-state-file" });
      } else {
        const bytes = readFileSync(absolute);
        if (bytes.includes(0)) continue;
        const lines = bytes.toString("utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
          const homes = [...line.matchAll(/(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)([^\s/\\"'<>]+)[\\/]+/g)];
          if (homes.some(match => !placeholderUsers.has(match[1]))) findings.push({ path, line: index + 1, rule: "operator-home-path" });
        });
      }
    }
  };
  visit(root);
  // Do not traverse private directories again: they are already rejected above.
  if (!findings.some(item => item.rule === "private-state-directory" || item.rule === "nonregular-artifact-entry")) {
    findings.push(...scanSecrets(root, { secretPolicy: { reviewedExceptions: [] } }, { includeGenerated: true }));
  }
  return findings;
}

export function assertPublicArtifactTree(root) {
  const findings = inspectPublicArtifactTree(root);
  if (findings.length) throw new Error(`Public artifact privacy check failed without printing matched values:\n${findings.map(item => `${item.path}${item.line ? `:${item.line}` : ""} (${item.rule})`).join("\n")}`);
}
