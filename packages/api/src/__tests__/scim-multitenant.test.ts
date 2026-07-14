/**
 * Multi-tenant SCIM isolation — token/path must not cross orgs.
 * Run: pnpm --filter @codesteward/api exec tsx --test src/__tests__/scim-multitenant.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTenancyStoreForTests, getTenancyStore } from "../tenancy/orgs.js";
import { mintScimToken, resolveScimBearer } from "../scim/tokens-store.js";
import { resolveOrgKey, userInOrg, listOrgScimUsers } from "../scim/tenant.js";
import { globalAuthStore } from "../auth-store.js";

describe("scim multi-tenant isolation", () => {
  let dir: string;
  let orgA: string;
  let orgB: string;
  let tokenA: string;
  let tokenB: string;
  let userA: string;
  let userB: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "stew-scim-mt-"));
    process.env.STEW_DATA_DIR = dir;
    delete process.env.STEW_SCIM_TOKEN;
    delete process.env.STEW_API_KEY;
    resetTenancyStoreForTests();
    const store = getTenancyStore();
    await store.ensureDefaults();
    const a = await store.createOrg({ name: "Tenant A", slug: "tenant-a", ownerUserId: "owner-a" });
    const b = await store.createOrg({ name: "Tenant B", slug: "tenant-b", ownerUserId: "owner-b" });
    orgA = a.id;
    orgB = b.id;

    const ua = await globalAuthStore.createUserRaw({
      email: "a@tenant-a.test",
      role: "admin",
      orgId: orgA,
    });
    const ub = await globalAuthStore.createUserRaw({
      email: "b@tenant-b.test",
      role: "admin",
      orgId: orgB,
    });
    userA = ua.id;
    userB = ub.id;
    await store.upsertMember({ orgId: orgA, userId: userA, role: "admin" });
    await store.upsertMember({ orgId: orgB, userId: userB, role: "admin" });

    tokenA = (await mintScimToken({ orgId: orgA, label: "A" })).token;
    tokenB = (await mintScimToken({ orgId: orgB, label: "B" })).token;
  });

  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("token resolves only to its org", async () => {
    const ra = await resolveScimBearer(tokenA);
    const rb = await resolveScimBearer(tokenB);
    assert.equal(ra?.orgId, orgA);
    assert.equal(rb?.orgId, orgB);
    assert.equal(await resolveScimBearer("scim_forged_token_xxxxx"), null);
  });

  it("path org resolves by slug", async () => {
    const o = await resolveOrgKey("tenant-a");
    assert.equal(o?.id, orgA);
  });

  it("userInOrg denies cross-tenant", async () => {
    assert.equal(await userInOrg(userA, orgA), true);
    assert.equal(await userInOrg(userA, orgB), false);
    assert.equal(await userInOrg(userB, orgA), false);
  });

  it("listOrgScimUsers never returns other tenant users", async () => {
    const listA = await listOrgScimUsers(orgA);
    const listB = await listOrgScimUsers(orgB);
    assert.ok(listA.some((u) => u.id === userA));
    assert.ok(!listA.some((u) => u.id === userB));
    assert.ok(listB.some((u) => u.id === userB));
    assert.ok(!listB.some((u) => u.id === userA));
  });

  it("membership assert rejects spoofed org", async () => {
    const store = getTenancyStore();
    await assert.rejects(
      () => store.assertMembership(userA, orgB, { authMode: "session" }),
      (e: Error & { status?: number }) => e.status === 403,
    );
  });
});
