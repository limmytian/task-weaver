import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [path, commit, repository] = process.argv.slice(2);
if (!path || !commit || !repository) throw new Error("Usage: node scripts/check-ce-candidate-run.mjs <run.json> <public-commit> <repository>");
const run = JSON.parse(readFileSync(path, "utf8"));
assert.equal(run.status, "completed");
assert.equal(run.conclusion, "success", "Candidate producer must have passed every gate");
assert.equal(run.event, "workflow_dispatch");
assert.equal(run.head_sha, commit, "Candidate producer is for a different public commit");
assert.equal(run.repository.full_name.toLowerCase(), repository.toLowerCase());
assert.equal(run.path.split("@")[0], ".github/workflows/ce-binary-candidate.yml", "Only the controlled candidate workflow may supply publication evidence");
console.log("Candidate producer identity and successful run verified.");
