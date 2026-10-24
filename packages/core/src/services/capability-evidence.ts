import { createHash } from "node:crypto";

type Evidence = Record<string, string | number | boolean>;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** A bounded reference allowlist; bodies, arguments, titles and reasoning never enter analytics. */
export function capabilityOperationEvidence(name: string, input: unknown, output: unknown): Evidence {
  const request = record(input), result = record(output);
  const discoveries: Record<string, string> = {
    listSkills: "skill", searchContext: "skill", tw_context_search: "skill",
    listPackages: "skill_package", tw_skill_packages_list: "skill_package",
    listMemories: "memory", searchMemories: "memory", tw_memories_search: "memory",
    searchTools: "mcp_tool", tw_mcp_search: "mcp_tool",
  };
  if (discoveries[name]) {
    const rows = Array.isArray(output) ? output : Array.isArray(result.items) ? result.items : undefined;
    return rows ? { capabilityEvidenceVersion: 1, evidenceSource: "api", capabilityKind: discoveries[name]!, capabilityAction: "discover", capabilityOutcome: rows.length ? "discovered" : "empty", resultCount: Math.min(rows.length, 20), countTruncated: rows.length > 20 } : {};
  }
  if (["addTaskComment", "addTaskNote"].includes(name)) return typeof result.id === "string" && uuid.test(result.id)
    ? { capabilityEvidenceVersion: 1, evidenceSource: "agent_report", reportId: result.id, capabilityAction: "report", capabilityOutcome: "reported" } : {};
  const kinds: Record<string, string> = {
    getSkill: "skill", tw_context_get: "skill", getMemory: "memory", tw_memories_get: "memory",
    recordMemory: "memory", tw_memories_record: "memory", getPackage: "skill_package", tw_skill_packages_get: "skill_package",
    readPackageTextFile: "skill_package", tw_skill_package_read: "skill_package",
    getToolDetail: "mcp_tool", tw_mcp_tool: "mcp_tool", callTool: "mcp_tool", tw_mcp_call: "mcp_tool",
    tw_skills_run: "skill_package", tw_skill_packages_resolve: "skill_package",
    listPackageFiles: "skill_package", tw_skill_package_files: "skill_package",
  };
  const kind = kinds[name];
  if (!kind) return {};
  const externalCall = name === "callTool" || name === "tw_mcp_call";
  const id = externalCall ? request.toolId : name === "tw_skills_run" ? request.packageId : result.id ?? result.reference?.id ?? result.packageId ?? result.packageVersion?.packageId ?? request.packageId ?? request.toolId;
  if (typeof id !== "string" || !uuid.test(id)) return {};
  const invocation = ["callTool", "tw_mcp_call", "tw_skills_run"].includes(name);
  const inspection = ["getPackage", "tw_skill_packages_get", "listPackageFiles", "tw_skill_package_files", "getToolDetail", "tw_mcp_tool"].includes(name);
  const action = invocation ? "invoke" : name === "recordMemory" || name === "tw_memories_record" ? "save" : name === "tw_skill_packages_resolve" ? "resolve" : inspection ? "inspect" : "read";
  const evidence: Evidence = { capabilityEvidenceVersion: 1, evidenceSource: "api", capabilityKind: kind, assetId: id, capabilityAction: action, capabilityOutcome: invocation ? "returned" : name === "recordMemory" || name === "tw_memories_record" ? "saved" : "read" };
  const version = result.packageVersion?.version ?? result.root?.version ?? (typeof result.version === "object" ? result.version?.version : result.version) ?? (name === "tw_skills_run" ? request.version : undefined);
  if (!externalCall && (typeof version === "string" || typeof version === "number") && String(version).length <= 100) evidence.assetVersion = String(version);
  const digest = externalCall ? request.expectedSchemaHash ?? request.schemaHash : name === "tw_skills_run" ? request.manifestHash : result.file?.sha256 ?? result.schemaHash ?? result.manifestHash ?? request.expectedSchemaHash ?? request.schemaHash;
  if (typeof digest === "string" && hash.test(digest)) {
    evidence.assetSha256 = digest;
    evidence.assetHashKind = kind === "mcp_tool" ? "tool_schema" : ["tw_skills_run", "tw_skill_packages_resolve"].includes(name) ? "manifest_graph" : "file";
  }
  if (kind === "skill" && typeof result.content === "string" && Buffer.byteLength(result.content) <= 32768) {
    evidence.assetSha256 = createHash("sha256").update(result.content).digest("hex");
    evidence.assetHashKind = "content";
  }
  if (kind === "memory" && ["current", "changed", "not_applicable"].includes(result.sourceFreshness)) evidence.sourceFreshness = result.sourceFreshness;
  if (name === "tw_skills_run" && ["succeeded", "failed"].includes(result.status)) evidence.executionStatus = result.status;
  if (result.isError === true) evidence.capabilityOutcome = "upstream_error";
  return evidence;
}
