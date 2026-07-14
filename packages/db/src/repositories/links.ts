import { linkId, nowIso, type CrossRepoLink } from "@codesteward/core";
import type { Queryable } from "../client.js";
import { asRecord, jsonParam, toIso } from "../util.js";

interface LinkRow {
  id: string;
  org_id: string;
  from_repo_id: string;
  to_repo_id: string;
  edge_type: string;
  path_filters: unknown;
  from_repo_path: string | null;
  to_repo_path: string | null;
  hints: unknown;
  max_depth: number;
  token_budget: number;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapLink(row: LinkRow): CrossRepoLink {
  const pf = asRecord(row.path_filters);
  return {
    id: row.id,
    orgId: row.org_id,
    fromRepoId: row.from_repo_id,
    toRepoId: row.to_repo_id,
    edgeType: row.edge_type as CrossRepoLink["edgeType"],
    pathFilters: {
      from: Array.isArray(pf.from) ? (pf.from as string[]) : [],
      to: Array.isArray(pf.to) ? (pf.to as string[]) : [],
    },
    fromRepoPath: row.from_repo_path ?? undefined,
    toRepoPath: row.to_repo_path ?? undefined,
    hints: asRecord(row.hints) as CrossRepoLink["hints"],
    maxDepth: row.max_depth,
    tokenBudget: row.token_budget,
    enabled: row.enabled,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class LinksRepository {
  constructor(private readonly db: Queryable) {}

  async add(
    input: Omit<CrossRepoLink, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
    },
  ): Promise<CrossRepoLink> {
    const ts = nowIso();
    const link: CrossRepoLink = {
      id: input.id ?? linkId(),
      orgId: input.orgId ?? "local",
      fromRepoId: input.fromRepoId,
      toRepoId: input.toRepoId,
      edgeType: input.edgeType ?? "depends_on_api",
      pathFilters: input.pathFilters ?? { from: [], to: [] },
      fromRepoPath: input.fromRepoPath,
      toRepoPath: input.toRepoPath,
      hints: input.hints ?? {},
      maxDepth: input.maxDepth ?? 2,
      tokenBudget: input.tokenBudget ?? 50_000,
      enabled: input.enabled ?? true,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.db.query(
      `INSERT INTO cross_repo_links (
        id, org_id, from_repo_id, to_repo_id, edge_type, path_filters,
        from_repo_path, to_repo_path, hints, max_depth, token_budget, enabled,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6::jsonb,
        $7,$8,$9::jsonb,$10,$11,$12,
        $13,$14
      )
      ON CONFLICT (id) DO UPDATE SET
        org_id = EXCLUDED.org_id,
        from_repo_id = EXCLUDED.from_repo_id,
        to_repo_id = EXCLUDED.to_repo_id,
        edge_type = EXCLUDED.edge_type,
        path_filters = EXCLUDED.path_filters,
        from_repo_path = EXCLUDED.from_repo_path,
        to_repo_path = EXCLUDED.to_repo_path,
        hints = EXCLUDED.hints,
        max_depth = EXCLUDED.max_depth,
        token_budget = EXCLUDED.token_budget,
        enabled = EXCLUDED.enabled,
        updated_at = EXCLUDED.updated_at`,
      [
        link.id,
        link.orgId,
        link.fromRepoId,
        link.toRepoId,
        link.edgeType,
        jsonParam(link.pathFilters),
        link.fromRepoPath ?? null,
        link.toRepoPath ?? null,
        jsonParam(link.hints),
        link.maxDepth,
        link.tokenBudget,
        link.enabled,
        link.createdAt,
        link.updatedAt,
      ],
    );
    return link;
  }

  async get(id: string): Promise<CrossRepoLink | undefined> {
    const res = await this.db.query<LinkRow>(
      `SELECT * FROM cross_repo_links WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapLink(row) : undefined;
  }

  async list(orgId?: string): Promise<CrossRepoLink[]> {
    if (orgId) {
      const res = await this.db.query<LinkRow>(
        `SELECT * FROM cross_repo_links WHERE org_id = $1 ORDER BY created_at DESC`,
        [orgId],
      );
      return res.rows.map(mapLink);
    }
    const res = await this.db.query<LinkRow>(
      `SELECT * FROM cross_repo_links ORDER BY created_at DESC`,
    );
    return res.rows.map(mapLink);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM cross_repo_links WHERE id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
