import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function key(): Buffer {
  const raw =
    process.env.STEW_SECRETS_KEY ?? process.env.STEW_API_KEY ?? "steward-dev-state-key";
  return createHash("sha256").update(raw).digest();
}

export function signState(payload: Record<string, unknown>, ttlSec = 3600): string {
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
  const data = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", key()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyState<T extends Record<string, unknown>>(token: string): T {
  const [data, sig] = token.split(".");
  if (!data || !sig) throw Object.assign(new Error("invalid state"), { status: 400 });
  const expected = createHmac("sha256", key()).update(data).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("invalid state signature"), { status: 400 });
  }
  const body = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T & {
    exp?: number;
  };
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("state expired"), { status: 400 });
  }
  return body;
}
