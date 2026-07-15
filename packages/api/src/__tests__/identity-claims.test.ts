/**
 * Run: pnpm --filter @codesteward/api exec tsx --test src/__tests__/identity-claims.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapOrgMemberships,
  mapProductRole,
  emailFromClaims,
} from "../identity/claims.js";

describe("identity claims", () => {
  it("maps steward-admin role", () => {
    assert.equal(
      mapProductRole({
        sub: "1",
        realm_access: { roles: ["steward-admin", "offline_access"] },
      }),
      "admin",
    );
  });

  it("ignores bare admin", () => {
    assert.equal(
      mapProductRole({
        sub: "1",
        realm_access: { roles: ["admin"] },
      }),
      "reviewer",
    );
  });

  it("parses /orgs/{slug} groups", () => {
    const m = mapOrgMemberships({
      sub: "1",
      groups: ["/orgs/acme", "/orgs/local"],
      realm_access: { roles: ["steward-reviewer"] },
    });
    assert.ok(m.some((x) => x.key === "acme"));
    assert.ok(m.some((x) => x.key === "local"));
  });

  it("returns no memberships when no org claims (SaaS onboarding)", () => {
    const m = mapOrgMemberships({ sub: "1", email: "a@b.com" });
    assert.equal(m.length, 0);
  });

  it("reads email", () => {
    assert.equal(emailFromClaims({ sub: "1", email: "A@B.COM" }), "a@b.com");
  });
});
