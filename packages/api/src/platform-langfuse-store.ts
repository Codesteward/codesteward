/**
 * Install-wide Langfuse project (optional).
 * Coexists with per-org projects: when both are set, reviews dual-write.
 * Secrets encrypted at rest. Env LANGFUSE_* still used as fallback when store empty.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secrets.js";
import {
  mergeLangfuseSecrets,
  maskLangfuse,
  type OrgLangfuseConfig,
} from "./org-settings-store.js";

export type PlatformLangfuseConfig = OrgLangfuseConfig;

function path(): string {
  return join(process.env.STEW_DATA_DIR ?? ".steward-data", "platform-langfuse.json");
}

export async function getPlatformLangfuse(): Promise<PlatformLangfuseConfig | null> {
  try {
    const raw = await readFile(path(), "utf8");
    const parsed = JSON.parse(raw) as PlatformLangfuseConfig;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function putPlatformLangfuse(
  incoming: (Partial<PlatformLangfuseConfig> & { clear?: boolean }) | null,
): Promise<PlatformLangfuseConfig | null> {
  const prev = await getPlatformLangfuse();
  const next = mergeLangfuseSecrets(prev, incoming);
  await mkdir(process.env.STEW_DATA_DIR ?? ".steward-data", { recursive: true });
  if (next === null) {
    try {
      await writeFile(path(), "null\n", "utf8");
    } catch {
      /* ignore */
    }
    return null;
  }
  await writeFile(path(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export { maskLangfuse };

/** Decrypted platform credentials for runtime (store wins over env if complete). */
export async function loadPlatformLangfuseForRuntime(): Promise<{
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  enabled: boolean;
  source: "platform";
} | null> {
  const stored = await getPlatformLangfuse();
  if (stored?.enabled === false) {
    return null;
  }
  if (stored?.publicKey && stored?.secretKey) {
    let secretKey = stored.secretKey;
    if (isEncryptedSecret(secretKey)) {
      try {
        secretKey = decryptSecret(secretKey) ?? "";
      } catch {
        secretKey = "";
      }
    }
    if (secretKey) {
      return {
        publicKey: stored.publicKey,
        secretKey,
        baseUrl: stored.baseUrl,
        enabled: true,
        source: "platform",
      };
    }
  }
  if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
    return {
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
      enabled: true,
      source: "platform",
    };
  }
  return null;
}
