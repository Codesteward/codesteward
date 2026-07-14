import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFindingsStore } from "../store.js";
import {
  presentFingerprintSet,
  reconcileFindingsOnRereview,
  upsertFindingAcrossSessions,
  type FindingScope,
} from "../reconcile.js";

describe("finding lifecycle reconcile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function store() {
    const dir = mkdtempSync(join(tmpdir(), "find-reconcile-"));
    dirs.push(dir);
    delete process.env.DATABASE_URL;
    return createFindingsStore({
      preferDb: false,
      filePath: join(dir, "findings.json"),
    });
  }

  const scope: FindingScope = {
    orgId: "local",
    repoId: "acme/api",
    mode: "gate",
    prNumber: 42,
  };

  const baseCand = {
    title: "Missing auth check",
    body: "handler lacks authz guard",
    path: "src/api.ts",
    category: "security" as const,
    severity: "high" as const,
    confidence: 0.9,
    ruleIds: ["authz"],
    agents: ["security" as const],
  };

  it("auto-fixes prior open finding when absent from re-review", async () => {
    const s = store();
    const first = await upsertFindingAcrossSessions(
      s,
      {
        ...baseCand,
        sessionId: "sess-1",
        repoId: scope.repoId,
        orgId: scope.orgId,
      },
      scope,
    );
    assert.equal(first.action, "created");
    assert.equal(first.finding.status, "open");

    // Second review: no findings present
    const rec = await reconcileFindingsOnRereview(s, {
      scope,
      sessionId: "sess-2",
      presentFingerprints: new Set(),
    });
    assert.equal(rec.fixed.length, 1);
    const updated = await s.get(first.finding.id);
    assert.equal(updated?.status, "fixed");
    assert.ok(updated?.tags?.some((t) => t.startsWith("auto-fixed:")));
  });

  it("does not auto-fix findings outside reviewed paths (incremental)", async () => {
    const s = store();
    const first = await upsertFindingAcrossSessions(
      s,
      {
        ...baseCand,
        path: "src/other.ts",
        sessionId: "sess-1",
        repoId: scope.repoId,
        orgId: scope.orgId,
      },
      scope,
    );
    const rec = await reconcileFindingsOnRereview(s, {
      scope,
      sessionId: "sess-2",
      presentFingerprints: new Set(),
      reviewedPaths: ["src/api.ts"],
    });
    assert.equal(rec.fixed.length, 0);
    const still = await s.get(first.finding.id);
    assert.equal(still?.status, "open");
  });

  it("updates same fingerprint across sessions instead of duplicating", async () => {
    const s = store();
    const a = await upsertFindingAcrossSessions(
      s,
      {
        ...baseCand,
        sessionId: "sess-1",
        repoId: scope.repoId,
        orgId: scope.orgId,
      },
      scope,
    );
    // Same body/path/category → same fingerprint (snippet is part of the hash)
    const b = await upsertFindingAcrossSessions(
      s,
      {
        ...baseCand,
        sessionId: "sess-2",
        repoId: scope.repoId,
        orgId: scope.orgId,
        confidence: 0.95,
        severity: "critical",
      },
      scope,
    );
    assert.equal(b.action, "updated");
    assert.equal(b.finding.id, a.finding.id);
    assert.equal(b.finding.sessionId, "sess-2");
    assert.equal(b.finding.severity, "critical");
    const all = await s.list({ repoId: scope.repoId });
    assert.equal(all.filter((f) => f.fingerprint === a.finding.fingerprint).length, 1);
  });

  it("reopens fixed findings when they return", async () => {
    const s = store();
    const a = await upsertFindingAcrossSessions(
      s,
      {
        ...baseCand,
        sessionId: "sess-1",
        repoId: scope.repoId,
        orgId: scope.orgId,
      },
      scope,
    );
    await s.transition(a.finding.id, "fixed");
    const b = await upsertFindingAcrossSessions(
      s,
      {
        ...baseCand,
        sessionId: "sess-3",
        repoId: scope.repoId,
        orgId: scope.orgId,
      },
      scope,
    );
    assert.equal(b.action, "reopened");
    assert.equal(b.finding.status, "reopened");
    assert.equal(b.finding.id, a.finding.id);
  });

  it("keeps user-dismissed findings closed", async () => {
    const s = store();
    const a = await upsertFindingAcrossSessions(
      s,
      {
        ...baseCand,
        sessionId: "sess-1",
        repoId: scope.repoId,
        orgId: scope.orgId,
      },
      scope,
    );
    await s.transition(a.finding.id, "dismissed");
    const b = await upsertFindingAcrossSessions(
      s,
      {
        ...baseCand,
        sessionId: "sess-2",
        repoId: scope.repoId,
        orgId: scope.orgId,
      },
      scope,
    );
    assert.equal(b.action, "kept_closed");
    assert.equal(b.finding.status, "dismissed");
  });

  it("presentFingerprintSet is stable", () => {
    const set = presentFingerprintSet([baseCand, baseCand]);
    assert.equal(set.size, 1);
  });
});
