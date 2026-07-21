/**
 * resolveGraphMcpSpawn — prefer absolute/executable paths over bare names.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveGraphMcpSpawn } from "../stdio-bridge.js";

describe("resolveGraphMcpSpawn", () => {
  it("uses bare name when nothing on disk (last resort)", () => {
    const r = resolveGraphMcpSpawn({
      command: "totally-missing-codesteward-mcp-xyz",
      env: { PATH: "/nonexistent/bin", HOME: "/tmp" },
    });
    assert.ok(r.command.includes("codesteward") || r.via.startsWith("python-m") || r.via.startsWith("bare"));
  });

  it("prefers executable absolute path", () => {
    const dir = join(tmpdir(), `stew-mcp-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "codesteward-mcp");
    try {
      writeFileSync(bin, "#!/bin/sh\necho ok\n", { mode: 0o755 });
      chmodSync(bin, 0o755);
      const r = resolveGraphMcpSpawn({
        command: bin,
        env: { PATH: "/nonexistent", HOME: "/tmp" },
      });
      assert.equal(r.command, bin);
      assert.match(r.via, /executable/);
      assert.deepEqual(r.args, ["--transport", "stdio"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to python when script exists but is not executable", () => {
    const dir = join(tmpdir(), `stew-mcp-nox-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "codesteward-mcp");
    const py = join(dir, "python3");
    try {
      writeFileSync(bin, "print('mcp')\n", { mode: 0o644 });
      chmodSync(bin, 0o644);
      writeFileSync(py, "#!/bin/sh\n", { mode: 0o755 });
      chmodSync(py, 0o755);
      const r = resolveGraphMcpSpawn({
        command: bin,
        env: { PATH: "/nonexistent", HOME: "/tmp" },
      });
      assert.equal(r.command, py);
      assert.equal(r.args[0], bin);
      assert.match(r.via, /python-script/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
