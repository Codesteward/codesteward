import type { Severity } from "@codesteward/core";
import { DEFAULT_POLICY } from "./defaults.js";
import type { Policy } from "./types.js";

/**
 * Parse STEWARD.md markdown into a policy object.
 * Recognizes ## sections: Severity, Noise, Skip, Verification, Focus, Ignore, etc.
 */
export function parseStewardMd(markdown: string): Policy {
  const policy: Policy = {
    ...DEFAULT_POLICY,
    skipGlobs: [...DEFAULT_POLICY.skipGlobs],
    includeGlobs: [...DEFAULT_POLICY.includeGlobs],
    focus: [],
    ignoreRules: [],
    customSections: {},
    pathRules: [],
    rawStewardMd: markdown,
    source: "steward.md",
  };

  const sections = splitSections(markdown);
  for (const [title, body] of Object.entries(sections)) {
    const key = title.toLowerCase().trim();
    if (key.includes("severity") || key === "threshold") {
      const plain = body.replace(/\*+/g, "");
      const floor = matchSeverity(plain);
      if (floor) policy.severityFloor = floor;
      const max = plain.match(/max(?:\s+findings)?[:\s]+(\d+)/i);
      if (max) policy.maxFindings = Number(max[1]);
    } else if (key.includes("noise") || key.includes("nit")) {
      const plain = body.replace(/\*+/g, "");
      const cap = plain.match(/(?:nit\s*)?cap[:\s]+(\d+)/i) ?? plain.match(/(\d+)\s*nits?/i);
      if (cap) policy.nitCap = Number(cap[1]);
    } else if (key.includes("skip") || key.includes("ignore path") || key.includes("exclude")) {
      policy.skipGlobs = [...policy.skipGlobs, ...extractListItems(body)];
    } else if (key.includes("include") || key.includes("paths")) {
      const items = extractListItems(body);
      if (items.length) policy.includeGlobs = items;
    } else if (key.includes("verif") || key.includes("bar")) {
      if (/off|none/i.test(body)) policy.verificationBar = "off";
      else if (/sample|partial/i.test(body)) policy.verificationBar = "sample";
      else if (/full|strict/i.test(body)) policy.verificationBar = "full";
    } else if (key.includes("focus") || key.includes("priorit")) {
      policy.focus = extractListItems(body);
    } else if (key.includes("ignore rule") || key === "ignore") {
      policy.ignoreRules = extractListItems(body);
    } else if (key.includes("prove")) {
      const sev = matchSeverity(body);
      if (sev) policy.proveOnSeverity = sev;
    } else if (key.includes("graph")) {
      policy.requireGraph = /require|must|true|yes/i.test(body);
    } else if (key.includes("gate") || key.includes("merge") || key.includes("block")) {
      const plain = body.replace(/\*+/g, "");
      if (/advisor/i.test(plain)) policy.gateMode = "advisory";
      if (/enforc|strict|block/i.test(plain)) policy.gateMode = "enforce";
      const blocks = [...plain.matchAll(/\b(critical|high|medium|low|info|nit)\b/gi)].map(
        (m) => m[1]!.toLowerCase() as Severity,
      );
      if (blocks.length) policy.blockSeverities = [...new Set(blocks)];
    } else {
      policy.customSections[title] = body.trim();
    }
  }

  return policy;
}

function splitSections(md: string): Record<string, string> {
  const lines = md.split(/\r?\n/);
  const sections: Record<string, string> = {};
  let current = "Overview";
  const buf: string[] = [];

  const flush = () => {
    sections[current] = buf.join("\n");
    buf.length = 0;
  };

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      current = m[2]!.trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function extractListItems(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line) ?? /^\s*\d+\.\s+(.+)$/.exec(line);
    if (m) {
      const item = m[1]!.replace(/`/g, "").trim();
      if (item) items.push(item);
    } else {
      // bare glob lines
      const t = line.trim();
      if (t && !t.startsWith("#") && (t.includes("*") || t.includes("/"))) {
        items.push(t.replace(/`/g, ""));
      }
    }
  }
  return items;
}

function matchSeverity(text: string): Severity | undefined {
  const m = text.match(/\b(critical|high|medium|low|info|nit)\b/i);
  return m ? (m[1]!.toLowerCase() as Severity) : undefined;
}
