/**
 * MCP stdio bridge — spawn `codesteward-mcp --transport stdio` and speak JSON-RPC
 * with Content-Length framing (MCP standard).
 *
 * Used so workers embed Graph MCP without a sidecar container or shared clone PVC.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export interface StdioBridgeOptions {
  /** Executable (default: GRAPH_MCP_COMMAND or codesteward-mcp) */
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Request timeout ms */
  timeoutMs?: number;
}

export interface ResolvedMcpSpawn {
  command: string;
  args: string[];
  /** How we resolved the binary (for logs / errors) */
  via: string;
}

function canExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fileExists(file: string): boolean {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

function pathLookup(name: string, envPath: string | undefined): string[] {
  if (!name || name.includes("/") || name.includes("\\")) return [];
  const dirs = (envPath ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.map((d) => join(d, name));
}

/**
 * Resolve how to spawn Graph MCP. Handles common deploy failures:
 * - bare `codesteward-mcp` not on PATH
 * - console script present but missing +x (EACCES) → run via venv python
 * - prefer absolute path from worker image: /opt/graph-venv/bin/codesteward-mcp
 */
export function resolveGraphMcpSpawn(opts?: {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}): ResolvedMcpSpawn {
  const env = { ...process.env, ...(opts?.env ?? {}) };
  const configured =
    (opts?.command ?? env.GRAPH_MCP_COMMAND ?? "codesteward-mcp").trim() ||
    "codesteward-mcp";
  const baseArgs =
    opts?.args ??
    (env.GRAPH_MCP_ARGS?.trim()
      ? env.GRAPH_MCP_ARGS.trim().split(/\s+/).filter(Boolean)
      : ["--transport", "stdio"]);

  // Absolute / relative candidates in preference order
  const candidates: string[] = [];
  const push = (p: string | undefined) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  push(configured);
  if (!isAbsolute(configured) && !configured.includes("/")) {
    for (const p of pathLookup(configured, env.PATH)) push(p);
  }
  // Worker image layout (Dockerfile.node)
  push("/opt/graph-venv/bin/codesteward-mcp");
  push(join(env.HOME ?? "", ".local/bin/codesteward-mcp"));

  for (const cand of candidates) {
    if (!fileExists(cand) && (isAbsolute(cand) || cand.includes("/"))) {
      continue;
    }
    // Bare name: let spawn PATH-resolve later if not found on disk
    if (!isAbsolute(cand) && !cand.includes("/") && !fileExists(cand)) {
      // keep as last-resort bare spawn
      continue;
    }
    if (canExecute(cand)) {
      return { command: cand, args: baseArgs, via: `executable:${cand}` };
    }
    // Exists but not +x (classic EACCES): run as Python script with sibling/venv python
    if (fileExists(cand)) {
      const dir = dirname(cand);
      const pyCandidates = [
        join(dir, "python3"),
        join(dir, "python"),
        "/opt/graph-venv/bin/python3",
        "/opt/graph-venv/bin/python",
        env.GRAPH_MCP_PYTHON,
        "python3",
      ].filter((x): x is string => Boolean(x));
      for (const py of pyCandidates) {
        if (isAbsolute(py) && !canExecute(py) && !fileExists(py)) continue;
        if (isAbsolute(py) && fileExists(py) && !canExecute(py)) continue;
        return {
          command: py,
          args: [cand, ...baseArgs],
          via: `python-script:${py} ${cand}`,
        };
      }
    }
  }

  // Module fallbacks (pip install codesteward-mcp)
  const moduleCandidates: ResolvedMcpSpawn[] = [
    {
      command: "/opt/graph-venv/bin/python",
      args: ["-m", "codesteward_mcp", ...baseArgs],
      via: "python-m:/opt/graph-venv/bin/python -m codesteward_mcp",
    },
    {
      command: "/opt/graph-venv/bin/python3",
      args: ["-m", "codesteward_mcp", ...baseArgs],
      via: "python-m:/opt/graph-venv/bin/python3 -m codesteward_mcp",
    },
    {
      command: "python3",
      args: ["-m", "codesteward_mcp", ...baseArgs],
      via: "python-m:python3 -m codesteward_mcp",
    },
  ];
  for (const m of moduleCandidates) {
    if (isAbsolute(m.command) && !canExecute(m.command)) continue;
    return m;
  }

  // Last resort: bare configured name (may still EACCES/ENOENT — error message will explain)
  return {
    command: configured,
    args: baseArgs,
    via: `bare:${configured}`,
  };
}

function formatSpawnError(err: unknown, resolved: ResolvedMcpSpawn): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const code = (err as NodeJS.ErrnoException)?.code;
  let hint = "";
  if (code === "EACCES") {
    hint =
      " Permission denied executing Graph MCP. Common cause: uv CPython under /root/.local is not readable " +
      "after dropping to uid 1001 (steward). Fix image: UV_PYTHON_INSTALL_DIR=/opt/uv-python and chmod a+rX, " +
      "or entrypoint o+rx on /root + o+rX on /root/.local/share/uv. " +
      "Also ensure GRAPH_MCP_COMMAND points at an executable under /opt/graph-venv.";
  } else if (code === "ENOENT") {
    hint =
      " Graph MCP binary not found. Install: pip/uv install 'codesteward-mcp[graph-all,graphqlite]' " +
      "or use the steward worker image (embeds /opt/graph-venv). Set GRAPH_MCP_COMMAND, or GRAPH_MOCK=1 for offline.";
  }
  return new Error(
    `spawn ${resolved.command} ${code ?? base.message} (via ${resolved.via}).${hint}`,
  );
}

export class McpStdioBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<number | string, Pending>();
  private nextId = 1;
  private started = false;
  private closed = false;
  private readonly commandHint: string | undefined;
  private readonly argsHint: string[] | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private resolved: ResolvedMcpSpawn | null = null;

  constructor(opts: StdioBridgeOptions = {}) {
    this.commandHint = opts.command;
    this.argsHint = opts.args;
    this.env = { ...process.env, ...(opts.env ?? {}), TRANSPORT: "stdio" };
    // Avoid structlog noise on stderr polluting diagnostics
    this.env.PYTHONUNBUFFERED = "1";
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.GRAPH_MCP_TIMEOUT_MS ?? 600_000);
  }

  async ensureStarted(): Promise<void> {
    if (this.started && this.child && !this.child.killed) return;
    if (this.closed) throw new Error("MCP stdio bridge is closed");

    this.resolved = resolveGraphMcpSpawn({
      command: this.commandHint,
      args: this.argsHint,
      env: this.env,
    });
    const { command, args, via } = this.resolved;
    console.info(`[graph-mcp] spawning ${command} ${args.join(" ")} (${via})`);

    this.child = spawn(command, args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("error", (err) => {
      this.failAll(formatSpawnError(err, this.resolved!));
      this.child = null;
      this.started = false;
    });
    this.child.on("exit", (code, signal) => {
      this.started = false;
      this.failAll(
        new Error(`graph MCP stdio exited code=${code} signal=${signal ?? ""}`),
      );
      this.child = null;
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // Log stderr but do not treat as protocol
    this.child.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8").trim();
      if (s) console.warn("[graph-mcp]", s.slice(0, 500));
    });

    // Initialize MCP session (short timeout — never block the worker job loop for rebuild timeouts)
    const initTimeoutMs =
      Number(process.env.GRAPH_MCP_INIT_TIMEOUT_MS ?? 20_000) || 20_000;
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "codesteward-review", version: "1.1.0" },
        },
        initTimeoutMs,
      );
      await this.notify("notifications/initialized", {});
      this.started = true;
      console.info(`[graph-mcp] stdio session ready (${via})`);
    } catch (err) {
      // Ensure spawn/init failures surface the enriched message
      if (this.child && !this.child.killed) {
        try {
          this.child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      this.child = null;
      this.started = false;
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted();
    const raw = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return raw;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("bridge closed"));
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.started = false;
  }

  private failAll(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      // Prefer Content-Length framing when present (LSP-style MCP)
      if (
        this.buf.length >= 15 &&
        this.buf.subarray(0, 14).toString("utf8").toLowerCase() === "content-length"
      ) {
        const headerEnd = this.buf.indexOf("\r\n\r\n");
        const altEnd = headerEnd < 0 ? this.buf.indexOf("\n\n") : headerEnd;
        if (altEnd < 0) return;
        const sepLen = headerEnd >= 0 ? 4 : 2;
        const header = this.buf.subarray(0, altEnd).toString("utf8");
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          // Malformed header — drop one line and continue
          const nl = this.buf.indexOf("\n");
          if (nl < 0) return;
          this.buf = this.buf.subarray(nl + 1);
          continue;
        }
        const len = Number(m[1]);
        const bodyStart = altEnd + sepLen;
        if (this.buf.length < bodyStart + len) return;
        const body = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
        this.buf = this.buf.subarray(bodyStart + len);
        this.handleMessage(body);
        continue;
      }

      // codesteward-mcp (and many MCP stdio servers): newline-delimited JSON (NDJSON)
      const lineEnd = this.buf.indexOf("\n");
      if (lineEnd < 0) return;
      const line = this.buf.subarray(0, lineEnd).toString("utf8").trim();
      this.buf = this.buf.subarray(lineEnd + 1);
      if (!line || !line.startsWith("{")) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(body: string) {
    let msg: {
      id?: number | string;
      result?: unknown;
      error?: { message?: string; code?: number };
      method?: string;
    };
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // notification
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    } else {
      p.resolve(msg.result);
    }
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.write({ jsonrpc: "2.0", method, params });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    const waitMs = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`graph MCP stdio timeout after ${waitMs}ms (${method})`));
      }, waitMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Write a JSON-RPC message to the child.
   *
   * codesteward-mcp expects **NDJSON** (one JSON object per line). Content-Length
   * framing confuses its stream parser (`Invalid JSON: Content-Length: …`) and
   * leaves initialize hanging — which blocked the whole worker dequeue loop.
   */
  private write(msg: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) {
        reject(new Error("graph MCP stdio stdin not writable"));
        return;
      }
      const body = JSON.stringify(msg);
      const framing = (process.env.GRAPH_MCP_STDIO_FRAMING ?? "ndjson")
        .trim()
        .toLowerCase();
      const frame =
        framing === "content-length" || framing === "lsp"
          ? `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
          : `${body}\n`;
      this.child.stdin.write(frame, (err) => (err ? reject(err) : resolve()));
    });
  }
}

/** Process-wide embedded graph MCP (one child per worker/API process). */
let globalBridge: McpStdioBridge | null = null;

export function getEmbeddedGraphBridge(): McpStdioBridge {
  if (!globalBridge) {
    globalBridge = new McpStdioBridge();
  }
  return globalBridge;
}

export async function ensureEmbeddedGraphMcp(): Promise<McpStdioBridge> {
  const b = getEmbeddedGraphBridge();
  await b.ensureStarted();
  return b;
}

export async function stopEmbeddedGraphMcp(): Promise<void> {
  if (globalBridge) {
    await globalBridge.close();
    globalBridge = null;
  }
}
