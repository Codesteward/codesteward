/**
 * License entitlement tests — run with:
 *   pnpm --filter @codesteward/api exec tsx --test src/__tests__/license.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  assertEntitled,
  encodeLicenseKey,
  featureMatrix,
  isEntitled,
  isOrgEntitled,
  parseLicenseKey,
  requireEntitled,
  requireOrgEntitled,
  resolveLicense,
  resolveOrgLicense,
  signLicenseKey,
} from "../license.js";

describe("license entitlements", () => {
  it("open mode (default) enables all features and hides license UI", () => {
    const lic = resolveLicense({} as NodeJS.ProcessEnv);
    assert.equal(lic.openMode, true);
    assert.equal(lic.hideLicenseUi, true);
    assert.equal(lic.enforced, false);
    assert.equal(lic.prove, true);
    assert.equal(lic.sso, true);
    assert.equal(isEntitled("prove", {} as NodeJS.ProcessEnv), true);
  });

  it("oss defaults deny sso/prove/langfuse when open mode off", () => {
    const lic = resolveLicense({
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_TIER: "oss",
    } as NodeJS.ProcessEnv);
    assert.equal(lic.sso, false);
    assert.equal(lic.prove, false);
    assert.equal(lic.langfuse, false);
    assert.equal(lic.thoroughDiscourse, true);
  });

  it("enforced oss blocks prove when open mode off", () => {
    const env = {
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_TIER: "oss",
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv;
    assert.equal(isEntitled("prove", env), false);
    assert.throws(() => requireEntitled("prove", env), (err: Error & { status?: number }) => {
      return err.status === 402;
    });
  });

  it("unenforced allows all features", () => {
    const env = {
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_TIER: "oss",
      STEW_LICENSE_ENFORCE: "0",
      NODE_ENV: "development",
    } as NodeJS.ProcessEnv;
    // NODE_ENV development + no ENFORCE
    const lic = resolveLicense(env);
    assert.equal(lic.enforced, false);
    assert.equal(assertEntitled(lic, "prove"), true);
  });

  it("pro tier includes sso/prove/langfuse", () => {
    const lic = resolveLicense({
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_TIER: "pro",
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv);
    assert.equal(lic.sso, true);
    assert.equal(lic.prove, true);
    assert.equal(lic.langfuse, true);
    assert.equal(isEntitled("sso", {
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_TIER: "pro",
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv), true);
  });

  it("HMAC fail-closed rejects unsigned key when secret set", () => {
    const env = {
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_HMAC: "test-secret",
      STEW_LICENSE_KEY: Buffer.from(JSON.stringify({ tier: "enterprise", prove: true })).toString(
        "base64url",
      ),
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv;
    const parsed = parseLicenseKey(env.STEW_LICENSE_KEY, env);
    assert.equal(parsed.ok, false);
    const lic = resolveLicense(env);
    assert.equal(lic.tier, "oss");
    assert.equal(lic.prove, false);
    assert.equal(lic.signatureValid, false);
  });

  it("accepts signed commercial key", () => {
    const secret = "commercial-hmac-secret";
    const key = signLicenseKey(
      { tier: "enterprise", prove: true, sso: true, langfuse: true, maxSeats: 500 },
      secret,
    );
    const env = {
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_HMAC: secret,
      STEW_LICENSE_KEY: key,
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv;
    const lic = resolveLicense(env);
    assert.equal(lic.tier, "enterprise");
    assert.equal(lic.prove, true);
    assert.equal(lic.sso, true);
    assert.equal(lic.signatureValid, true);
    assert.equal(isEntitled("langfuse", env), true);
  });

  it("rejects bad signature", () => {
    const secret = "commercial-hmac-secret";
    const key = signLicenseKey({ tier: "pro", prove: true }, secret);
    const env = {
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_HMAC: "wrong-secret",
      STEW_LICENSE_KEY: key,
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv;
    const lic = resolveLicense(env);
    assert.equal(lic.tier, "oss");
    assert.equal(lic.prove, false);
  });

  it("HMAC set without key refuses TIER elevation", () => {
    const env = {
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_HMAC: "commercial-hmac-secret",
      STEW_LICENSE_TIER: "enterprise",
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv;
    const lic = resolveLicense(env);
    assert.equal(lic.tier, "oss");
    assert.equal(lic.prove, false);
    assert.equal(lic.sso, false);
    assert.equal(lic.signatureRequired, true);
  });

  it("license key features[] drive entitlement booleans", () => {
    const key = encodeLicenseKey({
      tier: "pro",
      features: ["gate", "steward", "sso", "prove", "byok"],
      maxSeats: 50,
      customer: "TestCo",
    });
    const lic = resolveLicense({
      STEW_LICENSE_OPEN: "0",
      STEW_LICENSE_KEY: key,
      STEW_LICENSE_ENFORCE: "1",
      NODE_ENV: "development",
    } as NodeJS.ProcessEnv);
    assert.equal(lic.tier, "pro");
    assert.equal(lic.sso, true);
    assert.equal(lic.prove, true);
    assert.equal(lic.byok, true);
    assert.equal(lic.langfuse, false); // not in features[]
    assert.equal(lic.customer, "TestCo");
    assert.equal(lic.maxSeats, 50);
    const matrix = featureMatrix(lic);
    assert.ok(matrix.find((f) => f.id === "sso")?.enabled);
    assert.ok(!matrix.find((f) => f.id === "langfuse")?.enabled);
  });
});

describe("org license via SaaS billing control plane", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolveOrgLicense prefers STEW_BILLING_URL entitlements", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          orgId: "acme",
          planId: "pro",
          entitlements: {
            tier: "pro",
            prove: true,
            thoroughDiscourse: true,
            langfuse: true,
            features: ["gate", "prove", "thorough_discourse", "langfuse"],
            customer: "Acme",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const env = {
      STEW_BILLING_URL: "http://billing.test",
      STEW_BILLING_TOKEN: "t",
      // open mode default would otherwise unlock everything without billing
    } as NodeJS.ProcessEnv;

    const lic = await resolveOrgLicense("acme", env);
    assert.equal(lic.orgId, "acme");
    assert.equal(lic.prove, true);
    assert.equal(lic.tier, "pro");
    assert.equal(lic.openMode, false);
    assert.equal(lic.hideLicenseUi, true);
    assert.equal(lic.enforced, true);
    assert.equal(await isOrgEntitled("acme", "prove", env), true);
  });

  it("free plan from billing denies prove even when open mode would allow it", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          orgId: "startup",
          planId: "free",
          entitlements: {
            tier: "oss",
            prove: false,
            thoroughDiscourse: false,
            features: ["gate", "steward", "graph"],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const env = {
      STEW_BILLING_URL: "http://billing.test",
      STEW_BILLING_TOKEN: "t",
    } as NodeJS.ProcessEnv;

    assert.equal(await isOrgEntitled("startup", "prove", env), false);
    assert.equal(await isOrgEntitled("startup", "thoroughDiscourse", env), false);
    await assert.rejects(
      () => requireOrgEntitled("startup", "prove", env),
      (err: Error & { status?: number; code?: string }) =>
        err.status === 402 && err.code === "ORG_LICENSE_REQUIRED",
    );
  });

  it("falls back to open mode when billing is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const env = {
      STEW_BILLING_URL: "http://billing.down",
    } as NodeJS.ProcessEnv;

    const lic = await resolveOrgLicense("x", env);
    assert.equal(lic.openMode, true);
    assert.equal(await isOrgEntitled("x", "prove", env), true);
  });

  it("free plan denies thorough discourse", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          orgId: "free-org",
          planId: "free",
          entitlements: {
            tier: "oss",
            thoroughDiscourse: false,
            prove: false,
            enterpriseConnectors: false,
            maxSeats: 5,
            features: ["gate", "steward", "graph", "sarif", "cli", "webhooks", "byok", "sso"],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const env = {
      STEW_BILLING_URL: "http://billing.test",
      STEW_BILLING_TOKEN: "t",
    } as NodeJS.ProcessEnv;

    assert.equal(await isOrgEntitled("free-org", "thoroughDiscourse", env), false);
    assert.equal(await isOrgEntitled("free-org", "enterpriseConnectors", env), false);
    await assert.rejects(
      () => requireOrgEntitled("free-org", "thoroughDiscourse", env),
      (err: Error & { status?: number }) =>
        err.status === 402 && /Thorough dual-pass/i.test(err.message),
    );
  });
});
