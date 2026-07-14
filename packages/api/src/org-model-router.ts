/**
 * Build a ModelRouter bound to one product org's model matrix + BYOK keys.
 * Host env is fallback only (single-tenant / bootstrap) — never use another
 * org's matrix, and never invent provider keys from a random global default
 * when the org has configured its own.
 */
import {
  createModelRouter,
  loadEnvModelConfig,
  mergeRoleOverrides,
  resolveModelForRole,
  type EnvModelConfig,
  type ModelRouter,
} from "@codesteward/model-router";
import type { AgentRole } from "@codesteward/core";
import type { ModelRole } from "@codesteward/model-router";
import { loadOrgMatrixForRuntime } from "./org-settings-store.js";

export interface OrgModelRouterResult {
  router: ModelRouter;
  config: EnvModelConfig;
  orgId: string;
  /** True when org matrix was loaded (even if empty); false on hard failure → env only */
  fromOrgMatrix: boolean;
}

export async function createOrgModelRouter(
  orgId: string,
  opts?: {
    sessionId?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<OrgModelRouterResult> {
  const env = opts?.env ?? process.env;
  const base = loadEnvModelConfig(env);
  let fromOrgMatrix = false;
  let config = base;
  try {
    const orgMatrix = await loadOrgMatrixForRuntime(orgId);
    config = mergeRoleOverrides(base, orgMatrix);
    fromOrgMatrix = true;
  } catch (err) {
    console.warn(
      `[org-model] matrix unavailable for org=${orgId}, env fallback only:`,
      err instanceof Error ? err.message : err,
    );
  }
  const router = createModelRouter(env, {
    config,
    sessionId: opts?.sessionId,
    orgId,
  });
  return { router, config, orgId, fromOrgMatrix };
}

/** Resolve which model string a role would use for this org (diagnostics). */
export function resolveOrgRoleModel(
  config: EnvModelConfig,
  role: ModelRole | AgentRole | string,
): string {
  return resolveModelForRole(role as ModelRole, config).model;
}
