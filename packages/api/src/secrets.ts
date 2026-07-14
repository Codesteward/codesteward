/**
 * At-rest secret encryption for connectors / SCM app PEMs.
 * AES-256-GCM with STEW_SECRETS_KEY (32-byte hex or base64) or derived from STEW_API_KEY.
 * Format: enc:v1:<iv_b64>:<tag_b64>:<ct_b64>
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function resolveKey(): Buffer | null {
  const raw = process.env.STEW_SECRETS_KEY?.trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === 32) return b;
    } catch {
      /* fall through */
    }
    return createHash("sha256").update(raw).digest();
  }
  // Dev fallback: derive from STEW_API_KEY so multi-tenant demos encrypt without extra env
  const api = process.env.STEW_API_KEY?.trim();
  if (api) return createHash("sha256").update(`steward-secrets:${api}`).digest();
  // Last resort deterministic local key (dev only) — still better than plaintext PEMs in git-adjacent stores
  if (process.env.NODE_ENV === "production" || process.env.STEW_AUTH_STRICT === "1") {
    return null;
  }
  return createHash("sha256").update("steward-dev-insecure-secrets-key").digest();
}

export function isEncryptedSecret(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string | undefined | null): string | undefined {
  if (plaintext == null || plaintext === "") return plaintext ?? undefined;
  if (isEncryptedSecret(plaintext)) return plaintext;
  const key = resolveKey();
  if (!key) {
    if (process.env.STEW_AUTH_STRICT === "1" || process.env.NODE_ENV === "production") {
      throw new Error(
        "STEW_SECRETS_KEY required to store secrets when STEW_AUTH_STRICT=1 or NODE_ENV=production",
      );
    }
    console.warn("[secrets] STEW_SECRETS_KEY unset — storing secret without encryption (dev only)");
    return plaintext;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

export function decryptSecret(value: string | undefined | null): string | undefined {
  if (value == null || value === "") return value ?? undefined;
  if (!isEncryptedSecret(value)) return value;
  const key = resolveKey();
  if (!key) throw new Error("Cannot decrypt secret: STEW_SECRETS_KEY not configured");
  const body = value.slice(PREFIX.length);
  const [ivB, tagB, ctB] = body.split(":");
  if (!ivB || !tagB || !ctB) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Mask for API responses — last 4 of plaintext length when known. */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const plain = decryptSecret(value) ?? value;
    if (plain.length <= 4) return "****";
    return `****${plain.slice(-4)}`;
  } catch {
    return "****";
  }
}
