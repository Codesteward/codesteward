import type {
  DiffFile,
  PostedComment,
  PostedReview,
  PullRequest,
  Repository,
  ReviewComment,
  ScmProvider,
} from "./types.js";

export interface GiteaOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Gitea / Forgejo REST adapter (GitHub-compatible subset).
 * Env: GITEA_TOKEN, GITEA_API_URL (e.g. https://gitea.example.com/api/v1)
 */
export class GiteaScm implements ScmProvider {
  readonly name = "gitea";
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GiteaOptions = {}) {
    this.token = opts.token ?? process.env.GITEA_TOKEN ?? process.env.FORGEJO_TOKEN;
    this.baseUrl = (
      opts.baseUrl ??
      process.env.GITEA_API_URL ??
      process.env.FORGEJO_API_URL ??
      "http://localhost:3000/api/v1"
    ).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "codesteward-review",
    };
    if (this.token) h.Authorization = `token ${this.token}`;
    return h;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gitea API ${res.status} ${path}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const pr = await this.api<{
      number: number;
      title: string;
      body?: string;
      state: string;
      html_url?: string;
      user?: { login?: string };
      base?: { ref?: string; sha?: string };
      head?: { ref?: string; sha?: string };
    }>(`/repos/${owner}/${repo}/pulls/${number}`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.state,
      baseBranch: pr.base?.ref ?? "main",
      headBranch: pr.head?.ref ?? "feature",
      baseSha: pr.base?.sha ?? "",
      headSha: pr.head?.sha ?? "",
      url: pr.html_url ?? "",
      author: pr.user?.login,
    };
  }

  async getDiff(owner: string, repo: string, number: number): Promise<DiffFile[]> {
    const files = await this.api<
      Array<{
        filename?: string;
        status?: string;
        patch?: string;
        previous_filename?: string;
        additions?: number;
        deletions?: number;
      }>
    >(`/repos/${owner}/${repo}/pulls/${number}/files`);

    return files.map((f) => ({
      path: f.filename ?? "unknown",
      status: mapStatus(f.status),
      patch: f.patch,
      previousPath: f.previous_filename,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }));
  }

  async postReview(
    owner: string,
    repo: string,
    number: number,
    body: string,
    comments: ReviewComment[] = [],
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" = "COMMENT",
  ): Promise<PostedReview> {
    const eventMap: Record<string, string> = {
      COMMENT: "COMMENT",
      APPROVE: "APPROVE",
      REQUEST_CHANGES: "REQUEST_CHANGES",
    };
    const payload = {
      body,
      event: eventMap[event] ?? "COMMENT",
      comments: comments.map((c) => ({
        path: c.path,
        body: c.body,
        old_position: 0,
        // Gitea uses line in newer versions
        line: c.line,
      })),
    };
    const res = await this.api<{ id: number; html_url?: string }>(
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    return { id: String(res.id), htmlUrl: res.html_url };
  }

  async postComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<PostedComment> {
    const res = await this.api<{ id: number; html_url?: string }>(
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    return { id: String(res.id), htmlUrl: res.html_url };
  }

  async listRepos(owner: string): Promise<Repository[]> {
    const repos = await this.api<
      Array<{
        full_name: string;
        default_branch?: string;
        private: boolean;
        html_url?: string;
      }>
    >(`/users/${owner}/repos?limit=100`);
    return repos.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch ?? "main",
      private: r.private,
      url: r.html_url ?? "",
    }));
  }

  async listAuthenticatedRepos(): Promise<Repository[]> {
    const repos = await this.api<
      Array<{
        full_name: string;
        default_branch?: string;
        private: boolean;
        html_url?: string;
      }>
    >(`/user/repos?limit=100`);
    return repos.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch ?? "main",
      private: r.private,
      url: r.html_url ?? "",
    }));
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: { state?: "open" | "closed" | "all" } = {},
  ): Promise<PullRequest[]> {
    const state = opts.state ?? "open";
    const prs = await this.api<
      Array<{
        number: number;
        title: string;
        body?: string;
        state: string;
        html_url?: string;
        user?: { login?: string };
        base?: { ref?: string; sha?: string };
        head?: { ref?: string; sha?: string };
      }>
    >(`/repos/${owner}/${repo}/pulls?state=${state}&limit=100`);
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.state,
      baseBranch: pr.base?.ref ?? "",
      headBranch: pr.head?.ref ?? "",
      baseSha: pr.base?.sha ?? "",
      headSha: pr.head?.sha ?? "",
      url: pr.html_url ?? "",
      author: pr.user?.login,
    }));
  }

}

function mapStatus(s?: string): DiffFile["status"] {
  if (s === "added") return "added";
  if (s === "removed" || s === "deleted") return "removed";
  if (s === "renamed") return "renamed";
  return "modified";
}
