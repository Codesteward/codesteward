/**
 * MCP stdio bridge — spawn `codesteward-mcp --transport stdio` and speak JSON-RPC
 * with Content-Length framing (MCP standard).
 *
 * Used so workers embed Graph MCP without a sidecar container or shared clone PVC.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

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

export class McpStdioBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<number | string, Pending>();
  private nextId = 1;
  private started = false;
  private closed = false;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(opts: StdioBridgeOptions = {}) {
    this.command =
      opts.command ??
      process.env.GRAPH_MCP_COMMAND?.trim() ??
      "codesteward-mcp";
    this.args = opts.args ?? ["--transport", "stdio"];
    this.env = { ...process.env, ...(opts.env ?? {}), TRANSPORT: "stdio" };
    // Avoid structlog noise on stderr polluting diagnostics
    this.env.PYTHONUNBUFFERED = "1";
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.GRAPH_MCP_TIMEOUT_MS ?? 600_000);
  }

  async ensureStarted(): Promise<void> {
    if (this.started && this.child && !this.child.killed) return;
    if (this.closed) throw new Error("MCP stdio bridge is closed");

    this.child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("error", (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
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

    // Initialize MCP session
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codesteward-review", version: "1.1.0" },
    });
    await this.notify("notifications/initialized", {});
    this.started = true;
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
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        // Some servers use bare newlines — try \n\n
        const alt = this.buf.indexOf("\n\n");
        if (alt < 0) return;
        const header = this.buf.subarray(0, alt).toString("utf8");
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          // Line-delimited JSON fallback
          const lineEnd = this.buf.indexOf("\n");
          if (lineEnd < 0) return;
          const line = this.buf.subarray(0, lineEnd).toString("utf8").trim();
          this.buf = this.buf.subarray(lineEnd + 1);
          if (line.startsWith("{")) this.handleMessage(line);
          continue;
        }
        const len = Number(m[1]);
        const bodyStart = alt + 2;
        if (this.buf.length < bodyStart + len) return;
        const body = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
        this.buf = this.buf.subarray(bodyStart + len);
        this.handleMessage(body);
        continue;
      }
      const header = this.buf.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // drop one line
        const nl = this.buf.indexOf("\n");
        if (nl < 0) return;
        this.buf = this.buf.subarray(nl + 1);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return;
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + len);
      this.handleMessage(body);
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

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`graph MCP stdio timeout after ${this.timeoutMs}ms (${method})`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private write(msg: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) {
        reject(new Error("graph MCP stdio stdin not writable"));
        return;
      }
      const body = JSON.stringify(msg);
      const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
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
