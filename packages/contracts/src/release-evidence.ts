import type { DaemonSloReport } from "./daemon-slo";

export interface DaemonRealSmokeEvidence {
  runId: string;
  commitSha: string;
  completedAt: string;
  providers: string[];
  requirementIds: string[];
  repositoryKeys: string[];
  approvals: number;
  deliveries: number;
  durationMs: number;
  cleanedUp: boolean;
}

export interface DaemonReleaseGateInput {
  commitSha: string;
  generatedAt?: string;
  deterministicGate: {
    passed: boolean;
    command: string;
    workflowRunUrl?: string | null;
  };
  realSmoke: DaemonRealSmokeEvidence;
  slo: DaemonSloReport;
}

export interface DaemonReleaseInvariant {
  id: string;
  title: string;
  source: "deterministic" | "real_smoke" | "slo";
  passed: boolean;
  evidence: string;
}

export interface DaemonReleaseEvidence {
  schemaVersion: 1;
  commitSha: string;
  generatedAt: string;
  decision: "ready" | "blocked";
  evidenceDigest: string;
  deterministicGate: DaemonReleaseGateInput["deterministicGate"];
  realSmoke: DaemonRealSmokeEvidence;
  slo: DaemonSloReport;
  invariants: DaemonReleaseInvariant[];
  blockers: string[];
}
