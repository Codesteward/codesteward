import type { Finding, Severity } from "@codesteward/core";

/** SARIF 2.1.0 log (subset used by GitHub code scanning / VS Code). */
export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      version?: string;
      informationUri?: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
  invocations?: Array<{
    executionSuccessful: boolean;
    endTimeUtc?: string;
  }>;
}

export interface SarifRule {
  id: string;
  name?: string;
  shortDescription?: { text: string };
  fullDescription?: { text: string };
  defaultConfiguration?: { level: SarifLevel };
  properties?: { tags?: string[]; category?: string };
}

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId?: string };
      region?: {
        startLine?: number;
        endLine?: number;
        startColumn?: number;
        endColumn?: number;
      };
    };
  }>;
  fingerprints?: Record<string, string>;
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}

export type SarifLevel = "error" | "warning" | "note" | "none";

export interface SarifExportOptions {
  toolName?: string;
  toolVersion?: string;
  informationUri?: string;
  baseUri?: string;
}

function severityToLevel(s: Severity): SarifLevel {
  switch (s) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
    case "info":
      return "note";
    case "nit":
    default:
      return "note";
  }
}

function ruleIdFor(f: Finding): string {
  if (f.ruleIds?.[0]) return f.ruleIds[0];
  return `codesteward/${f.category}/${f.severity}`;
}

/**
 * Export findings to SARIF 2.1.0 for GitHub code scanning / IDE import.
 */
export function findingsToSarif(
  findings: Finding[],
  opts: SarifExportOptions = {},
): SarifLog {
  const ruleMap = new Map<string, SarifRule>();

  const results: SarifResult[] = findings.map((f) => {
    const ruleId = ruleIdFor(f);
    if (!ruleMap.has(ruleId)) {
      ruleMap.set(ruleId, {
        id: ruleId,
        name: f.category,
        shortDescription: { text: f.title },
        fullDescription: { text: f.body?.slice(0, 2000) || f.title },
        defaultConfiguration: { level: severityToLevel(f.severity) },
        properties: {
          tags: [f.category, f.severity, ...(f.tags ?? [])],
          category: f.category,
        },
      });
    }

    const uri = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
    return {
      ruleId,
      level: severityToLevel(f.severity),
      message: {
        text: f.body?.trim()
          ? `${f.title}\n\n${f.body}`
          : f.title,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri,
              ...(opts.baseUri ? { uriBaseId: "%SRCROOT%" } : {}),
            },
            region:
              f.startLine || f.endLine
                ? {
                    startLine: f.startLine,
                    endLine: f.endLine ?? f.startLine,
                  }
                : undefined,
          },
        },
      ],
      fingerprints: {
        codestewardFingerprint: f.fingerprint,
      },
      partialFingerprints: {
        primaryLocationLineHash: f.fingerprint.slice(0, 16),
      },
      properties: {
        severity: f.severity,
        confidence: f.confidence,
        category: f.category,
        sessionId: f.sessionId,
        findingId: f.id,
        status: f.status,
        agents: f.agents,
        suggestion: f.suggestion,
      },
    };
  });

  return {
    $schema:
      "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: opts.toolName ?? "CodeSteward Review",
            version: opts.toolVersion ?? "0.1.0",
            informationUri:
              opts.informationUri ?? "https://github.com/codesteward/codesteward",
            rules: [...ruleMap.values()],
          },
        },
        results,
        invocations: [
          {
            executionSuccessful: true,
            endTimeUtc: new Date().toISOString(),
          },
        ],
      },
    ],
  };
}

export function findingsToSarifJson(
  findings: Finding[],
  opts?: SarifExportOptions,
  pretty = true,
): string {
  const log = findingsToSarif(findings, opts);
  return pretty ? JSON.stringify(log, null, 2) : JSON.stringify(log);
}
