/**
 * License entitlement tests — run with:
 *   pnpm --filter @codesteward/api exec tsx --test src/__tests__/license.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertEntitled,
  encodeLicenseKey,
  featureMatrix,
  isEntitled,
  parseLicenseKey,
  requireEntitled,
  resolveLicense,
  signLicenseKey,
} from "../license.js";

describe("license entitlements", () => {
  it("oss defaults deny sso/prove/langfuse", () => {
    const lic = resolveLicense({ STEW_LICENSE_TIER: "oss" } as NodeJS.ProcessEnv);
    assert.equal(lic.sso, false);
    assert.equal(lic.prove, false);
    assert.equal(lic.langfuse, false);
    assert.equal(lic.thoroughDiscourse, true);
  });

  it("enforced oss blocks prove", () => {
    const env = {
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
      STEW_LICENSE_TIER: "pro",
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv);
    assert.equal(lic.sso, true);
    assert.equal(lic.prove, true);
    assert.equal(lic.langfuse, true);
    assert.equal(isEntitled("sso", {
      STEW_LICENSE_TIER: "pro",
      STEW_LICENSE_ENFORCE: "1",
    } as NodeJS.ProcessEnv), true);
  });

  it("HMAC fail-closed rejects unsigned key when secret set", () => {
    const env = {
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
