import type {
  DiffFile,
  PostedComment,
  PostedReview,
  PullRequest,
  Repository,
  ReviewComment,
  ScmProvider,
} from "./types.js";

export interface BitbucketOptions {
  token?: string;
  username?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Bitbucket Cloud REST adapter.
 * Auth: BITBUCKET_TOKEN (app password) + BITBUCKET_USERNAME, or workspace token as Bearer.
 */
export class BitbucketScm implements ScmProvider {
  readonly name = "bitbucket";
  private readonly token: string | undefined;
  private readonly username: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BitbucketOptions = {}) {
    this.token = opts.token ?? process.env.BITBUCKET_TOKEN;
    this.username = opts.username ?? process.env.BITBUCKET_USERNAME;
    this.baseUrl = (
      opts.baseUrl ??
      process.env.BITBUCKET_API_URL ??
      "https://api.bitbucket.org/2.0"
    ).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "codesteward-review",
    };
    if (this.token && this.username) {
      const basic = Buffer.from(`${this.username}:${this.token}`).toString("base64");
      h.Authorization = `Basic ${basic}`;
    } else if (this.token) {
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bitbucket API ${res.status} ${path}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const pr = await this.api<{
      id: number;
      title: string;
      description?: string;
      state: string;
      links?: { html?: { href?: string } };
      author?: { display_name?: string; nickname?: string };
      destination?: { branch?: { name?: string }; commit?: { hash?: string } };
      source?: { branch?: { name?: string }; commit?: { hash?: string } };
    }>(`/repositories/${owner}/${repo}/pullrequests/${number}`);
    return {
      number: pr.id,
      title: pr.title,
      body: pr.description ?? "",
      state: pr.state?.toLowerCase() ?? "open",
      baseBranch: pr.destination?.branch?.name ?? "main",
      headBranch: pr.source?.branch?.name ?? "feature",
      baseSha: pr.destination?.commit?.hash ?? "",
      headSha: pr.source?.commit?.hash ?? "",
      url: pr.links?.html?.href ?? "",
      author: pr.author?.nickname ?? pr.author?.display_name,
    };
  }

  async getDiff(owner: string, repo: string, number: number): Promise<DiffFile[]> {
    // Prefer diffstat + raw diff
    const stat = await this.api<{
      values?: Array<{
        status?: string;
        old?: { path?: string } | null;
        new?: { path?: string } | null;
        lines_added?: number;
        lines_removed?: number;
      }>;
    }>(`/repositories/${owner}/${repo}/pullrequests/${number}/diffstat`);

    let rawDiff = "";
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/repositories/${owner}/${repo}/pullrequests/${number}/diff`,
        { headers: this.headers() },
      );
      if (res.ok) rawDiff = await res.text();
    } catch {
      /* optional */
    }
    const patches = splitUnifiedDiff(rawDiff);

    return (stat.values ?? []).map((v) => {
      const path = v.new?.path ?? v.old?.path ?? "unknown";
      return {
        path,
        status: mapBbStatus(v.status, v.old?.path, v.new?.path),
        patch: patches.get(path),
        previousPath: v.old?.path !== path ? v.old?.path : undefined,
        additions: v.lines_added ?? 0,
        deletions: v.lines_removed ?? 0,
      };
    });
  }

  async postReview(
    owner: string,
    repo: string,
    number: number,
    body: string,
    comments: ReviewComment[] = [],
  ): Promise<PostedReview> {
    // Bitbucket: PR comment for summary + inline comments
    const summary = await this.api<{ id: number; links?: { html?: { href?: string } } }>(
      `/repositories/${owner}/${repo}/pullrequests/${number}/comments`,
      { method: "POST", body: JSON.stringify({ content: { raw: body } }) },
    );

    for (const c of comments.slice(0, 25)) {
      try {
        await this.api(
          `/repositories/${owner}/${repo}/pullrequests/${number}/comments`,
          {
            method: "POST",
            body: JSON.stringify({
              content: { raw: c.body },
              inline: {
                path: c.path,
                to: c.line,
              },
            }),
          },
        );
      } catch {
        /* best-effort inline */
      }
    }

    return {
      id: String(summary.id),
      htmlUrl: summary.links?.html?.href,
    };
  }

  async postComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<PostedComment> {
    const res = await this.api<{ id: number; links?: { html?: { href?: string } } }>(
      `/repositories/${owner}/${repo}/pullrequests/${number}/comments`,
      { method: "POST", body: JSON.stringify({ content: { raw: body } }) },
    );
    return { id: String(res.id), htmlUrl: res.links?.html?.href };
  }

  async listRepos(owner: string): Promise<Repository[]> {
    const res = await this.api<{
      values?: Array<{
        full_name: string;
        is_private: boolean;
        links?: { html?: { href?: string } };
        mainbranch?: { name?: string };
      }>;
    }>(`/repositories/${owner}?pagelen=100`);
    return (res.values ?? []).map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.mainbranch?.name ?? "main",
      private: r.is_private,
      url: r.links?.html?.href ?? "",
    }));
  }

  async listAuthenticatedRepos(): Promise<Repository[]> {
    const res = await this.api<{
      values?: Array<{
        full_name: string;
        is_private: boolean;
        links?: { html?: { href?: string } };
        mainbranch?: { name?: string };
      }>;
    }>(`/repositories?role=member&pagelen=100`);
    return (res.values ?? []).map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.mainbranch?.name ?? "main",
      private: r.is_private,
      url: r.links?.html?.href ?? "",
    }));
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: { state?: "open" | "closed" | "all" } = {},
  ): Promise<PullRequest[]> {
    const state =
      opts.state === "closed"
        ? "MERGED,DECLINED,SUPERSEDED"
        : opts.state === "all"
          ? undefined
          : "OPEN";
    const q = state ? `?state=${state}&pagelen=50` : "?pagelen=50";
    const res = await this.api<{
      values?: Array<{
        id: number;
        title: string;
        description?: string;
        state: string;
        links?: { html?: { href?: string } };
        author?: { display_name?: string; nickname?: string };
        source?: { branch?: { name?: string }; commit?: { hash?: string } };
        destination?: { branch?: { name?: string }; commit?: { hash?: string } };
      }>;
    }>(`/repositories/${owner}/${repo}/pullrequests${q}`);
    return (res.values ?? []).map((pr) => ({
      number: pr.id,
      title: pr.title,
      body: pr.description ?? "",
      state:
        (pr.state ?? "").toLowerCase() === "open"
          ? "open"
          : (pr.state ?? "").toLowerCase(),
      baseBranch: pr.destination?.branch?.name ?? "",
      headBranch: pr.source?.branch?.name ?? "",
      baseSha: pr.destination?.commit?.hash ?? "",
      headSha: pr.source?.commit?.hash ?? "",
      url: pr.links?.html?.href ?? "",
      author: pr.author?.nickname ?? pr.author?.display_name,
    }));
  }
}

function mapBbStatus(
  status?: string,
  oldPath?: string | null,
  newPath?: string | null,
): DiffFile["status"] {
  const s = (status ?? "").toLowerCase();
  if (s === "added" || (!oldPath && newPath)) return "added";
  if (s === "removed" || (oldPath && !newPath)) return "removed";
  if (s === "renamed") return "renamed";
  return "modified";
}

function splitUnifiedDiff(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!diff) return map;
  const parts = diff.split(/^diff --git /m).filter(Boolean);
  for (const part of parts) {
    const full = part.startsWith("a/") ? `diff --git ${part}` : `diff --git ${part}`;
    const m = /b\/([^\s\n]+)/.exec(part);
    if (m?.[1]) map.set(m[1], full);
  }
  return map;
}
