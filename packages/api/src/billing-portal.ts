/**
 * SaaS billing portal — product issues short-lived HMAC tokens; browser opens
 * STEW_BILLING_PUBLIC_URL/portal?token=… on the private control plane.
 */
import { createHmac } from "node:crypto";

export function isBillingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.STEW_BILLING_URL?.trim());
}

export function billingPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.STEW_BILLING_PUBLIC_URL?.trim() ||
    env.STEW_BILLING_URL?.trim() ||
    "http://127.0.0.1:8095"
  ).replace(/\/$/, "");
}

function portalSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.STEW_BILLING_PORTAL_SECRET?.trim() ||
    env.STEW_BILLING_TOKEN?.trim() ||
    ""
  );
}

export function signBillingPortalToken(
  claims: {
    orgId: string;
    orgName?: string;
    userId: string;
    email?: string;
    role?: string;
    expSeconds?: number;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = portalSecret(env);
  if (!secret) {
    throw Object.assign(new Error("billing portal secret not configured"), {
      status: 503,
      code: "BILLING_PORTAL_MISCONFIGURED",
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    orgId: claims.orgId,
    orgName: claims.orgName,
    userId: claims.userId,
    email: claims.email,
    role: claims.role,
    iat: now,
    exp: now + (claims.expSeconds ?? 60 * 60),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function buildBillingPortalUrl(
  token: string,
  returnTo?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = billingPublicUrl(env);
  const q = new URLSearchParams({ token });
  if (returnTo) q.set("returnTo", returnTo);
  return `${base}/portal?${q.toString()}`;
}

/** Fetch public plan catalog from control plane (M2M). */
export async function fetchBillingPlans(
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  Array<{
    id: string;
    label: string;
    description?: string;
    priceLabel?: string;
    highlights?: string[];
  }>
> {
  const url = env.STEW_BILLING_URL?.trim();
  if (!url) return [];
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/plans`, {
      headers: {
        Accept: "application/json",
        ...(env.STEW_BILLING_TOKEN
          ? { Authorization: `Bearer ${env.STEW_BILLING_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(Number(env.STEW_BILLING_TIMEOUT_MS ?? 3000)),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      plans?: Array<{
        id: string;
        label: string;
        description?: string;
        priceLabel?: string;
        highlights?: string[];
      }>;
    };
    return body.plans ?? [];
  } catch {
    return [];
  }
}

export async function putOrgSubscription(
  orgId: string,
  body: {
    planId: string;
    seats?: number;
    customerName?: string;
    billingEmail?: string;
    status?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const url = env.STEW_BILLING_URL?.trim();
  if (!url) return false;
  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/v1/orgs/${encodeURIComponent(orgId)}/subscription`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(env.STEW_BILLING_TOKEN
            ? { Authorization: `Bearer ${env.STEW_BILLING_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(env.STEW_BILLING_TIMEOUT_MS ?? 5000)),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
