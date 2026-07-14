/**
 * Resolve the active org for a request with membership enforcement.
 */
import type { Context } from "hono";
import { getTenancyStore, type OrgRole } from "./tenancy/orgs.js";

export async function resolveActiveOrgId(
  c: Context,
  opts?: { minRole?: OrgRole; required?: boolean },
): Promise<string> {
  const store = getTenancyStore();
  await store.ensureDefaults();
  const header = (c.get("orgId") as string | undefined) ?? c.req.header("X-Org-Id") ?? c.req.header("x-org-id");
  const user = c.get("user") as { id?: string; orgId?: string } | undefined;
  const authMode = c.get("authMode") as string | undefined;
  const requested = header ?? user?.orgId ?? "local";

  try {
    await store.assertMembership(user?.id, requested, {
      authMode,
      minRole: opts?.minRole,
    });
    c.set("orgId", requested);
    return requested;
  } catch (err) {
    if (opts?.required === false && authMode === "dev_open") {
      c.set("orgId", requested);
      return requested;
    }
    throw err;
  }
}

export function orgErrorResponse(c: Context, err: unknown) {
  const status = (err as { status?: number })?.status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  return c.json(
    {
      error: status === 403 ? "forbidden" : status === 401 ? "unauthorized" : "error",
      message,
    },
    status as 400 | 401 | 403 | 404 | 500,
  );
}
