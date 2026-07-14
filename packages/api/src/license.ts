/**
 * License / entitlement SoT (server).
 *
 * Resolution order:
 *   1. Uploaded license file (STEW_LICENSE_FILE or .steward-data/license.key)
 *   2. STEW_LICENSE_KEY env
 *   3. STEW_LICENSE_TIER env defaults
 *   4. oss defaults
 *
 * License key formats:
 *   - base64url(JSON entitlements)
 *   - body.sig  (HMAC-SHA256 base64url) when STEW_LICENSE_HMAC is set — fail-closed if unsigned
 *   - raw JSON (dev / self-host when HMAC unset)
 *
 * STEW_LICENSE_ENFORCE=1 or NODE_ENV=production → fail closed on gated features
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type LicenseTier = "oss" | "pro" | "enterprise";

export interface LicenseEntitlements {
  tier: LicenseTier;
  multiOrg: boolean;
  sso: boolean;
  thoroughDiscourse: boolean;
  prove: boolean;
  crossRepo: boolean;
  langfuse: boolean;
  /** Org model BYOK / UI provider keys */
  byok: boolean;
  /** GitHub App / enterprise connectors */
  enterpriseConnectors: boolean;
  maxSeats: number;
  /** Explicit feature flags carried by the license payload */
  features: string[];
  orgId?: string;
  customer?: string;
  validUntil?: string;
  source: "file" | "env" | "key" | "default";
  enforced: boolean;
  signatureRequired: boolean;
  signatureValid?: boolean;
  /** Human-readable parse status for UI */
  status?: string;
}

/** Catalog of features a license may enable — shown in Settings + gating. */
export const FEATURE_CATALOG: Array<{
  id: string;
  label: string;
  description: string;
  booleanKey?: keyof LicenseEntitlements;
}> = [
  { id: "gate", label: "PR Gate", description: "Pull-request gate reviews" },
  { id: "steward", label: "Stewardship", description: "Branch stewardship mode" },
  { id: "graph", label: "Graph intelligence", description: "Codesteward Graph evidence" },
  { id: "sarif", label: "SARIF export", description: "Findings export" },
  { id: "cli", label: "CLI", description: "stew CLI" },
  { id: "multi_org", label: "Multi-org", description: "Multiple product organizations", booleanKey: "multiOrg" },
  { id: "webhooks", label: "Webhooks", description: "SCM webhook automation" },
  { id: "analytics", label: "Analytics", description: "Address-rate and dashboards" },
  {
    id: "sso",
    label: "Managed identity / OIDC",
    description:
      "Platform IdP login (OIDC). Federated SSO to Entra/Google/Okta is configured on the IdP.",
    booleanKey: "sso",
  },
  { id: "prove", label: "Prove", description: "LLM test generation / sandbox prove", booleanKey: "prove" },
  { id: "langfuse", label: "Langfuse", description: "LLM observability tracing", booleanKey: "langfuse" },
  { id: "thorough_discourse", label: "Thorough discourse", description: "Dual-pass thorough reviews", booleanKey: "thoroughDiscourse" },
  { id: "byok", label: "BYOK models", description: "Per-org model API keys from UI", booleanKey: "byok" },
  { id: "enterprise_connectors", label: "Enterprise connectors", description: "GitHub App and multi-SCM", booleanKey: "enterpriseConnectors" },
  {
    id: "scim",
    label: "SCIM",
    description:
      "SCIM 2.0 Users/Groups provisioning (/scim/v2) for Okta/Entra/IdPs",
  },
  {
    id: "audit",
    label: "Audit log",
    description:
      "Durable admin audit trail with filters, NDJSON export, and retention prune",
  },
  { id: "cross_repo", label: "Cross-repo", description: "Cross-repository fan-out", booleanKey: "crossRepo" },
];

const TIER_DEFAULTS: Record<
  LicenseTier,
  Omit<
    LicenseEntitlements,
    "tier" | "source" | "validUntil" | "enforced" | "signatureRequired" | "signatureValid" | "status" | "orgId" | "customer"
  >
> = {
  oss: {
    multiOrg: true,
    sso: false,
    thoroughDiscourse: true,
    prove: false,
    crossRepo: true,
    langfuse: false,
    byok: true,
    enterpriseConnectors: true,
    maxSeats: 25,
    features: [
      "gate",
      "steward",
      "graph",
      "sarif",
      "cli",
      "multi_org",
      "cross_repo",
      "byok",
      "enterprise_connectors",
      "thorough_discourse",
    ],
  },
  pro: {
    multiOrg: true,
    sso: true,
    thoroughDiscourse: true,
    prove: true,
    crossRepo: true,
    langfuse: true,
    byok: true,
    enterpriseConnectors: true,
    maxSeats: 100,
    features: [
      "gate",
      "steward",
      "graph",
      "sarif",
      "cli",
      "webhooks",
      "analytics",
      "sso",
      "prove",
      "langfuse",
      "multi_org",
      "cross_repo",
      "byok",
      "enterprise_connectors",
      "thorough_discourse",
    ],
  },
  enterprise: {
    multiOrg: true,
    sso: true,
    thoroughDiscourse: true,
    prove: true,
    crossRepo: true,
    langfuse: true,
    byok: true,
    enterpriseConnectors: true,
    maxSeats: 10_000,
    features: [
      "gate",
      "steward",
      "graph",
      "sarif",
      "cli",
      "webhooks",
      "analytics",
      "scim",
      "audit",
      "byok",
      "sso",
      "prove",
      "langfuse",
      "multi_org",
      "cross_repo",
      "enterprise_connectors",
      "thorough_discourse",
    ],
  },
};

export type ParseKeyResult =
  | { ok: true; entitlements: Partial<LicenseEntitlements>; signatureValid: boolean }
  | { ok: false; reason: string };

export function licenseFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.STEW_LICENSE_FILE?.trim() ||
    `${env.STEW_DATA_DIR ?? ".steward-data"}/license.key`
  );
}

/**
 * Parse a license key blob. When STEW_LICENSE_HMAC is set, key must be body.sig.
 */
export function parseLicenseKey(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ParseKeyResult {
  if (!raw?.trim()) return { ok: false, reason: "empty" };
  const hmac = env.STEW_LICENSE_HMAC?.trim();
  let payload = raw.trim();
  let signatureValid = false;

  if (hmac) {
    if (!payload.includes(".")) {
      return {
        ok: false,
        reason: "HMAC configured but license key is unsigned (expected body.sig)",
      };
    }
    const dot = payload.lastIndexOf(".");
    const body = payload.slice(0, dot);
    const sig = payload.slice(dot + 1);
    if (!body || !sig) {
      return { ok: false, reason: "malformed signed license key" };
    }
    const expected = createHmac("sha256", hmac).update(body).digest("base64url");
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, reason: "invalid license signature" };
      }
      signatureValid = true;
      payload = body;
    } catch {
      return { ok: false, reason: "signature verification failed" };
    }
  }

  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return {
      ok: true,
      entitlements: JSON.parse(json) as Partial<LicenseEntitlements>,
      signatureValid,
    };
  } catch {
    try {
      return {
        ok: true,
        entitlements: JSON.parse(payload) as Partial<LicenseEntitlements>,
        signatureValid,
      };
    } catch {
      return { ok: false, reason: "license key is not valid JSON/base64url" };
    }
  }
}

/** Expand features[] into boolean entitlement fields (license carries features). */
export function expandFeatures(
  partial: Partial<LicenseEntitlements>,
  tierDefaults: (typeof TIER_DEFAULTS)[LicenseTier],
): typeof TIER_DEFAULTS.oss {
  const features = partial.features ?? tierDefaults.features;
  const fromList = Array.isArray(partial.features);
  const has = (id: string) => features.includes(id);
  const flag = (
    explicit: boolean | undefined,
    featureId: string,
    tierDefault: boolean,
  ): boolean => {
    if (typeof explicit === "boolean") return explicit;
    if (fromList) return has(featureId);
    return tierDefault;
  };
  return {
    multiOrg: flag(partial.multiOrg, "multi_org", tierDefaults.multiOrg),
    sso: flag(partial.sso, "sso", tierDefaults.sso),
    thoroughDiscourse: flag(
      partial.thoroughDiscourse,
      "thorough_discourse",
      tierDefaults.thoroughDiscourse,
    ),
    prove: flag(partial.prove, "prove", tierDefaults.prove),
    crossRepo: flag(partial.crossRepo, "cross_repo", tierDefaults.crossRepo),
    langfuse: flag(partial.langfuse, "langfuse", tierDefaults.langfuse),
    byok: flag(partial.byok, "byok", tierDefaults.byok),
    enterpriseConnectors: flag(
      partial.enterpriseConnectors,
      "enterprise_connectors",
      tierDefaults.enterpriseConnectors,
    ),
    maxSeats: partial.maxSeats ?? tierDefaults.maxSeats,
    features: [...features],
  };
}

function fromParsed(
  fromKey: Partial<LicenseEntitlements>,
  env: NodeJS.ProcessEnv,
  source: LicenseEntitlements["source"],
  signatureValid: boolean,
): LicenseEntitlements {
  const enforced =
    env.STEW_LICENSE_ENFORCE === "1" || env.NODE_ENV === "production";
  const signatureRequired = Boolean(env.STEW_LICENSE_HMAC?.trim());
  const tier = (fromKey.tier as LicenseTier) || (env.STEW_LICENSE_TIER as LicenseTier) || "oss";
  const tierDefaults = TIER_DEFAULTS[tier] ?? TIER_DEFAULTS.oss;

  if (fromKey.validUntil && new Date(fromKey.validUntil).getTime() < Date.now()) {
    return {
      ...TIER_DEFAULTS.oss,
      tier: "oss",
      source,
      enforced,
      signatureRequired,
      signatureValid,
      status: "expired",
      validUntil: fromKey.validUntil,
      customer: fromKey.customer,
      orgId: fromKey.orgId,
    };
  }

  const expanded = expandFeatures(fromKey, tierDefaults);
  return {
    ...expanded,
    tier,
    source,
    enforced,
    signatureRequired,
    signatureValid,
    validUntil: fromKey.validUntil,
    customer: fromKey.customer,
    orgId: fromKey.orgId,
    status: "active",
  };
}

/** Synchronous resolve using only env (no file IO). Prefer resolveLicenseAsync. */
export function resolveLicense(env: NodeJS.ProcessEnv = process.env): LicenseEntitlements {
  return resolveLicenseFromKey(env.STEW_LICENSE_KEY, env, "key");
}

function resolveLicenseFromKey(
  key: string | undefined,
  env: NodeJS.ProcessEnv,
  sourceIfKey: LicenseEntitlements["source"],
): LicenseEntitlements {
  const tier = (env.STEW_LICENSE_TIER as LicenseTier) || "oss";
  const enforced =
    env.STEW_LICENSE_ENFORCE === "1" || env.NODE_ENV === "production";
  const signatureRequired = Boolean(env.STEW_LICENSE_HMAC?.trim());
  const base: LicenseEntitlements = {
    ...(TIER_DEFAULTS[tier] ?? TIER_DEFAULTS.oss),
    tier,
    source: env.STEW_LICENSE_TIER ? "env" : "default",
    enforced,
    signatureRequired,
    status: "active",
  };

  const parsed = parseLicenseKey(key, env);
  if (!parsed.ok) {
    if (signatureRequired && key?.trim()) {
      return {
        ...TIER_DEFAULTS.oss,
        tier: "oss",
        source: "default",
        enforced: true,
        signatureRequired,
        signatureValid: false,
        status: parsed.reason,
      };
    }
    if (signatureRequired && !key?.trim()) {
      return {
        ...TIER_DEFAULTS.oss,
        tier: "oss",
        source: "default",
        enforced: true,
        signatureRequired,
        signatureValid: false,
        status: "no_license",
      };
    }
    return base;
  }
  return fromParsed(parsed.entitlements, env, sourceIfKey, parsed.signatureValid);
}

/** Load uploaded license file if present. */
export async function readLicenseFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const raw = await readFile(licenseFilePath(env), "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveLicenseAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LicenseEntitlements> {
  const fileKey = await readLicenseFile(env);
  if (fileKey) {
    const lic = resolveLicenseFromKey(fileKey, env, "file");
    return {
      ...lic,
      source: lic.source === "default" ? "file" : lic.source === "key" ? "file" : lic.source,
    };
  }
  return resolveLicense(env);
}

export async function installLicenseKey(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; license: LicenseEntitlements } | { ok: false; error: string }> {
  const parsed = parseLicenseKey(raw, env);
  if (!parsed.ok) {
    return { ok: false, error: parsed.reason };
  }
  const path = licenseFilePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw.trim() + "\n", "utf8");
  // Also set process env so sync resolveLicense picks it up in this process
  process.env.STEW_LICENSE_KEY = raw.trim();
  const license = await resolveLicenseAsync(env);
  return { ok: true, license };
}

export async function clearInstalledLicense(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    await unlink(licenseFilePath(env));
  } catch {
    /* ignore missing */
  }
  if (process.env.STEW_LICENSE_KEY) {
    delete process.env.STEW_LICENSE_KEY;
  }
}

export function assertEntitled(
  license: LicenseEntitlements,
  feature: string,
): boolean {
  if (!license.enforced) return true;
  const bag = license as unknown as Record<string, unknown>;
  if (feature in bag && typeof bag[feature] === "boolean") {
    return Boolean(bag[feature]);
  }
  // Map camelCase feature names to catalog ids
  const aliases: Record<string, string> = {
    thoroughDiscourse: "thorough_discourse",
    multiOrg: "multi_org",
    crossRepo: "cross_repo",
    enterpriseConnectors: "enterprise_connectors",
  };
  const id = aliases[feature] ?? feature;
  return license.features.includes(id) || license.features.includes(feature);
}

export function requireEntitled(feature: string, env?: NodeJS.ProcessEnv): void {
  // Sync path — uses env/process STEW_LICENSE_KEY (set on install)
  const lic = resolveLicense(env);
  if (!assertEntitled(lic, feature)) {
    throw Object.assign(
      new Error(`license does not include feature: ${feature} (tier=${lic.tier})`),
      { status: 402, code: "LICENSE_REQUIRED", feature, tier: lic.tier },
    );
  }
}

export function isEntitled(feature: string, env?: NodeJS.ProcessEnv): boolean {
  return assertEntitled(resolveLicense(env), feature);
}

/** Build a signed commercial license key (vendor tooling / tests). */
export function signLicenseKey(
  entitlements: Partial<LicenseEntitlements>,
  hmacSecret: string,
): string {
  const body = Buffer.from(JSON.stringify(entitlements), "utf8").toString("base64url");
  const sig = createHmac("sha256", hmacSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Build an unsigned license key (self-host when HMAC not required). */
export function encodeLicenseKey(entitlements: Partial<LicenseEntitlements>): string {
  return Buffer.from(JSON.stringify(entitlements), "utf8").toString("base64url");
}

export function featureMatrix(license: LicenseEntitlements): Array<{
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}> {
  const bag = license as unknown as Record<string, unknown>;
  return FEATURE_CATALOG.map((f) => {
    let enabled = license.features.includes(f.id);
    if (f.booleanKey && typeof bag[f.booleanKey] === "boolean") {
      enabled = Boolean(bag[f.booleanKey]);
    }
    return {
      id: f.id,
      label: f.label,
      description: f.description,
      enabled,
    };
  });
}
