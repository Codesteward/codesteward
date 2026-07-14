#!/usr/bin/env node
/**
 * Thin stdio JSON-RPC MCP server exposing review tools.
 * Compatible with MCP tools/list + tools/call shape used by host agents.
 */
import { createReviewTools } from "./tools.js";

const tools = createReviewTools();
const byName = new Map(tools.map((t) => [t.name, t]));

async function handle(msg: {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "codesteward-review", version: "0.1.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const tool = byName.get(name);
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      };
    }
    try {
      const result = await tool.handler(args);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

async function main() {
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    // Support Content-Length framing and newline-delimited JSON
    for (;;) {
      if (buf.startsWith("Content-Length:")) {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) break;
        const header = buf.slice(0, headerEnd);
        const len = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
        const bodyStart = headerEnd + 4;
        if (buf.length < bodyStart + len) break;
        const body = buf.slice(bodyStart, bodyStart + len);
        buf = buf.slice(bodyStart + len);
        void dispatch(body);
      } else {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) void dispatch(line);
      }
    }
  });

  console.error("[stew-mcp] review MCP server ready on stdio");
}

async function dispatch(raw: string) {
  let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const res = await handle(msg);
  if (res == null) return;
  const payload = JSON.stringify(res);
  const framed = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
  process.stdout.write(framed);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { createReviewTools } from "./tools.js";
