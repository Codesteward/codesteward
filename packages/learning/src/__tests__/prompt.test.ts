import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLearningStore } from "../store.js";
import { buildOrgLearningPrompt } from "../prompt.js";

describe("buildOrgLearningPrompt (model-side)", () => {
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

  it("includes negative dismissals and excludes other orgs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "learn-prompt-"));
    dirs.push(dir);
    delete process.env.DATABASE_URL;
    const store = createLearningStore({ forceFile: true, filePath: join(dir, "learning.json") });

    await store.react({
      findingId: "f1",
      reaction: "down",
      fingerprint: "fp-local-noise",
      orgId: "local",
      repoId: "demo/repo",
      note: "test helper false positive",
    });
    await store.addMemory({
      orgId: "local",
      kind: "preference",
      polarity: "positive",
      pattern: "authz",
      title: "Focus on authorization",
      body: "Prefer authz gaps",
      source: "test",
      weight: 1,
    });
    await store.react({
      findingId: "f2",
      reaction: "down",
      fingerprint: "fp-other",
      orgId: "other-corp",
      note: "should not appear",
    });

    const prompt = await buildOrgLearningPrompt(store, { orgId: "local", repoId: "demo/repo" });
    assert.ok(prompt.includes("Org learning"));
    assert.ok(prompt.includes("test helper false positive") || prompt.includes("fp-local-noise"));
    assert.ok(prompt.includes("Focus on authorization") || prompt.includes("authz"));
    assert.ok(!prompt.includes("fp-other"));
    assert.ok(!prompt.includes("should not appear"));
  });

  it("returns empty when org has no memories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "learn-prompt-empty-"));
    dirs.push(dir);
    delete process.env.DATABASE_URL;
    const store = createLearningStore({ forceFile: true, filePath: join(dir, "learning.json") });
    const prompt = await buildOrgLearningPrompt(store, { orgId: "empty-org" });
    assert.equal(prompt, "");
  });
});
