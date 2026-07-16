/**
 * First OIDC JIT user on empty install → platformAdmin (parity with local bootstrap).
 * Run: pnpm --filter @codesteward/api exec tsx --test src/__tests__/oidc-first-user-platform-admin.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth-store.js";

describe("OIDC first install user", () => {
  let dir: string;
  let prevData: string | undefined;
  let prevDb: string | undefined;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "stew-oidc-first-"));
    prevData = process.env.STEW_DATA_DIR;
    prevDb = process.env.DATABASE_URL;
    process.env.STEW_DATA_DIR = dir;
    delete process.env.DATABASE_URL;
  });

  after(() => {
    if (prevData === undefined) delete process.env.STEW_DATA_DIR;
    else process.env.STEW_DATA_DIR = prevData;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("grants platformAdmin + admin to the first OIDC user on an empty store", async () => {
    const store = new AuthStore(join(dir, "users.json"));
    await store.load();
    assert.equal(await store.userCount(), 0);

    const first = await store.findOrCreateFromOidc({
      email: "ops@example.com",
      displayName: "Ops",
      roleHint: "reviewer",
      subject: "kc-sub-1",
    });
    assert.equal(first.created, true);
    assert.equal(first.user.platformAdmin, true);
    assert.equal(first.user.role, "admin");
    assert.equal(await store.userCount(), 1);

    const second = await store.findOrCreateFromOidc({
      email: "dev@example.com",
      displayName: "Dev",
      roleHint: "reviewer",
      subject: "kc-sub-2",
    });
    assert.equal(second.created, true);
    assert.equal(second.user.platformAdmin, false);
    assert.equal(second.user.role, "reviewer");
  });

  it("does not re-elevate an existing non-platform user", async () => {
    const store = new AuthStore(join(dir, "users.json"));
    await store.load();
    const again = await store.findOrCreateFromOidc({
      email: "dev@example.com",
      roleHint: "admin",
      subject: "kc-sub-2",
    });
    assert.equal(again.created, false);
    assert.equal(again.user.platformAdmin, false);
  });
});
