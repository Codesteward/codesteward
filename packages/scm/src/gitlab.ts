import type {
  DiffFile,
  PostedComment,
  PostedReview,
  PullRequest,
  Repository,
  ReviewComment,
  ScmProvider,
} from "./types.js";

export interface GitLabOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * GitLab REST adapter.
 * Env: GITLAB_TOKEN, GITLAB_API_URL (default https://gitlab.com/api/v4)
 * owner/repo are joined as URL-encoded project path.
 */
export class GitLabScm implements ScmProvider {
  readonly name = "gitlab";
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitLabOptions = {}) {
    this.token = opts.token ?? process.env.GITLAB_TOKEN;
    this.baseUrl = (
      opts.baseUrl ??
      process.env.GITLAB_API_URL ??
      "https://gitlab.com/api/v4"
    ).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "codesteward-review",
    };
    if (this.token) h["PRIVATE-TOKEN"] = this.token;
    return h;
  }

  private projectPath(owner: string, repo: string): string {
    return encodeURIComponent(`${owner}/${repo}`);
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab API ${res.status} ${path}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const mr = await this.api<{
      iid: number;
      title: string;
      description?: string;
      state: string;
      web_url?: string;
      author?: { username?: string };
      target_branch: string;
      source_branch: string;
      diff_refs?: { base_sha?: string; head_sha?: string };
      sha?: string;
    }>(`/projects/${this.projectPath(owner, repo)}/merge_requests/${number}`);
    return {
      number: mr.iid,
      title: mr.title,
      body: mr.description ?? "",
      state: mr.state,
      baseBranch: mr.target_branch,
      headBranch: mr.source_branch,
      baseSha: mr.diff_refs?.base_sha ?? "",
      headSha: mr.diff_refs?.head_sha ?? mr.sha ?? "",
      url: mr.web_url ?? "",
      author: mr.author?.username,
    };
  }

  async getDiff(owner: string, repo: string, number: number): Promise<DiffFile[]> {
    const changes = await this.api<{
      changes?: Array<{
        old_path?: string;
        new_path?: string;
        new_file?: boolean;
        deleted_file?: boolean;
        renamed_file?: boolean;
        diff?: string;
      }>;
    }>(`/projects/${this.projectPath(owner, repo)}/merge_requests/${number}/changes`);

    return (changes.changes ?? []).map((c) => {
      let status: DiffFile["status"] = "modified";
      if (c.new_file) status = "added";
      else if (c.deleted_file) status = "removed";
      else if (c.renamed_file) status = "renamed";
      const path = c.new_path ?? c.old_path ?? "unknown";
      const adds = (c.diff?.match(/^\+[^+]/gm) ?? []).length;
      const dels = (c.diff?.match(/^-[^-]/gm) ?? []).length;
      return {
        path,
        status,
        patch: c.diff,
        previousPath: c.old_path !== path ? c.old_path : undefined,
        additions: adds,
        deletions: dels,
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
    // Summary note
    const note = await this.api<{ id: number }>(
      `/projects/${this.projectPath(owner, repo)}/merge_requests/${number}/notes`,
      { method: "POST", body: JSON.stringify({ body }) },
    );

    // Inline discussions
    for (const c of comments.slice(0, 25)) {
      if (!c.line) continue;
      try {
        await this.api(
          `/projects/${this.projectPath(owner, repo)}/merge_requests/${number}/discussions`,
          {
            method: "POST",
            body: JSON.stringify({
              body: c.body,
              position: {
                position_type: "text",
                new_path: c.path,
                new_line: c.line,
                old_path: c.path,
              },
            }),
          },
        );
      } catch {
        /* position may fail without SHAs — best effort */
      }
    }

    return { id: String(note.id) };
  }

  async postComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<PostedComment> {
    const res = await this.api<{ id: number }>(
      `/projects/${this.projectPath(owner, repo)}/merge_requests/${number}/notes`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    return { id: String(res.id) };
  }

  async listRepos(owner: string): Promise<Repository[]> {
    const projects = await this.api<
      Array<{
        path_with_namespace: string;
        default_branch?: string;
        visibility?: string;
        web_url?: string;
      }>
    >(`/users/${encodeURIComponent(owner)}/projects?per_page=100`);
    return projects.map((p) => ({
      fullName: p.path_with_namespace,
      defaultBranch: p.default_branch ?? "main",
      private: p.visibility !== "public",
      url: p.web_url ?? "",
    }));
  }

  async listAuthenticatedRepos(): Promise<Repository[]> {
    const projects = await this.api<
      Array<{
        path_with_namespace: string;
        default_branch?: string;
        visibility?: string;
        web_url?: string;
      }>
    >(`/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at`);
    return projects.map((p) => ({
      fullName: p.path_with_namespace,
      defaultBranch: p.default_branch ?? "main",
      private: p.visibility !== "public",
      url: p.web_url ?? "",
    }));
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: { state?: "open" | "closed" | "all" } = {},
  ): Promise<PullRequest[]> {
    const state = opts.state === "open" ? "opened" : opts.state === "closed" ? "closed" : "all";
    const mrs = await this.api<
      Array<{
        iid: number;
        title: string;
        description?: string;
        state: string;
        web_url?: string;
        author?: { username?: string };
        target_branch: string;
        source_branch: string;
        diff_refs?: { base_sha?: string; head_sha?: string };
        sha?: string;
      }>
    >(`/projects/${this.projectPath(owner, repo)}/merge_requests?state=${state}&per_page=100`);
    return mrs.map((mr) => ({
      number: mr.iid,
      title: mr.title,
      body: mr.description ?? "",
      state: mr.state === "opened" ? "open" : mr.state,
      baseBranch: mr.target_branch,
      headBranch: mr.source_branch,
      baseSha: mr.diff_refs?.base_sha ?? "",
      headSha: mr.diff_refs?.head_sha ?? mr.sha ?? "",
      url: mr.web_url ?? "",
      author: mr.author?.username,
    }));
  }

}
