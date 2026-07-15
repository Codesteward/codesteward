/**
 * pnpm --filter @codesteward/api exec tsx --test src/__tests__/platform-github-app.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  putPlatformGithubApp,
  resolvePlatformGithubAppPolicy,
  assertOrgMayConfigureGithubApp,
  assertOrgMayUseGithubPat,
} from "../platform-github-app-store.js";

describe("platform GitHub App enforce", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    delete process.env.STEW_DATA_DIR;
    delete process.env.STEW_PLATFORM_GITHUB_APP_ENFORCE;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("enforces shared app and blocks org PEM/PAT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plat-gh-"));
    dirs.push(dir);
    process.env.STEW_DATA_DIR = dir;

    await putPlatformGithubApp({
      enforce: true,
      allowOrgPat: false,
      appId: "42",
      privateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      slug: "codesteward",
    });

    const policy = await resolvePlatformGithubAppPolicy();
    assert.equal(policy.enforce, true);
    assert.equal(policy.configured, true);
    assert.equal(policy.appId, "42");
    assert.ok(policy.privateKey?.includes("BEGIN"));

    await assert.rejects(
      () => assertOrgMayConfigureGithubApp(),
      (e: Error & { status?: number; code?: string }) =>
        e.status === 403 && e.code === "PLATFORM_GITHUB_APP_ENFORCED",
    );
    await assert.rejects(
      () => assertOrgMayUseGithubPat(),
      (e: Error & { code?: string }) => e.code === "PLATFORM_GITHUB_APP_ENFORCED",
    );
  });

  it("env STEW_PLATFORM_GITHUB_APP_ENFORCE bootstraps policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plat-gh-env-"));
    dirs.push(dir);
    process.env.STEW_DATA_DIR = dir;
    process.env.STEW_PLATFORM_GITHUB_APP_ENFORCE = "1";
    process.env.GITHUB_APP_ID = "99";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nenv\n-----END RSA PRIVATE KEY-----";

    const policy = await resolvePlatformGithubAppPolicy();
    assert.equal(policy.enforce, true);
    assert.equal(policy.source, "env");
    assert.equal(policy.appId, "99");
  });
});
