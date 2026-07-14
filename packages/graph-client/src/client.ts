import type { CrossRepoLink } from "@codesteward/core";
import {
  mockAugment,
  mockQuery,
  mockRebuild,
  mockStatus,
} from "./mock.js";
import type {
  GraphAugmentAddition,
  GraphAugmentResult,
  GraphClientOptions,
  GraphQueryResult,
  GraphQueryType,
  GraphRebuildResult,
  GraphStatus,
  RepoScope,
} from "./types.js";

type JsonRpcResult = {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { message: string; code?: number };
};

/**
 * Host header for MCP Python SSE DNS-rebinding protection.
 * Compose service names (`graph-mcp:3000`) return 421 "Invalid Host header".
 * Only `127.0.0.1` / `localhost` are accepted — even Docker bridge IPs fail.
 * Override with GRAPH_MCP_HOST_HEADER (e.g. `127.0.0.1:3000`).
 *
 * Note: global fetch/undici forbids setting `Host`; use nodeHttpFetch when set.
 */
function resolveSseHostHeader(sseUrl: string): string | undefined {
  const override = process.env.GRAPH_MCP_HOST_HEADER?.trim();
  if (override) return override;
  try {
    const u = new URL(sseUrl);
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") {
      return undefined;
    }
    // Docker DNS / bridge IPs / single-label hosts all need localhost Host
    return `127.0.0.1:${u.port || "80"}`;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Minimal fetch using node:http(s) so we can set Host (forbidden in undici fetch).
 * Enough for MCP SSE GET stream + JSON POST.
 */
async function nodeHttpFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const { request: httpRequest } = await import("node:http");
  const { request: httpsRequest } = await import("node:https");
  const url = new URL(typeof input === "string" ? input : input.href);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = new Headers(init.headers as Headers);
    h.forEach((v, k) => {
      headers[k] = v;
    });
  }
  const body =
    init?.body == null
      ? undefined
      : typeof init.body === "string"
        ? init.body
        : Buffer.from(
            await new Response(init.body as unknown as Blob).arrayBuffer(),
          );

  const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
  const signal = init?.signal ?? undefined;

  return new Promise<Response>((resolve, reject) => {
    const req = lib(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        const nodeStream = res;
        const webStream = new ReadableStream<Uint8Array>({
          start(controller) {
            nodeStream.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on("end", () => controller.close());
            nodeStream.on("error", (err) => controller.error(err));
          },
          cancel() {
            nodeStream.destroy();
          },
        });
        const hdrs = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          if (Array.isArray(v)) for (const item of v) hdrs.append(k, item);
          else hdrs.set(k, v);
        }
        resolve(
          new Response(webStream, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: hdrs,
          }),
        );
      },
    );
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          req.destroy();
        },
        { once: true },
      );
    }
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Client for Codesteward Graph MCP.
 *
 * Transports:
 * - **http** (streamable HTTP): POST JSON-RPC to `/mcp`
 * - **sse** (classic MCP SSE): GET `/sse` → POST `/messages/?session_id=…`
 * - **stdio**: not implemented (use GRAPH_MCP_URL)
 *
 * Auto-detects SSE when base URL ends with `/sse` or when POST `/mcp` returns 404.
 * Set GRAPH_MOCK=1 for offline demo mode.
 */
export class GraphClient {
  readonly baseUrl: string;
  readonly transport: "http" | "sse" | "stdio" | "auto";
  readonly defaultTenantId: string;
  readonly defaultRepoId: string;
  readonly mock: boolean;
  private readonly fetchImpl: typeof fetch;
  private rpcId = 1;

  /** Lazy SSE session (reused across tool calls). */
  private sse: SseMcpSession | null = null;
  private resolvedTransport: "http" | "sse" | null = null;

  constructor(opts: GraphClientOptions = {}) {
    let base = (
      opts.baseUrl ??
      process.env.GRAPH_MCP_URL ??
      "http://localhost:3000/sse"
    ).replace(/\/$/, "");
    // Codesteward Graph Docker image defaults to TRANSPORT=sse; /mcp 404s.
    if (base.endsWith("/mcp") && (opts.transport === "sse" || opts.transport === "auto" || !opts.transport)) {
      // Prefer SSE endpoint when still on auto (avoid hard 404 probe failures in logs)
      if (process.env.GRAPH_FORCE_HTTP !== "1") {
        base = base.replace(/\/mcp$/i, "/sse");
      }
    }
    this.baseUrl = base;
    this.transport =
      opts.transport ??
      (this.baseUrl.endsWith("/sse") ? "sse" : "auto");
    this.defaultTenantId = opts.tenantId ?? process.env.DEFAULT_TENANT_ID ?? "local";
    this.defaultRepoId = opts.repoId ?? process.env.DEFAULT_REPO_ID ?? "codesteward";
    this.mock =
      opts.mock ??
      (process.env.GRAPH_MOCK === "1" || process.env.GRAPH_MOCK === "true");
    // Prefer caller fetch; otherwise use node:http when Host rewrite is required
    // (MCP SSE DNS rebinding + Docker service names).
    if (opts.fetchImpl) {
      this.fetchImpl = opts.fetchImpl;
    } else if (resolveSseHostHeader(this.baseUrl)) {
      this.fetchImpl = nodeHttpFetch as unknown as typeof fetch;
    } else {
      this.fetchImpl = fetch;
    }
  }

  private scope(overrides?: Partial<RepoScope>): RepoScope {
    return {
      tenantId: overrides?.tenantId ?? this.defaultTenantId,
      repoId: overrides?.repoId ?? this.defaultRepoId,
    };
  }

  async status(scope?: Partial<RepoScope>): Promise<GraphStatus> {
    const s = this.scope(scope);
    if (this.mock) return mockStatus(s);
    return this.callTool<GraphStatus>("graph_status", {
      tenant_id: s.tenantId,
      repo_id: s.repoId,
    });
  }

  async rebuild(opts?: {
    repoPath?: string;
    changedFiles?: string[];
    tenantId?: string;
    repoId?: string;
  }): Promise<GraphRebuildResult> {
    const s = this.scope(opts);
    if (this.mock) return mockRebuild(s);
    return this.callTool<GraphRebuildResult>("graph_rebuild", {
      tenant_id: s.tenantId,
      repo_id: s.repoId,
      repo_path: opts?.repoPath,
      changed_files: opts?.changedFiles,
    });
  }

  async query(
    queryType: GraphQueryType,
    query = "",
    opts?: Partial<RepoScope> & { limit?: number },
  ): Promise<GraphQueryResult> {
    const s = this.scope(opts);
    if (this.mock) return mockQuery(queryType, query, s);
    return this.callTool<GraphQueryResult>("codebase_graph_query", {
      query_type: queryType,
      query,
      tenant_id: s.tenantId,
      repo_id: s.repoId,
      limit: opts?.limit ?? 100,
    });
  }

  async augment(
    agentId: string,
    additions: GraphAugmentAddition[],
    scope?: Partial<RepoScope>,
  ): Promise<GraphAugmentResult> {
    const s = this.scope(scope);
    if (this.mock) return mockAugment(additions.length);
    return this.callTool<GraphAugmentResult>("graph_augment", {
      agent_id: agentId,
      additions,
      tenant_id: s.tenantId,
      repo_id: s.repoId,
    });
  }

  async queryAcross(
    links: CrossRepoLink[],
    queryType: GraphQueryType,
    query = "",
    opts?: { limit?: number; fromRepoId?: string },
  ): Promise<Array<GraphQueryResult & { repoId: string }>> {
    const repoIds = new Set<string>();
    if (opts?.fromRepoId) repoIds.add(opts.fromRepoId);
    for (const link of links) {
      if (!link.enabled) continue;
      repoIds.add(link.fromRepoId);
      repoIds.add(link.toRepoId);
    }
    const out: Array<GraphQueryResult & { repoId: string }> = [];
    for (const repoId of repoIds) {
      const result = await this.query(queryType, query, {
        repoId,
        limit: opts?.limit,
      });
      out.push({ ...result, repoId });
    }
    return out;
  }

  private async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (this.transport === "stdio") {
      throw new Error(
        "stdio transport requires a local process bridge; use GRAPH_MCP_URL (http or sse)",
      );
    }

    const mode = await this.resolveTransport();
    if (mode === "sse") {
      return this.callToolSse<T>(name, args);
    }
    return this.callToolHttp<T>(name, args);
  }

  private async resolveTransport(): Promise<"http" | "sse"> {
    if (this.resolvedTransport) return this.resolvedTransport;
    if (this.transport === "sse" || this.baseUrl.endsWith("/sse")) {
      this.resolvedTransport = "sse";
      return "sse";
    }
    if (this.transport === "http") {
      this.resolvedTransport = "http";
      return "http";
    }
    // auto: probe streamable HTTP first
    try {
      const mcpUrl = this.baseUrl.endsWith("/mcp")
        ? this.baseUrl
        : `${this.baseUrl.replace(/\/sse$/, "")}/mcp`;
      const res = await this.fetchImpl(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "codesteward-review", version: "0.1.0" },
          },
        }),
      });
      if (res.ok || res.status === 202 || res.status === 400) {
        // 400 may still mean endpoint exists (bad body shape)
        this.resolvedTransport = "http";
        this.baseUrlHttp = mcpUrl;
        return "http";
      }
      if (res.status === 404 || res.status === 405) {
        this.resolvedTransport = "sse";
        return "sse";
      }
    } catch {
      /* fall through to SSE */
    }
    this.resolvedTransport = "sse";
    return "sse";
  }

  /** Resolved streamable-http URL when auto-probed. */
  private baseUrlHttp: string | null = null;

  private async callToolHttp<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const url =
      this.baseUrlHttp ??
      (this.baseUrl.endsWith("/mcp") ? this.baseUrl : `${this.baseUrl}/mcp`);

    const rpcBody = {
      jsonrpc: "2.0",
      id: this.rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    };

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(rpcBody),
    });

    if (res.ok) {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) {
        const text = await res.text();
        const data = parseSseJsonPayloads(text).find(
          (p) => p && typeof p === "object" && "result" in (p as object),
        ) as JsonRpcResult | undefined;
        if (data) return unwrapToolResult<T>(data, name);
      } else {
        const data = (await res.json()) as JsonRpcResult;
        return unwrapToolResult<T>(data, name);
      }
    }

    // REST fallback
    const toolsUrl = url.replace(/\/mcp$/, "") + `/tools/${name}`;
    const res2 = await this.fetchImpl(toolsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res2.ok) {
      const t = await res2.text();
      throw new Error(
        `graph tool ${name} failed: ${res.status} on ${url}; REST ${res2.status} ${t.slice(0, 200)}. ` +
          `Hint: Codesteward Graph with TRANSPORT=sse needs GRAPH_MCP_URL ending in /sse (or set TRANSPORT=http).`,
      );
    }
    return (await res2.json()) as T;
  }

  private async callToolSse<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.sse) {
      const sseRoot = this.baseUrl.endsWith("/sse")
        ? this.baseUrl
        : this.baseUrl.replace(/\/mcp$/, "") + "/sse";
      const hostHeader = resolveSseHostHeader(sseRoot);
      // Ensure Host rewrite can actually be sent (undici forbids Host on fetch)
      const fetchImpl =
        hostHeader && this.fetchImpl === fetch
          ? (nodeHttpFetch as unknown as typeof fetch)
          : this.fetchImpl;
      this.sse = new SseMcpSession(sseRoot, fetchImpl, hostHeader);
      await this.sse.connect();
    }
    const data = await this.sse.request("tools/call", {
      name,
      arguments: args,
    });
    return unwrapToolResult<T>(data, name);
  }
}

function unwrapToolResult<T>(data: JsonRpcResult, name: string): T {
  if (data.error) {
    throw new Error(`graph tool ${name}: ${data.error.message}`);
  }
  if (data.result?.structuredContent) {
    return data.result.structuredContent as T;
  }
  // Some MCP servers put a plain string in result
  if (typeof (data as { result?: unknown }).result === "string") {
    return coerceToolPayload(String((data as { result: string }).result), name) as T;
  }
  const text = data.result?.content?.find((c) => c.type === "text")?.text;
  if (text) {
    return coerceToolPayload(text, name) as T;
  }
  if (data.result && typeof data.result === "object" && !("content" in data.result)) {
    return data.result as T;
  }
  throw new Error(`graph tool ${name}: empty MCP result`);
}

/** Parse JSON or simple YAML-like key: value tool output into an object. */
function coerceToolPayload(text: string, name: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* yaml-ish */
  }
  // graph_status often returns:
  // edges: null
  // last_build: null
  // neo4j_connected: false
  if (trimmed.includes(":") && !trimmed.startsWith("{")) {
    const obj: Record<string, unknown> = {};
    for (const line of trimmed.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1]!;
      let val: unknown = m[2]!.trim();
      if (val === "null" || val === "None") val = null;
      else if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      obj[key] = val;
    }
    // Normalize Codesteward field aliases
    if ("neo4j_connected" in obj && !("backend_connected" in obj)) {
      obj.backend_connected = obj.neo4j_connected;
    }
    if ("nodes" in obj && (obj.nodes === null || typeof obj.nodes !== "object")) {
      obj.nodes = obj.nodes == null ? null : { total: Number(obj.nodes) || null };
    }
    if ("edges" in obj && (obj.edges === null || typeof obj.edges !== "object")) {
      obj.edges = obj.edges == null ? null : { total: Number(obj.edges) || null };
    }
    return obj;
  }
  return { raw: text, tool: name };
}

function parseSseJsonPayloads(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const block of raw.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    try {
      out.push(JSON.parse(payload));
    } catch {
      /* ignore non-JSON */
    }
  }
  return out;
}

/**
 * Classic MCP SSE client: GET /sse for endpoint + event stream, POST /messages for requests.
 */
class SseMcpSession {
  private messageUrl: string | null = null;
  private pending = new Map<
    number,
    { resolve: (v: JsonRpcResult) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private abort: AbortController | null = null;
  private buffer = "";
  private ready: Promise<void> | null = null;
  /** True only after open() fully finishes (endpoint + initialize). */
  private sessionReady = false;
  private closed = false;

  constructor(
    private readonly sseUrl: string,
    private readonly fetchImpl: typeof fetch,
    private readonly hostHeader?: string,
  ) {}

  async connect(): Promise<void> {
    if (this.sessionReady) return;
    if (this.ready) return this.ready;
    this.ready = this.open();
    try {
      await this.ready;
      this.sessionReady = true;
    } catch (err) {
      this.ready = null;
      throw err;
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.hostHeader) h.Host = this.hostHeader;
    return h;
  }

  private async open(): Promise<void> {
    this.abort = new AbortController();
    const res = await this.fetchImpl(this.sseUrl, {
      method: "GET",
      headers: this.headers({ Accept: "text/event-stream" }),
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(
        `graph SSE connect failed: ${res.status} ${this.sseUrl} — is graph-mcp running with TRANSPORT=sse?` +
          (res.status === 421
            ? " (Host rejected — set GRAPH_MCP_HOST_HEADER=127.0.0.1:3000 for Docker service names)"
            : ""),
      );
    }

    const origin = new URL(this.sseUrl).origin;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Read until we have the endpoint event, then continue reading in background
    const pump = async () => {
      try {
        while (!this.closed) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          this.consumeBuffer(origin);
        }
      } catch (err) {
        if (!this.closed) {
          for (const [, p] of this.pending) {
            p.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.pending.clear();
        }
      }
    };

    // Wait for endpoint (with timeout)
    const endpointWait = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("graph SSE: timed out waiting for endpoint event")),
        10_000,
      );
      const check = () => {
        if (this.messageUrl) {
          clearTimeout(t);
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      void pump().then(() => {
        if (!this.messageUrl) {
          clearTimeout(t);
          reject(new Error("graph SSE stream ended before endpoint"));
        }
      });
      check();
    });

    await endpointWait;

    // CRITICAL: request() must not re-enter connect()/open() during initialize.
    // Call requestInternal which only POSTs + waits for SSE reply.
    const init = await this.requestInternal("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codesteward-review", version: "0.1.0" },
    });
    if (init.error) {
      throw new Error(`graph SSE initialize failed: ${init.error.message}`);
    }
    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  }

  private consumeBuffer(origin: string) {
    // MCP SSE frames use CRLF (\r\n) on many servers — normalize first
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      const data = dataLines.join("\n");
      if (!data) continue;

      if (event === "endpoint") {
        const path = data.trim();
        this.messageUrl = path.startsWith("http")
          ? path
          : `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
        continue;
      }

      try {
        const msg = JSON.parse(data) as JsonRpcResult & { id?: number };
        if (msg.id != null && this.pending.has(Number(msg.id))) {
          const p = this.pending.get(Number(msg.id))!;
          this.pending.delete(Number(msg.id));
          p.resolve(msg);
        }
      } catch {
        /* non-JSON data frames */
      }
    }
  }

  private async post(body: unknown): Promise<Response> {
    if (!this.messageUrl) throw new Error("graph SSE: no message endpoint");
    const res = await this.fetchImpl(this.messageUrl, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    // MCP SSE often returns 202 Accepted; result arrives on the stream
    if (!res.ok && res.status !== 202) {
      const t = await res.text();
      throw new Error(`graph SSE POST ${res.status}: ${t.slice(0, 200)}`);
    }
    return res;
  }

  async request(method: string, params: unknown): Promise<JsonRpcResult> {
    await this.connect();
    return this.requestInternal(method, params);
  }

  /** POST JSON-RPC and wait for matching SSE message — does not call connect(). */
  private async requestInternal(
    method: string,
    params: unknown,
  ): Promise<JsonRpcResult> {
    if (!this.messageUrl) {
      throw new Error("graph SSE: no message endpoint (call after endpoint event)");
    }
    const id = this.nextId++;
    const result = new Promise<JsonRpcResult>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`graph SSE request timeout: ${method}`));
      }, 120_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
    await this.post({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    return result;
  }

  close() {
    this.closed = true;
    this.abort?.abort();
  }
}

export function createGraphClient(opts?: GraphClientOptions): GraphClient {
  return new GraphClient(opts);
}
