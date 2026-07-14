import { unitId, type ReviewMode, type ReviewUnit, type RiskTier } from "@codesteward/core";

export interface PlanInput {
  sessionId: string;
  mode: ReviewMode;
  paths: string[];
  riskTier: RiskTier;
  /** Max files per unit (stewardship batching). */
  batchSize?: number;
}

/**
 * ReviewUnit planner.
 * - Gate: batch changed files.
 * - Stewardship: batch by package/path prefix.
 */
export function planReviewUnits(input: PlanInput): ReviewUnit[] {
  const batchSize = input.batchSize ?? (input.mode === "gate" ? 12 : 20);
  const paths = input.paths.length ? input.paths : ["."];

  if (input.mode === "gate") {
    return chunk(paths, batchSize).map((group, i) => ({
      id: unitId(),
      sessionId: input.sessionId,
      kind: "file_batch" as const,
      label: `gate-batch-${i + 1}`,
      paths: group,
      symbols: [],
      status: "pending" as const,
      assignedRoles: rolesForTier(input.riskTier),
      metadata: {},
    }));
  }

  // Stewardship: group by top-level package/path
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = packageKey(p);
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  const units: ReviewUnit[] = [];
  for (const [key, groupPaths] of groups) {
    for (const [i, group] of chunk(groupPaths, batchSize).entries()) {
      units.push({
        id: unitId(),
        sessionId: input.sessionId,
        kind: key.includes("package") ? "package" : "path",
        label: `${key}${groupPaths.length > batchSize ? `-${i + 1}` : ""}`,
        paths: group,
        symbols: [],
        status: "pending",
        assignedRoles: rolesForTier(input.riskTier),
        metadata: {},
      });
    }
  }
  return units;
}

export function rolesForTier(tier: RiskTier): string[] {
  switch (tier) {
    case "trivial":
      return ["generalist"];
    case "lite":
      return ["generalist", "rules"];
    case "security":
      return ["correctness", "security", "rules", "testing"];
    case "thorough":
      return [
        "correctness",
        "security",
        "performance",
        "testing",
        "rules",
        "requirements",
        "discourse",
      ];
    case "full":
    default:
      return ["correctness", "security", "rules", "testing"];
  }
}

function packageKey(path: string): string {
  const norm = path.replace(/\\/g, "/");
  if (norm.startsWith("packages/")) {
    const parts = norm.split("/");
    return parts.slice(0, 2).join("/");
  }
  if (norm.startsWith("services/")) {
    const parts = norm.split("/");
    return parts.slice(0, 2).join("/");
  }
  const first = norm.split("/")[0] ?? ".";
  return first === "." ? "root" : first;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length ? out : [[]];
}
