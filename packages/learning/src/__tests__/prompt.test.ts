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

  it("includes PR-scoped learning only for matching PR, repo+org always", async () => {
    const dir = mkdtempSync(join(tmpdir(), "learn-scope-"));
    dirs.push(dir);
    delete process.env.DATABASE_URL;
    const store = createLearningStore({ forceFile: true, filePath: join(dir, "learning.json") });

    await store.addMemory({
      orgId: "local",
      scope: "org",
      kind: "preference",
      polarity: "positive",
      title: "Org auth focus",
      body: "Always check authz",
      source: "test",
      weight: 1,
    });
    await store.addMemory({
      orgId: "local",
      scope: "repo",
      repoId: "acme/api",
      kind: "preference",
      polarity: "negative",
      title: "Repo ignore import order",
      body: "style only",
      source: "test",
      weight: 1,
    });
    await store.addMemory({
      orgId: "local",
      scope: "pr",
      repoId: "acme/api",
      prKey: "acme/api#9",
      kind: "dismissal",
      polarity: "negative",
      title: "Defer rate limit to follow-up",
      body: "Out of scope for this PR",
      source: "test",
      weight: 1,
    });
    await store.addMemory({
      orgId: "local",
      scope: "pr",
      repoId: "acme/api",
      prKey: "acme/api#99",
      kind: "dismissal",
      polarity: "negative",
      title: "Other PR only",
      body: "should not appear",
      source: "test",
      weight: 1,
    });

    const prompt = await buildOrgLearningPrompt(store, {
      orgId: "local",
      repoId: "acme/api",
      prNumber: 9,
    });
    assert.ok(prompt.includes("Org auth focus"));
    assert.ok(prompt.includes("Repo ignore import order"));
    assert.ok(prompt.includes("Defer rate limit"));
    assert.ok(!prompt.includes("Other PR only"));
    assert.ok(prompt.includes("[pr/") || prompt.includes("pr: acme/api#9"));
  });

  it("moveMemory rewrites scope identifiers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "learn-move-"));
    dirs.push(dir);
    delete process.env.DATABASE_URL;
    const store = createLearningStore({ forceFile: true, filePath: join(dir, "learning.json") });
    const mem = await store.addMemory({
      orgId: "local",
      scope: "org",
      kind: "preference",
      polarity: "positive",
      title: "Move me",
      body: "x",
      source: "test",
      weight: 1,
    });
    const moved = await store.moveMemory(mem.id, {
      scope: "pr",
      repoId: "acme/api",
      prKey: "acme/api#3",
    });
    assert.ok(moved);
    assert.equal(moved!.scope, "pr");
    assert.equal(moved!.repoId, "acme/api");
    assert.equal(moved!.prKey, "acme/api#3");
    const listPr = await store.listMemories({ orgId: "local", scope: "pr" });
    assert.equal(listPr.length, 1);
    const listOrg = await store.listMemories({ orgId: "local", scope: "org" });
    assert.equal(listOrg.length, 0);
  });
});
