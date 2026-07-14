import type { Policy } from "./types.js";

export const DEFAULT_POLICY: Policy = {
  severityFloor: "low",
  nitCap: 5,
  maxFindings: 50,
  skipGlobs: [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.lock",
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/vendor/**",
    "**/.git/**",
  ],
  includeGlobs: ["**/*"],
  verificationBar: "full",
  requireGraph: false,
  blockSeverities: ["critical", "high"],
  gateMode: "enforce",
  requireGraphForThorough: true,
  focus: [],
  ignoreRules: [],
  customSections: {},
  pathRules: [],
  source: "default",
};
