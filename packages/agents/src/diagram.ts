/** Generate a mermaid flowchart summarizing PR risk for review body. */
export function buildReviewMermaid(input: {
  repoId: string;
  mode: string;
  paths: string[];
  findings: Array<{ severity: string; category?: string; path?: string; title: string }>;
}): string {
  const files = [...new Set(input.paths)].slice(0, 12);
  const bySev: Record<string, number> = {};
  for (const f of input.findings) {
    bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  }
  const sevNodes = Object.entries(bySev)
    .map(([s, n]) => `  ${s}["${s}: ${n}"]`)
    .join("\n");
  const fileNodes = files
    .map((p, i) => `  f${i}["${p.replace(/"/g, "'")}"]`)
    .join("\n");
  const edges = files.map((_, i) => `  review --> f${i}`).join("\n");
  const sevEdges = Object.keys(bySev)
    .map((s) => `  review --> ${s}`)
    .join("\n");

  return [
    "```mermaid",
    "flowchart TD",
    `  review["${input.mode} review<br/>${input.repoId}"]`,
    fileNodes || "  none[\"no files\"]",
    sevNodes || "  clean[\"no findings\"]",
    edges || "  review --> none",
    sevEdges || "  review --> clean",
    "```",
  ].join("\n");
}
