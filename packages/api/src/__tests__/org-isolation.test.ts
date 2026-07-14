/**
 * Org isolation tests — run with: pnpm --filter @codesteward/api exec tsx --test src/__tests__/org-isolation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTenancyStoreForTests, getTenancyStore } from "../tenancy/orgs.js";

describe("tenancy membership isolation", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "stew-tenancy-"));
    process.env.STEW_DATA_DIR = dir;
    resetTenancyStoreForTests();
  });
  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("rejects non-member X-Org-Id spoof", async () => {
    const store = getTenancyStore();
    await store.ensureDefaults();
    const orgB = await store.createOrg({ name: "Acme", ownerUserId: "user-owner" });
    await store.upsertMember({ orgId: "local", userId: "user-a", role: "admin" });

    await assert.rejects(
      () => store.assertMembership("user-a", orgB.id, { authMode: "session" }),
      (err: Error & { status?: number }) => err.status === 403,
    );
  });

  it("allows member access", async () => {
    const store = getTenancyStore();
    await store.upsertMember({ orgId: "local", userId: "user-a", role: "reviewer" });
    const m = await store.assertMembership("user-a", "local", { authMode: "session" });
    assert.equal(m.role, "reviewer");
  });

  it("encrypts github app private key at rest", async () => {
    const store = getTenancyStore();
    process.env.STEW_SECRETS_KEY = "a".repeat(64);
    await store.saveGitHubAppConfig({
      appId: "123",
      privateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      orgId: "local",
    });
    const raw = await store.getGitHubAppConfig("local");
    assert.ok(raw?.privateKeyPem?.startsWith("enc:v1:"));
    const creds = store.resolveGitHubAppCredentials(raw);
    assert.ok(creds?.privateKey.includes("BEGIN RSA"));
  });
});
