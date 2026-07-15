/**
 * Install-wide GitHub App (optional enforce mode).
 *
 * When enforce=true:
 * - All orgs share the same App credentials (appId + PEM)
 * - Orgs only attach their own GitHub installation IDs
 * - Orgs cannot paste their own App PEM / PAT (unless allowOrgPat)
 *
 * Env bootstrap (no UI yet):
 *   STEW_PLATFORM_GITHUB_APP_ENFORCE=1
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY[_REF]
 *   STEW_PLATFORM_GITHUB_APP_ALLOW_PAT=1  (optional break-glass PAT)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secrets.js";

export interface PlatformGithubAppConfig {
  /** Force all tenants to use this App — block per-org App PEMs */
  enforce: boolean;
  /** When enforce, still allow org PAT connectors (default false) */
  allowOrgPat: boolean;
  appId?: string;
  clientId?: string;
  /** Encrypted PEM at rest */
  privateKeyPem?: string;
  /** env:VAR or file:path preferred in production */
  privateKeyRef?: string;
  webhookSecret?: string;
  baseUrl?: string;
  slug?: string;
  updatedAt?: string;
}

function storePath(): string {
  return join(process.env.STEW_DATA_DIR ?? ".steward-data", "platform-github-app.json");
}

export async function getPlatformGithubApp(): Promise<PlatformGithubAppConfig | null> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as PlatformGithubAppConfig;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function putPlatformGithubApp(
  incoming: Partial<PlatformGithubAppConfig> & { clear?: boolean; privateKeyPem?: string },
): Promise<PlatformGithubAppConfig | null> {
  if (incoming.clear) {
    await mkdir(process.env.STEW_DATA_DIR ?? ".steward-data", { recursive: true });
    await writeFile(storePath(), "null\n", "utf8");
    return null;
  }
  const prev = (await getPlatformGithubApp()) ?? {
    enforce: false,
    allowOrgPat: false,
  };
  const next: PlatformGithubAppConfig = {
    enforce: typeof incoming.enforce === "boolean" ? incoming.enforce : prev.enforce,
    allowOrgPat:
      typeof incoming.allowOrgPat === "boolean" ? incoming.allowOrgPat : prev.allowOrgPat,
    appId: incoming.appId?.trim() || prev.appId,
    clientId: incoming.clientId?.trim() || prev.clientId,
    privateKeyRef: incoming.privateKeyRef?.trim() || prev.privateKeyRef,
    baseUrl: incoming.baseUrl?.trim() || prev.baseUrl,
    slug: incoming.slug?.trim() || prev.slug,
    updatedAt: new Date().toISOString(),
  };
  // PEM: empty keeps previous; "__clear__" removes
  if (incoming.privateKeyPem === "__clear__") {
    next.privateKeyPem = undefined;
  } else if (incoming.privateKeyPem?.trim()) {
    next.privateKeyPem = encryptSecret(incoming.privateKeyPem.replace(/\\n/g, "\n"));
  } else {
    next.privateKeyPem = prev.privateKeyPem;
  }
  if (incoming.webhookSecret === "__clear__") {
    next.webhookSecret = undefined;
  } else if (incoming.webhookSecret?.trim()) {
    next.webhookSecret = encryptSecret(incoming.webhookSecret.trim());
  } else {
    next.webhookSecret = prev.webhookSecret;
  }
  await mkdir(process.env.STEW_DATA_DIR ?? ".steward-data", { recursive: true });
  await writeFile(storePath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function maskPlatformGithubApp(
  cfg: PlatformGithubAppConfig | null,
): Record<string, unknown> | null {
  if (!cfg) return null;
  return {
    enforce: Boolean(cfg.enforce),
    allowOrgPat: Boolean(cfg.allowOrgPat),
    appId: cfg.appId ?? null,
    clientId: cfg.clientId ?? null,
    baseUrl: cfg.baseUrl ?? null,
    slug: cfg.slug ?? null,
    privateKeyConfigured: Boolean(cfg.privateKeyPem || cfg.privateKeyRef),
    privateKeyRef: cfg.privateKeyRef ?? null,
    webhookSecretConfigured: Boolean(cfg.webhookSecret),
    updatedAt: cfg.updatedAt ?? null,
  };
}

/** Env STEW_PLATFORM_GITHUB_APP_ENFORCE=1 + GITHUB_APP_* acts as bootstrap when store empty. */
export async function resolvePlatformGithubAppPolicy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  enforce: boolean;
  allowOrgPat: boolean;
  configured: boolean;
  source: "store" | "env" | "none";
  appId?: string;
  privateKey?: string;
  baseUrl?: string;
  slug?: string;
  clientId?: string;
  webhookSecret?: string;
}> {
  const stored = await getPlatformGithubApp();
  if (stored?.appId && (stored.privateKeyPem || stored.privateKeyRef)) {
    let privateKey: string | undefined;
    if (stored.privateKeyRef?.startsWith("env:")) {
      privateKey = env[stored.privateKeyRef.slice(4)];
    } else if (stored.privateKeyPem) {
      privateKey = isEncryptedSecret(stored.privateKeyPem)
        ? decryptSecret(stored.privateKeyPem) ?? undefined
        : stored.privateKeyPem;
    }
    if (!privateKey && env.GITHUB_APP_PRIVATE_KEY) {
      privateKey = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
    }
    let webhookSecret: string | undefined;
    if (stored.webhookSecret) {
      webhookSecret = isEncryptedSecret(stored.webhookSecret)
        ? decryptSecret(stored.webhookSecret) ?? undefined
        : stored.webhookSecret;
    }
    return {
      enforce: Boolean(stored.enforce),
      allowOrgPat: Boolean(stored.allowOrgPat),
      configured: Boolean(privateKey),
      source: "store",
      appId: stored.appId,
      privateKey: privateKey?.replace(/\\n/g, "\n"),
      baseUrl: stored.baseUrl,
      slug: stored.slug,
      clientId: stored.clientId,
      webhookSecret,
    };
  }

  const envEnforce =
    env.STEW_PLATFORM_GITHUB_APP_ENFORCE === "1" ||
    env.STEW_PLATFORM_GITHUB_APP_ENFORCE === "true";
  const pem = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const canEnv =
    Boolean(env.GITHUB_APP_ID) && Boolean(pem || env.GITHUB_APP_PRIVATE_KEY_REF);
  if (envEnforce || canEnv) {
    let privateKey = pem;
    if (!privateKey && env.GITHUB_APP_PRIVATE_KEY_REF?.startsWith("env:")) {
      privateKey = env[env.GITHUB_APP_PRIVATE_KEY_REF.slice(4)]?.replace(/\\n/g, "\n");
    }
    return {
      enforce: envEnforce,
      allowOrgPat:
        env.STEW_PLATFORM_GITHUB_APP_ALLOW_PAT === "1" ||
        env.STEW_PLATFORM_GITHUB_APP_ALLOW_PAT === "true",
      configured: Boolean(env.GITHUB_APP_ID && privateKey),
      source: canEnv ? "env" : "none",
      appId: env.GITHUB_APP_ID,
      privateKey,
      baseUrl: env.GITHUB_API_URL,
      slug: env.GITHUB_APP_SLUG,
      clientId: env.GITHUB_APP_CLIENT_ID,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    };
  }

  return {
    enforce: false,
    allowOrgPat: true,
    configured: false,
    source: "none",
  };
}

/** Whether org-level App credential upload is blocked. */
export async function isPlatformGithubAppEnforced(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const p = await resolvePlatformGithubAppPolicy(env);
  return p.enforce && p.configured;
}

export async function assertOrgMayConfigureGithubApp(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (await isPlatformGithubAppEnforced(env)) {
    throw Object.assign(
      new Error(
        "A platform GitHub App is enforced for this install. Tenant admins cannot upload their own App credentials — install the shared App on your GitHub org instead.",
      ),
      { status: 403, code: "PLATFORM_GITHUB_APP_ENFORCED" },
    );
  }
}

export async function assertOrgMayUseGithubPat(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const p = await resolvePlatformGithubAppPolicy(env);
  if (p.enforce && !p.allowOrgPat) {
    throw Object.assign(
      new Error(
        "Personal Access Tokens are disabled while a platform GitHub App is enforced. Install the shared App on your GitHub organization.",
      ),
      { status: 403, code: "PLATFORM_GITHUB_APP_ENFORCED" },
    );
  }
}
