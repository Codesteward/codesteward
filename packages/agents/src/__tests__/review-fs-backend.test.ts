/**
 * Review FS backend: relative paths (`.`, src/…) must map to virtual absolute `/…`
 * so DeepAgents never sees non-absolute paths at the backend layer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createReviewFilesystemBackend } from "../review-fs-backend.js";
import { toVirtualReviewPath } from "../path-jail.js";

describe("createReviewFilesystemBackend path mapping", () => {
  it("toVirtualReviewPath maps . and relative to absolute", () => {
    assert.equal(toVirtualReviewPath("."), "/");
    assert.equal(toVirtualReviewPath(""), "/");
    assert.equal(toVirtualReviewPath("src/foo.ts"), "/src/foo.ts");
    assert.equal(toVirtualReviewPath("/src/foo.ts"), "/src/foo.ts");
  });

  it("maps ls('.') and relative files to absolute virtual paths", async () => {
    const seen: string[] = [];
    const inner = {
      ls: async (path: string) => {
        seen.push(`ls:${path}`);
        assert.ok(path.startsWith("/"), `ls path not absolute: ${path}`);
        return { files: [] };
      },
      read: async (filePath: string) => {
        seen.push(`read:${filePath}`);
        assert.ok(filePath.startsWith("/"), `read path not absolute: ${filePath}`);
        return { content: "ok" };
      },
      readRaw: async (filePath: string) => {
        seen.push(`readRaw:${filePath}`);
        return { content: "ok" };
      },
      grep: async (_p: string, path?: string | null) => {
        seen.push(`grep:${path}`);
        return { matches: [] };
      },
      glob: async (_pat: string, path?: string) => {
        seen.push(`glob:${path}`);
        return { files: [] };
      },
    };
    const root = "/workspace/local/ses_test/cross/Owner__repo";
    const backend = createReviewFilesystemBackend(inner as never, root);

    await backend.ls(".");
    await backend.ls("");
    await backend.read("src/evaluator/clickhouse.py");
    await backend.glob("**/*.py", ".");

    assert.deepEqual(seen, [
      "ls:/",
      "ls:/",
      "read:/src/evaluator/clickhouse.py",
      "glob:/",
    ]);
  });

  it("refuses write/edit (read-only review FS)", async () => {
    const backend = createReviewFilesystemBackend(
      {
        ls: async () => ({ files: [] }),
        read: async () => ({}),
        readRaw: async () => ({}),
        grep: async () => ({ matches: [] }),
        glob: async () => ({ files: [] }),
        write: async () => ({ ok: true }),
        edit: async () => ({ ok: true }),
      } as never,
      "/tmp/ws",
    );
    const w = await backend.write!("/x", "y");
    assert.match(String((w as { error?: string }).error), /read-only/i);
    const e = await backend.edit!();
    assert.match(String((e as { error?: string }).error), /read-only/i);
  });
});
