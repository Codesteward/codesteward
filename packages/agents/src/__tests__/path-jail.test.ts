import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  isPathInsideRoot,
  resolveInsideRoot,
  sanitizeOrgSegment,
  sessionWorkspaceDir,
} from "../path-jail.js";

describe("path-jail", () => {
  it("sanitizes org segments", () => {
    assert.equal(sanitizeOrgSegment("acme/corp"), "acme_corp");
    assert.equal(sanitizeOrgSegment("../evil"), "evil");
    assert.equal(sanitizeOrgSegment(""), "local");
  });

  it("nests session under org", () => {
    const p = sessionWorkspaceDir({
      sessionId: "ses_1",
      orgId: "org_a",
      root: "/tmp/ws",
    });
    assert.equal(p, join("/tmp/ws", "org_a", "ses_1"));
  });

  it("blocks sibling session escape", () => {
    const root = "/tmp/ws/org_a/ses_1";
    assert.throws(() => resolveInsideRoot(root, "../ses_2/secret.ts"));
    assert.throws(() => resolveInsideRoot(root, "/etc/passwd"));
    const ok = resolveInsideRoot(root, "src/a.ts");
    assert.ok(isPathInsideRoot(root, ok));
  });
});
