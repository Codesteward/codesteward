/**
 * Wrap DeepAgents FilesystemBackend with tenant path normalization.
 * Ensures ls/read_file/glob/grep cannot escape the unit workspace and rewrites
 * mistaken host / cross-repo paths models invent.
 */
import {
  normalizeReviewToolPath,
  rewriteShellCommandPaths,
  toVirtualReviewPath,
} from "./path-jail.js";

type AnyBackend = {
  ls: (path: string) => Promise<unknown>;
  read: (filePath: string, offset?: number, limit?: number) => Promise<unknown>;
  readRaw: (filePath: string) => Promise<unknown>;
  grep: (
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ) => Promise<unknown>;
  glob: (pattern: string, path?: string) => Promise<unknown>;
  write?: (filePath: string, content: string) => Promise<unknown>;
  edit?: (
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ) => Promise<unknown>;
  execute?: (command: string) => Promise<unknown>;
  id?: string;
};

export function createReviewFilesystemBackend(
  inner: AnyBackend,
  workspaceRoot: string,
): AnyBackend {
  /**
   * Map model-supplied paths (`.`, relative, host/cross mistakes) to virtual
   * absolute paths under the unit root. Never return a non-absolute string —
   * DeepAgents FilesystemBackend virtualMode expects `/…`.
   */
  const map = (p: string | null | undefined, fallback = "/"): string => {
    try {
      const rel = normalizeReviewToolPath(p ?? fallback, workspaceRoot);
      const v = toVirtualReviewPath(rel);
      return v.startsWith("/") ? v : `/${v}`;
    } catch (err) {
      throw err;
    }
  };

  return {
    id: inner.id,
    ls: async (path: string) => {
      try {
        // Default empty / relative root → unit root
        const raw = path == null || path === "" ? "/" : path;
        return await inner.ls(map(raw, "/"));
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          files: [],
        };
      }
    },
    read: async (filePath: string, offset?: number, limit?: number) => {
      try {
        return await inner.read(map(filePath, "/"), offset, limit);
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    readRaw: async (filePath: string) => {
      try {
        return await inner.readRaw(map(filePath, "/"));
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    grep: async (pattern: string, path?: string | null, glob?: string | null) => {
      try {
        const p =
          path == null || path === ""
            ? "/"
            : map(path, "/");
        return await inner.grep(pattern, p, glob);
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          matches: [],
        };
      }
    },
    glob: async (pattern: string, path?: string) => {
      try {
        return await inner.glob(pattern, map(path ?? "/", "/"));
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          files: [],
        };
      }
    },
    write: async (filePath: string, content: string) => {
      // Review is read-only — refuse even if inner allows
      return {
        error: "write_file refused: review filesystem is read-only",
      };
    },
    edit: async () => {
      return {
        error: "edit_file refused: review filesystem is read-only",
      };
    },
    execute: inner.execute
      ? async (command: string) => {
          const rewritten = rewriteShellCommandPaths(command, workspaceRoot);
          if (!rewritten.ok) {
            return {
              output: rewritten.reason,
              exitCode: 1,
              truncated: false,
            };
          }
          return inner.execute!(rewritten.command);
        }
      : undefined,
  };
}
