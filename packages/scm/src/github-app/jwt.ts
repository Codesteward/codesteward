import { createSign, createPrivateKey } from "node:crypto";

/**
 * Create a GitHub App JWT (RS256).
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function createGitHubAppJwt(input: {
  appId: string;
  privateKeyPem: string;
  /** seconds; GitHub max 10 minutes */
  expiresInSec?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.min(input.expiresInSec ?? 540, 600);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp, iss: input.appId };

  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${enc(header)}.${enc(payload)}`;

  const key = createPrivateKey(input.privateKeyPem);
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  sign.end();
  const sig = sign.sign(key).toString("base64url");
  return `${unsigned}.${sig}`;
}
