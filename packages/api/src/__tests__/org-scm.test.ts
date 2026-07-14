/**
 * Run: pnpm --filter @codesteward/api exec tsx --test src/__tests__/org-scm.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectorConfigToScmOpts } from "../org-scm.js";

describe("connectorConfigToScmOpts", () => {
  it("maps github pat fields", () => {
    const opts = connectorConfigToScmOpts("github", {
      token: "ghp_test",
      baseUrl: "https://github.example.com/api/v3",
    });
    assert.equal(opts.token, "ghp_test");
    assert.equal(opts.baseUrl, "https://github.example.com/api/v3");
  });

  it("maps azure devops service principal fields", () => {
    const opts = connectorConfigToScmOpts("azure-devops", {
      org: "myorg",
      project: "proj",
      tenantId: "tid",
      clientId: "cid",
      clientSecret: "csec",
    });
    assert.equal(opts.org, "myorg");
    assert.equal(opts.tenantId, "tid");
    assert.equal(opts.clientId, "cid");
    assert.equal(opts.clientSecret, "csec");
    assert.equal(opts.token, undefined);
  });

  it("maps github app fields", () => {
    const opts = connectorConfigToScmOpts("github", {
      appId: "123",
      privateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----",
      installationId: "99",
    });
    assert.ok(opts.githubApp);
    assert.equal(opts.githubApp?.appId, "123");
    assert.equal(opts.githubApp?.installationId, "99");
  });
});
