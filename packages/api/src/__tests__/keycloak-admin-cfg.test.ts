/**
 * Keycloak Admin config parsing — path-based vs root relative path.
 * Run: pnpm --filter @codesteward/api exec tsx --test src/__tests__/keycloak-admin-cfg.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isKeycloakAdminConfigured } from "../identity/keycloak-admin.js";

describe("isKeycloakAdminConfigured", () => {
  it("accepts path-based Keycloak issuer (/auth/realms/...)", () => {
    assert.equal(
      isKeycloakAdminConfigured({
        OIDC_ISSUER: "http://keycloak:8083/auth/realms/codesteward",
        KEYCLOAK_ADMIN_CLIENT_SECRET: "secret",
      }),
      true,
    );
  });

  it("accepts root Keycloak issuer (/realms/...)", () => {
    assert.equal(
      isKeycloakAdminConfigured({
        OIDC_ISSUER: "http://keycloak:8083/realms/codesteward",
        KEYCLOAK_ADMIN_CLIENT_SECRET: "secret",
      }),
      true,
    );
  });

  it("rejects missing secret", () => {
    assert.equal(
      isKeycloakAdminConfigured({
        OIDC_ISSUER: "http://keycloak:8083/auth/realms/codesteward",
      }),
      false,
    );
  });

  it("rejects missing issuer", () => {
    assert.equal(
      isKeycloakAdminConfigured({
        KEYCLOAK_ADMIN_CLIENT_SECRET: "secret",
      }),
      false,
    );
  });
});
