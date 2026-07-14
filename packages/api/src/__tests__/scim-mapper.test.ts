/**
 * Run: pnpm --filter @codesteward/api exec tsx --test src/__tests__/scim-mapper.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatchOps,
  extractEmail,
  extractRoleFromScimUser,
  parseEqFilter,
  toScimUser,
} from "../scim/mapper.js";
import type { StewardUser } from "../auth-file.js";

describe("scim mapper", () => {
  it("parses eq filters", () => {
    assert.deepEqual(parseEqFilter('userName eq "a@b.com"'), {
      attr: "username",
      value: "a@b.com",
    });
    assert.equal(parseEqFilter("garbage"), null);
  });

  it("extracts email and role", () => {
    assert.equal(
      extractEmail({ userName: "dev@acme.com", emails: [] }),
      "dev@acme.com",
    );
    assert.equal(
      extractRoleFromScimUser({ roles: [{ value: "Admin" }] }),
      "admin",
    );
  });

  it("maps steward user to SCIM", () => {
    const u: StewardUser = {
      id: "usr_1",
      email: "a@b.com",
      passwordHash: "x",
      role: "reviewer",
      orgId: "local",
      active: true,
      createdAt: "2020-01-01T00:00:00.000Z",
    };
    const s = toScimUser(u);
    assert.equal(s.id, "usr_1");
    assert.equal(s.userName, "a@b.com");
    assert.equal(s.active, true);
  });

  it("applies patch active=false", () => {
    const next = applyPatchOps(
      { active: true, userName: "a@b.com" },
      [{ op: "Replace", path: "active", value: false }],
    );
    assert.equal(next.active, false);
  });
});
