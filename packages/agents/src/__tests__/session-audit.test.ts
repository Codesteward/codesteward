import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZeroFindingsRationale, SessionAuditCollector } from "../session-audit.js";
import { nowIso } from "@codesteward/core";

test("collector records specialist runs and finalizes", () => {
  const c = new SessionAuditCollector("ses_test");
  c.setContext({
    repoId: "acme/app",
    source: "clone",
    verified: true,
    verifiedSha: "abc123",
    pathsRequested: ["."],
    pathsEffective: ["."],
    filesIncluded: ["src/a.ts"],
    filesOmitted: [],
    notes: ["cloned"],
    preparedAt: nowIso(),
  });
  const id = c.startRun({ unitId: "u1", role: "security", runner: "simple", model: "openai:gpt-4.1" });
  c.endRun(id, { status: "ok", findingCount: 0, responseContent: '{"findings":[]}' });
  c.recordTool({
    tool: "graph_query",
    name: "codebase_graph_query",
    summary: "lexical q=foo",
    ok: true,
  });
  const audit = c.finalize({ findingCount: 0 });
  assert.equal(audit.version, 1);
  assert.equal(audit.specialistRuns.length, 1);
  assert.equal(audit.tools.total, 1);
  assert.equal(audit.zeroFindings?.reason, "all_units_clean");
  assert.ok(audit.specialistRuns[0]!.responseSha256);
});

test("zero findings rationale flags unverified empty context", () => {
  const r = buildZeroFindingsRationale({
    context: {
      repoId: "x/y",
      source: "unverified_mount",
      verified: false,
      pathsRequested: [],
      pathsEffective: [],
      filesIncluded: [],
      filesOmitted: [],
      notes: [],
      preparedAt: nowIso(),
    },
    runs: [],
  });
  assert.equal(r.reason, "context_missing");
});
