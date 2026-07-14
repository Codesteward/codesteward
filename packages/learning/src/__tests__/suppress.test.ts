import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLearningStore } from "../store.js";

describe("learnings suppress loop", () => {
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

  function freshStore() {
    const dir = mkdtempSync(join(tmpdir(), "learn-"));
    dirs.push(dir);
    delete process.env.DATABASE_URL;
    return createLearningStore({ forceFile: true, filePath: join(dir, "learning.json") });
  }

  it("downvote memory appears in negativeSuppression fingerprints", async () => {
    const store = freshStore();
    await store.react({
      findingId: "f1",
      reaction: "down",
      fingerprint: "fp-auth-missing",
      orgId: "local",
      repoId: "demo/repo",
      note: "false positive on test helper",
    });
    const neg = await store.negativeSuppression({ orgId: "local", repoId: "demo/repo" });
    assert.ok(neg.fingerprints.has("fp-auth-missing"));
    assert.ok(neg.patterns.some((p) => p.includes("false positive")));
  });

  it("org-A downvote does not poison org-B suppression (multi-tenant)", async () => {
    const store = freshStore();
    await store.react({
      findingId: "f-a",
      reaction: "down",
      fingerprint: "fp-shared",
      orgId: "org-a",
      repoId: "same/repo",
      note: "org-a considers this noise",
    });
    await store.react({
      findingId: "f-b",
      reaction: "up",
      fingerprint: "fp-shared",
      orgId: "org-b",
      repoId: "same/repo",
    });
    await store.addMemory({
      orgId: "org-b",
      repoId: "same/repo",
      kind: "dismissal",
      polarity: "negative",
      fingerprint: "fp-b-only",
      pattern: "org-b only pattern",
      title: "org-b only",
      body: "private",
      source: "test",
      weight: 1,
    });

    const a = await store.negativeSuppression({ orgId: "org-a", repoId: "same/repo" });
    const b = await store.negativeSuppression({ orgId: "org-b", repoId: "same/repo" });

    assert.ok(a.fingerprints.has("fp-shared"));
    assert.ok(!a.fingerprints.has("fp-b-only"), "org-a must not see org-b fingerprints");
    assert.ok(!a.patterns.some((p) => p.includes("org-b only")));

    assert.ok(b.fingerprints.has("fp-b-only"));
    assert.ok(!b.fingerprints.has("fp-shared"), "org-b upvote must not suppress; org-a down stays private");
    assert.ok(b.patterns.some((p) => p.includes("org-b only")));
  });

  it("negativeSuppression defaults missing orgId to local (no cross-org merge)", async () => {
    const store = freshStore();
    await store.react({
      findingId: "f1",
      reaction: "down",
      fingerprint: "fp-local",
      orgId: "local",
      note: "local noise",
    });
    await store.react({
      findingId: "f2",
      reaction: "down",
      fingerprint: "fp-other",
      orgId: "other-corp",
      note: "other noise",
    });
    const unscoped = await store.negativeSuppression({});
    assert.ok(unscoped.fingerprints.has("fp-local"));
    assert.ok(
      !unscoped.fingerprints.has("fp-other"),
      "unscoped must not merge every tenant — defaults to local",
    );
  });
});
