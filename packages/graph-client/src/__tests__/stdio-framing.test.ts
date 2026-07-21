/**
 * NDJSON framing for codesteward-mcp (Content-Length breaks their stream parser).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

describe("graph MCP stdio framing", () => {
  it("documents NDJSON write format (unit of message is one JSON line)", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    };
    const ndjson = `${JSON.stringify(msg)}\n`;
    assert.ok(ndjson.startsWith("{"));
    assert.ok(ndjson.endsWith("\n"));
    assert.equal(ndjson.includes("Content-Length"), false);
    // Content-Length form is what broke codesteward-mcp
    const bad = `Content-Length: ${Buffer.byteLength(JSON.stringify(msg))}\r\n\r\n${JSON.stringify(msg)}`;
    assert.ok(bad.startsWith("Content-Length:"));
  });

  it("parses single-line NDJSON responses without waiting for blank line", async () => {
    // Minimal mock of onData line parsing
    let buf = Buffer.alloc(0);
    const messages: unknown[] = [];
    const handle = (body: string) => {
      messages.push(JSON.parse(body));
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (
          buf.length >= 15 &&
          buf.subarray(0, 14).toString("utf8").toLowerCase() === "content-length"
        ) {
          return; // not used in this test
        }
        const lineEnd = buf.indexOf("\n");
        if (lineEnd < 0) return;
        const line = buf.subarray(0, lineEnd).toString("utf8").trim();
        buf = buf.subarray(lineEnd + 1);
        if (!line || !line.startsWith("{")) continue;
        handle(line);
      }
    };
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2024-11-05" },
    });
    // Single trailing newline only (codesteward-mcp style) — old code waited for \n\n forever
    onData(Buffer.from(`${payload}\n`));
    assert.equal(messages.length, 1);
    assert.equal((messages[0] as { id: number }).id, 1);
  });
});
