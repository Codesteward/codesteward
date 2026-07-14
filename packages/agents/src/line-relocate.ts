/**
 * OCR-inspired line re-location for SCM comments.
 * Prefer existing_code match in file; fall back to hunk-relative line; drop if ungrounded.
 */

export interface LineAnchorInput {
  path: string;
  startLine?: number;
  endLine?: number;
  /** Snippet the model claims exists (preferred anchor) */
  existingCode?: string;
  message?: string;
}

export interface LineAnchorResult {
  path: string;
  startLine: number;
  endLine?: number;
  method: "existing_code" | "declared_line" | "hunk_search" | "ungrounded";
  grounded: boolean;
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trimEnd();
}

/**
 * Find best line for a finding given file content (head SHA).
 */
export function relocateLine(
  fileContent: string | undefined,
  input: LineAnchorInput,
  opts?: { requireGrounding?: boolean },
): LineAnchorResult {
  const requireGrounding = opts?.requireGrounding ?? true;
  const lines = fileContent != null ? normalize(fileContent).split("\n") : [];

  if (input.existingCode && lines.length) {
    const needle = normalize(input.existingCode).split("\n")[0]?.trim();
    if (needle && needle.length >= 8) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(needle) || needle.includes(lines[i]!.trim())) {
          return {
            path: input.path,
            startLine: i + 1,
            endLine: input.endLine ? i + 1 + (input.endLine - (input.startLine ?? i + 1)) : undefined,
            method: "existing_code",
            grounded: true,
          };
        }
      }
    }
  }

  if (input.startLine && input.startLine > 0) {
    if (!lines.length) {
      return {
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine,
        method: "declared_line",
        grounded: !requireGrounding,
      };
    }
    if (input.startLine <= lines.length) {
      return {
        path: input.path,
        startLine: input.startLine,
        endLine: input.endLine,
        method: "declared_line",
        grounded: true,
      };
    }
  }

  // Search message keywords in file (weak)
  if (input.message && lines.length) {
    const token = input.message.split(/\s+/).find((t) => t.length > 12 && /[A-Za-z_]/.test(t));
    if (token) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(token)) {
          return {
            path: input.path,
            startLine: i + 1,
            method: "hunk_search",
            grounded: true,
          };
        }
      }
    }
  }

  return {
    path: input.path,
    startLine: input.startLine && input.startLine > 0 ? input.startLine : 1,
    endLine: input.endLine,
    method: "ungrounded",
    grounded: false,
  };
}

/**
 * Filter findings that are provably ungrounded when file content is available.
 */
export function filterGroundedFindings<
  T extends {
    path: string;
    startLine?: number;
    endLine?: number;
    title?: string;
    message?: string;
    evidence?: Array<{ snippet?: string }>;
  },
>(
  findings: T[],
  fileContents: Map<string, string>,
): { kept: T[]; dropped: Array<{ finding: T; reason: string }> } {
  const kept: T[] = [];
  const dropped: Array<{ finding: T; reason: string }> = [];
  for (const f of findings) {
    const content = fileContents.get(f.path);
    const existing =
      f.evidence?.map((e) => e.snippet).find(Boolean) ??
      undefined;
    const result = relocateLine(content, {
      path: f.path,
      startLine: f.startLine,
      endLine: f.endLine,
      existingCode: existing,
      message: f.message ?? f.title,
    });
    if (!result.grounded && content != null) {
      dropped.push({ finding: f, reason: `ungrounded:${result.method}` });
      continue;
    }
    kept.push({
      ...f,
      startLine: result.startLine,
      endLine: result.endLine ?? f.endLine,
    });
  }
  return { kept, dropped };
}
