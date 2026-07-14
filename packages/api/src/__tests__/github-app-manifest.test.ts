/**
 * Run: packages/api/node_modules/.bin/tsx --test src/__tests__/github-app-manifest.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGitHubAppManifest,
  isPublicHttpUrl,
  MANIFEST_DEFAULT_EVENTS,
} from "../github-app-manifest.js";

describe("github app manifest", () => {
  it("rejects localhost webhook hosts", () => {
    assert.equal(isPublicHttpUrl("http://localhost:8081/v1/webhooks/github"), false);
    assert.equal(isPublicHttpUrl("http://127.0.0.1:8081/hook"), false);
    assert.equal(isPublicHttpUrl("https://stew.example.com/v1/webhooks/github"), true);
    assert.equal(isPublicHttpUrl("https://smee.io/abc123"), true);
  });

  it("uses Codesteward name and omits installation events", () => {
    const { manifest, warnings, webhookPublic } = buildGitHubAppManifest({
      env: {
        STEW_PUBLIC_URL: "http://localhost:8080",
        STEW_API_PUBLIC_URL: "http://localhost:8081",
      } as NodeJS.ProcessEnv,
    });
    assert.equal(manifest.name, "Codesteward");
    assert.equal(manifest.redirect_url, "http://localhost:8081/v1/scm/github/manifest/callback");
    assert.ok(!manifest.default_events.includes("installation"));
    assert.ok(!manifest.default_events.includes("installation_repositories"));
    for (const e of MANIFEST_DEFAULT_EVENTS) {
      assert.ok(manifest.default_events.includes(e), e);
    }
    assert.equal(webhookPublic, false);
    assert.equal(manifest.hook_attributes, undefined);
    assert.ok(warnings.some((w) => /not public|localhost/i.test(w)));
  });

  it("defaults API base to :8081 not UI :8080", () => {
    const { manifest } = buildGitHubAppManifest({
      env: { STEW_PUBLIC_URL: "http://localhost:8080" } as NodeJS.ProcessEnv,
    });
    assert.match(manifest.redirect_url, /localhost:8081/);
  });

  it("includes public webhook when STEW_WEBHOOK_PUBLIC_URL is set", () => {
    const { manifest, webhookPublic, webhookUrl } = buildGitHubAppManifest({
      env: {
        STEW_PUBLIC_URL: "https://app.example.com",
        STEW_API_PUBLIC_URL: "https://api.example.com",
        STEW_WEBHOOK_PUBLIC_URL: "https://api.example.com",
      } as NodeJS.ProcessEnv,
    });
    assert.equal(webhookPublic, true);
    assert.equal(
      manifest.hook_attributes?.url,
      "https://api.example.com/v1/webhooks/github",
    );
    assert.equal(webhookUrl, "https://api.example.com/v1/webhooks/github");
    assert.equal(manifest.redirect_url, "https://api.example.com/v1/scm/github/manifest/callback");
  });

  it("honors GITHUB_APP_NAME override", () => {
    const { manifest } = buildGitHubAppManifest({
      env: { GITHUB_APP_NAME: "Codesteward Prod" } as NodeJS.ProcessEnv,
    });
    assert.equal(manifest.name, "Codesteward Prod");
  });
});
