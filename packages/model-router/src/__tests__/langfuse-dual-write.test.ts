/**
 * Multi-level Langfuse: org + platform dual-write.
 * Run: pnpm --filter @codesteward/model-router exec tsx --test src/__tests__/langfuse-dual-write.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetLangfuseClient,
  resolveLangfuseDestinations,
  type LangfuseCredentials,
} from "../langfuse.js";
import { createModelRouter } from "../router.js";

describe("langfuse multi-level dual-write", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    resetLangfuseClient();
    delete process.env.STEW_LICENSE_LANGFUSE;
    delete process.env.STEW_LANGFUSE_ENABLED;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
  });

  afterEach(() => {
    resetLangfuseClient();
    process.env = { ...prev };
  });

  const org: LangfuseCredentials = {
    publicKey: "pk-org",
    secretKey: "sk-org",
    baseUrl: "https://cloud.langfuse.com",
    enabled: true,
    source: "org",
    orgId: "org_1",
  };

  const platform: LangfuseCredentials = {
    publicKey: "pk-plat",
    secretKey: "sk-plat",
    baseUrl: "https://cloud.langfuse.com",
    enabled: true,
    source: "platform",
  };

  it("includes both org and platform when both are fully configured", () => {
    const dests = resolveLangfuseDestinations(org, platform);
    assert.equal(dests.length, 2);
    assert.deepEqual(
      dests.map((d) => d.source).sort(),
      ["org", "platform"],
    );
    assert.equal(dests.find((d) => d.source === "org")?.publicKey, "pk-org");
    assert.equal(dests.find((d) => d.source === "platform")?.publicKey, "pk-plat");
  });

  it("uses platform env when platform store is null but LANGFUSE_* is set", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-env";
    process.env.LANGFUSE_SECRET_KEY = "sk-env";
    const dests = resolveLangfuseDestinations(org, null);
    assert.equal(dests.length, 2);
    assert.ok(dests.some((d) => d.source === "org" && d.publicKey === "pk-org"));
    assert.ok(dests.some((d) => d.source === "platform" && d.publicKey === "pk-env"));
  });

  it("returns only org when platform is incomplete", () => {
    const dests = resolveLangfuseDestinations(org, {
      publicKey: "pk-only",
      secretKey: "",
      enabled: true,
      source: "platform",
    });
    assert.equal(dests.length, 1);
    assert.equal(dests[0]!.source, "org");
  });

  it("returns only platform when org is incomplete", () => {
    const dests = resolveLangfuseDestinations(null, platform);
    assert.equal(dests.length, 1);
    assert.equal(dests[0]!.source, "platform");
  });

  it("dedupes identical publicKey+baseUrl", () => {
    const sameKeys: LangfuseCredentials = {
      publicKey: "pk-same",
      secretKey: "sk-org",
      baseUrl: "https://cloud.langfuse.com",
      enabled: true,
      source: "org",
    };
    const dests = resolveLangfuseDestinations(sameKeys, {
      ...sameKeys,
      secretKey: "sk-plat",
      source: "platform",
    });
    assert.equal(dests.length, 1);
  });

  it("returns empty when Langfuse license gate is off", () => {
    process.env.STEW_LICENSE_LANGFUSE = "0";
    const dests = resolveLangfuseDestinations(org, platform);
    assert.equal(dests.length, 0);
  });

  it("createModelRouter exposes full destination list for DeepAgents path", () => {
    const dests = resolveLangfuseDestinations(org, platform);
    const router = createModelRouter(process.env, {
      sessionId: "ses_test",
      orgId: "org_1",
      langfuseDestinations: dests,
    });
    const exposed = router.getLangfuseDestinations();
    assert.equal(exposed.length, 2);
    assert.deepEqual(
      exposed.map((d) => d.source).sort(),
      ["org", "platform"],
    );
    assert.equal(router.getClickHouseWriter(), null);
  });
});
