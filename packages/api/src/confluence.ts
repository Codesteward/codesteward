/**
 * Confluence Cloud REST consumer (evidence / docs lookup).
 * Config via org connector type "confluence" or env:
 *   CONFLUENCE_URL, CONFLUENCE_TOKEN, CONFLUENCE_EMAIL, CONFLUENCE_SPACE
 */
import { globalConnectorsStore } from "./connectors-store.js";
import { decryptConfigSecrets } from "./connectors-file.js";

export interface ConfluenceConfig {
  baseUrl: string;
  token: string;
  email?: string;
  spaceKey?: string;
}

export interface ConfluencePageHit {
  id: string;
  title: string;
  spaceKey?: string;
  url?: string;
  excerpt?: string;
}

export async function resolveConfluenceConfig(
  orgId = "local",
): Promise<ConfluenceConfig | null> {
  await globalConnectorsStore.ensureLoaded();
  const row = await globalConnectorsStore.getAsync("confluence", orgId);
  if (row?.enabled !== false && row?.config) {
    const plain = decryptConfigSecrets(row.config);
    const baseUrl = String(plain.baseUrl ?? plain.url ?? "").replace(/\/$/, "");
    const token = String(plain.token ?? "");
    if (baseUrl && token) {
      return {
        baseUrl,
        token,
        email: plain.email ? String(plain.email) : plain.username ? String(plain.username) : undefined,
        spaceKey: plain.spaceKey ? String(plain.spaceKey) : undefined,
      };
    }
  }
  const baseUrl = (process.env.CONFLUENCE_URL ?? "").replace(/\/$/, "");
  const token = process.env.CONFLUENCE_TOKEN ?? "";
  if (!baseUrl || !token) return null;
  return {
    baseUrl,
    token,
    email: process.env.CONFLUENCE_EMAIL,
    spaceKey: process.env.CONFLUENCE_SPACE,
  };
}

function authHeader(cfg: ConfluenceConfig): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "codesteward-review",
  };
  if (cfg.email) {
    const basic = Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");
    h.Authorization = `Basic ${basic}`;
  } else {
    h.Authorization = `Bearer ${cfg.token}`;
  }
  return h;
}

/** CQL search — returns page hits for evidence grounding. */
export async function searchConfluencePages(
  query: string,
  opts: { orgId?: string; limit?: number } = {},
): Promise<{ ok: boolean; pages: ConfluencePageHit[]; error?: string }> {
  const cfg = await resolveConfluenceConfig(opts.orgId ?? "local");
  if (!cfg) {
    return {
      ok: false,
      pages: [],
      error: "Confluence not configured (connector or CONFLUENCE_URL/TOKEN)",
    };
  }
  const limit = opts.limit ?? 5;
  // Escape backslash first, then double-quotes for CQL string literals
  const safeQuery = query
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .slice(0, 120);
  const cqlParts = [`type=page`, `text ~ "${safeQuery}"`];
  if (cfg.spaceKey) cqlParts.unshift(`space="${cfg.spaceKey}"`);
  const cql = cqlParts.join(" AND ");
  const url = `${cfg.baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=space,body.view`;
  try {
    const res = await fetch(url, { headers: authHeader(cfg), signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, pages: [], error: `Confluence ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as {
      results?: Array<{
        id: string;
        title: string;
        _links?: { webui?: string; base?: string };
        space?: { key?: string };
        body?: { view?: { value?: string } };
      }>;
    };
    const pages: ConfluencePageHit[] = (json.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      spaceKey: r.space?.key,
      url: r._links?.webui
        ? `${cfg.baseUrl}/wiki${r._links.webui}`
        : undefined,
      excerpt: r.body?.view?.value
        ? stripHtml(r.body.view.value).slice(0, 400)
        : undefined,
    }));
    return { ok: true, pages };
  } catch (err) {
    return {
      ok: false,
      pages: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getConfluencePage(
  pageId: string,
  orgId = "local",
): Promise<{ ok: boolean; title?: string; body?: string; url?: string; error?: string }> {
  const cfg = await resolveConfluenceConfig(orgId);
  if (!cfg) return { ok: false, error: "Confluence not configured" };
  const url = `${cfg.baseUrl}/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,space`;
  try {
    const res = await fetch(url, { headers: authHeader(cfg), signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      return { ok: false, error: `Confluence ${res.status}` };
    }
    const json = (await res.json()) as {
      title?: string;
      body?: { storage?: { value?: string } };
      _links?: { webui?: string };
    };
    return {
      ok: true,
      title: json.title,
      body: json.body?.storage?.value
        ? stripHtml(json.body.storage.value).slice(0, 8000)
        : undefined,
      url: json._links?.webui ? `${cfg.baseUrl}/wiki${json._links.webui}` : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stripHtml(html: string): string {
  // Allow optional whitespace before the closing `>` so tags like </script > are stripped
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
