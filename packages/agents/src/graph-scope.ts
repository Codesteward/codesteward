/**
 * Graph MCP multi-tenant scope.
 *
 * Codesteward Graph stores structure under (tenant_id, repo_id). Historically we
 * passed job.tenantId (often "local"), so all product orgs shared one graph
 * namespace. Product orgId must be the graph tenant for multi-tenant safety.
 */
import { sanitizeOrgSegment } from "./path-jail.js";

/** Graph tenant_id for a product organization. */
export function graphTenantId(orgId?: string | null, fallbackTenantId?: string | null): string {
  const org = (orgId ?? "").trim();
  if (org) return sanitizeOrgSegment(org);
  const t = (fallbackTenantId ?? "").trim();
  return t || "local";
}

export interface GraphToolScope {
  /** Graph tenant_id (= product org when multi-tenant) */
  tenantId: string;
  /** Primary repo under review */
  repoId: string;
  /**
   * Repos this session may query (primary + cross-repo fan-out).
   * When set, graph_query may not use arbitrary repoIds.
   */
  allowedRepoIds?: string[];
  /**
   * Host path of the session workspace (clone root). When set, graph_rebuild
   * refuses repo_path outside this tree (blocks indexing another org's clone).
   */
  workspaceRoot?: string;
}
