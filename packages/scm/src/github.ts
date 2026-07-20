import { gzipSync } from "node:zlib";
import type {
  CheckRunInput,
  CodeScanningSarifUpload,
  DiffFile,
  Issue,
  PostedCheckRun,
  PostedCodeScanningSarif,
  PostedComment,
  PostedReview,
  PullRequest,
  Repository,
  ReviewComment,
  ScmProvider,
  ScmReactionContent,
} from "./types.js";

export interface GitHubOptions {
  token?: string;
  /** Async token source (GitHub App installation token). Preferred over static PAT. */
  tokenProvider?: () => Promise<string | undefined>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** auth mode for diagnostics */
  authMode?: "github_app" | "pat" | "unknown";
}

/** GitHub REST adapter. Prefer GitHub App installation tokens over PATs. */
export class GitHubScm implements ScmProvider {
  readonly name = "github";
  private readonly token: string | undefined;
  private readonly tokenProvider?: () => Promise<string | undefined>;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly authMode: "github_app" | "pat" | "unknown";

  constructor(opts: GitHubOptions = {}) {
    this.token = opts.token ?? process.env.GITHUB_TOKEN;
    this.tokenProvider = opts.tokenProvider;
    this.baseUrl = (opts.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.authMode =
      opts.authMode ??
      (opts.tokenProvider ? "github_app" : this.token ? "pat" : "unknown");
  }

  private async resolveToken(): Promise<string | undefined> {
    if (this.tokenProvider) {
      const t = await this.tokenProvider();
      if (t) return t;
    }
    return this.token;
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codesteward-review",
    };
    const token = await this.resolveToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(await this.headers()), ...(init?.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status} ${path}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const pr = await this.api<{
      number: number;
      title: string;
      body: string | null;
      state: string;
      html_url: string;
      user?: { login: string };
      base: { ref: string; sha: string };
      head: { ref: string; sha: string };
    }>(`/repos/${owner}/${repo}/pulls/${number}`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.state,
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      url: pr.html_url,
      author: pr.user?.login,
    };
  }

  async getIssue(owner: string, repo: string, number: number): Promise<Issue> {
    const issue = await this.api<{
      number: number;
      title: string;
      body: string | null;
      state: string;
      html_url: string;
      labels?: Array<{ name?: string } | string>;
    }>(`/repos/${owner}/${repo}/issues/${number}`);
    const labels = (issue.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name))
      .filter((n): n is string => Boolean(n));
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      url: issue.html_url,
      labels,
    };
  }

  async getDiff(owner: string, repo: string, number: number): Promise<DiffFile[]> {
    type FileRow = {
      filename: string;
      status: string;
      patch?: string;
      previous_filename?: string;
      additions: number;
      deletions: number;
    };
    const all: FileRow[] = [];
    let page = 1;
    const perPage = 100;
    // Paginate following Link headers (GitHub max 3000 files / PR)
    while (page <= 30) {
      const path = `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${perPage}&page=${page}`;
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: await this.headers(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API ${res.status} ${path}: ${text.slice(0, 400)}`);
      }
      const batch = (await res.json()) as FileRow[];
      all.push(...batch);
      const link = res.headers.get("link") ?? res.headers.get("Link") ?? "";
      const hasNext = /rel="next"/.test(link);
      if (!hasNext || batch.length < perPage) break;
      page += 1;
    }

    return all.map((f) => ({
      path: f.filename,
      status: mapStatus(f.status),
      patch: f.patch,
      previousPath: f.previous_filename,
      additions: f.additions,
      deletions: f.deletions,
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
    const payload = {
      body,
      event,
      comments: comments.map((c) => ({
        path: c.path,
        body: c.body,
        line: c.line,
        side: c.side ?? "RIGHT",
      })),
    };
    const res = await this.api<{ id: number; html_url: string }>(
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
    const res = await this.api<{ id: number; html_url: string }>(
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    return { id: String(res.id), htmlUrl: res.html_url };
  }

  async updateComment(
    owner: string,
    repo: string,
    commentId: string | number,
    body: string,
  ): Promise<PostedComment> {
    const res = await this.api<{ id: number; html_url: string }>(
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      { method: "PATCH", body: JSON.stringify({ body }) },
    );
    return { id: String(res.id), htmlUrl: res.html_url };
  }

  async listPullReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{ id: string; path?: string; body: string; htmlUrl?: string }>> {
    const out: Array<{ id: string; path?: string; body: string; htmlUrl?: string }> =
      [];
    let page = 1;
    for (;;) {
      const batch = await this.api<
        Array<{ id: number; path?: string; body: string; html_url?: string }>
      >(
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
      );
      if (!batch.length) break;
      for (const c of batch) {
        out.push({
          id: String(c.id),
          path: c.path,
          body: c.body ?? "",
          htmlUrl: c.html_url,
        });
      }
      if (batch.length < 100) break;
      page += 1;
      if (page > 20) break;
    }
    return out;
  }

  /**
   * Resolve the review thread for a prior finding comment (re-review auto-fix).
   * Matches by REST review-comment database id and/or HTML markers in the body.
   */
  async resolveReviewThreadForComment(
    owner: string,
    repo: string,
    prNumber: number,
    match: {
      commentId?: string | number;
      fingerprint?: string;
      findingId?: string;
    },
  ): Promise<{ resolved: boolean; threadId?: string; alreadyResolved?: boolean }> {
    const wantId =
      match.commentId != null ? String(match.commentId).replace(/^comment:/, "") : undefined;
    const fp = match.fingerprint?.trim();
    const fid = match.findingId?.trim();
    if (!wantId && !fp && !fid) {
      return { resolved: false };
    }

    // GraphQL: walk review threads and match comment databaseId / body markers
    const query = `
      query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                comments(first: 20) {
                  nodes {
                    databaseId
                    body
                  }
                }
              }
            }
          }
        }
      }`;

    type ThreadComment = { databaseId?: number; body?: string };
    type ThreadNode = {
      id: string;
      isResolved: boolean;
      comments?: {
        nodes?: ThreadComment[];
      };
    };
    type ThreadsQuery = {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: ThreadNode[];
          };
        };
      };
    };

    let cursor: string | null = null;
    let target: ThreadNode | undefined;
    for (let page = 0; page < 30 && !target; page++) {
      const data: ThreadsQuery = await this.graphql<ThreadsQuery>(query, {
        owner,
        name: repo,
        number: prNumber,
        cursor,
      });
      const threads = data.repository?.pullRequest?.reviewThreads;
      const nodes: ThreadNode[] = threads?.nodes ?? [];
      for (const th of nodes) {
        const comments: ThreadComment[] = th.comments?.nodes ?? [];
        const hit = comments.some((c: ThreadComment) => {
          if (wantId && c.databaseId != null && String(c.databaseId) === wantId) {
            return true;
          }
          const body = c.body ?? "";
          if (fp && body.includes(`<!-- fingerprint:${fp} -->`)) return true;
          if (fid && body.includes(`<!-- finding:${fid} -->`)) return true;
          return false;
        });
        if (hit) {
          target = th;
          break;
        }
      }
      if (!threads?.pageInfo?.hasNextPage) break;
      cursor = threads.pageInfo.endCursor ?? null;
      if (!cursor) break;
    }

    if (!target) return { resolved: false };
    if (target.isResolved) {
      return { resolved: true, threadId: target.id, alreadyResolved: true };
    }

    const mut = `
      mutation($id: ID!) {
        resolveReviewThread(input: { threadId: $id }) {
          thread { id isResolved }
        }
      }`;
    await this.graphql(mut, { id: target.id });
    return { resolved: true, threadId: target.id };
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const base = this.baseUrl.includes("api.github.com")
      ? "https://api.github.com"
      : this.baseUrl.replace(/\/$/, "");
    const res = await this.fetchImpl(`${base}/graphql`, {
      method: "POST",
      headers: {
        ...(await this.headers()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub GraphQL ${res.status}: ${text.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      throw new Error(
        `GitHub GraphQL: ${json.errors.map((e) => e.message).join("; ").slice(0, 400)}`,
      );
    }
    if (!json.data) throw new Error("GitHub GraphQL: empty data");
    return json.data;
  }

  /**
   * React on a PR (as issue) or an issue comment — e.g. 👀 when a webhook review starts.
   * Requires issues:write (or equivalent) on the GitHub App / token.
   */
  async createReaction(
    owner: string,
    repo: string,
    target: { issueNumber?: number; commentId?: string | number },
    content: ScmReactionContent = "eyes",
  ): Promise<{ id: string } | undefined> {
    const path = target.commentId
      ? `/repos/${owner}/${repo}/issues/comments/${target.commentId}/reactions`
      : target.issueNumber != null
        ? `/repos/${owner}/${repo}/issues/${target.issueNumber}/reactions`
        : null;
    if (!path) return undefined;
    try {
      const res = await this.api<{ id: number }>(path, {
        method: "POST",
        body: JSON.stringify({ content }),
        headers: {
          // Reactions content-type (still accepted alongside github+json)
          Accept: "application/vnd.github+json",
        },
      });
      return { id: String(res.id) };
    } catch (err) {
      // Non-fatal: missing permission or duplicate reaction
      console.warn(
        `[scm/github] createReaction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  async listRepos(owner: string): Promise<Repository[]> {
    const repos = await this.api<
      Array<{ full_name: string; default_branch: string; private: boolean; html_url: string }>
    >(`/users/${owner}/repos?per_page=100`);
    return repos.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
      url: r.html_url,
    }));
  }

  async listAuthenticatedRepos(): Promise<Repository[]> {
    // Installation tokens cannot call /user/repos — use installation repository list.
    if (this.authMode === "github_app" || this.tokenProvider) {
      return this.listInstallationRepos();
    }
    const all: Repository[] = [];
    let page = 1;
    while (page <= 10) {
      const batch = await this.api<
        Array<{ full_name: string; default_branch: string; private: boolean; html_url: string }>
      >(`/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member&sort=updated`);
      all.push(
        ...batch.map((r) => ({
          fullName: r.full_name,
          defaultBranch: r.default_branch,
          private: r.private,
          url: r.html_url,
        })),
      );
      if (batch.length < 100) break;
      page += 1;
    }
    return all;
  }

  /** Repos visible to a GitHub App installation token. */
  async listInstallationRepos(): Promise<Repository[]> {
    const all: Repository[] = [];
    let page = 1;
    while (page <= 20) {
      const batch = await this.api<{
        total_count?: number;
        repositories?: Array<{
          full_name: string;
          default_branch: string;
          private: boolean;
          html_url: string;
        }>;
      }>(`/installation/repositories?per_page=100&page=${page}`);
      const repos = batch.repositories ?? [];
      all.push(
        ...repos.map((r) => ({
          fullName: r.full_name,
          defaultBranch: r.default_branch,
          private: r.private,
          url: r.html_url,
        })),
      );
      if (repos.length < 100) break;
      page += 1;
    }
    return all;
  }

  /**
   * Upload SARIF to Code Scanning (Security → Code scanning / quality alerts).
   * @see https://docs.github.com/en/rest/code-scanning/code-scanning#upload-an-analysis-as-sarif-data
   *
   * Requires: code scanning enabled on the repo; token with `security_events: write`
   * (GitHub App) or equivalent fine-grained PAT permission.
   */
  async uploadCodeScanningSarif(
    owner: string,
    repo: string,
    input: CodeScanningSarifUpload,
  ): Promise<PostedCodeScanningSarif> {
    const json =
      typeof input.sarif === "string"
        ? input.sarif
        : JSON.stringify(input.sarif);
    // GitHub requires gzip + base64 of the SARIF payload
    const sarifB64 = gzipSync(Buffer.from(json, "utf8")).toString("base64");
    const body: Record<string, unknown> = {
      commit_sha: input.commitSha,
      ref: input.ref,
      sarif: sarifB64,
    };
    if (input.checkoutUri) body.checkout_uri = input.checkoutUri;
    if (input.startedAt) body.started_at = input.startedAt;
    if (input.toolName) body.tool_name = input.toolName;

    const res = await this.api<{ id?: string; url?: string; sarif_id?: string }>(
      `/repos/${owner}/${repo}/code-scanning/sarifs`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    return {
      id: String(res.id ?? res.sarif_id ?? "uploaded"),
      url: res.url,
    };
  }

  /**
   * Create or update a Check Run (required for branch protection gates).
   * @see https://docs.github.com/en/rest/checks/runs
   */
  async postCheckRun(
    owner: string,
    repo: string,
    input: CheckRunInput,
  ): Promise<PostedCheckRun> {
    const output =
      input.title || input.summary || input.text
        ? {
            title: input.title ?? input.name,
            summary: input.summary ?? "",
            text: input.text,
          }
        : undefined;
    const body: Record<string, unknown> = {
      name: input.name,
      head_sha: input.headSha,
      status: input.status,
    };
    if (input.conclusion) body.conclusion = input.conclusion;
    if (output) body.output = output;
    if (input.detailsUrl) body.details_url = input.detailsUrl;
    if (input.status === "completed") {
      body.completed_at = new Date().toISOString();
    } else if (input.status === "in_progress") {
      body.started_at = new Date().toISOString();
    }

    if (input.checkRunId) {
      const res = await this.api<{
        id: number;
        html_url?: string;
        status: string;
        conclusion?: string | null;
      }>(`/repos/${owner}/${repo}/check-runs/${input.checkRunId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return {
        id: String(res.id),
        htmlUrl: res.html_url,
        status: res.status,
        conclusion: res.conclusion ?? undefined,
      };
    }

    const res = await this.api<{
      id: number;
      html_url?: string;
      status: string;
      conclusion?: string | null;
    }>(`/repos/${owner}/${repo}/check-runs`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return {
      id: String(res.id),
      htmlUrl: res.html_url,
      status: res.status,
      conclusion: res.conclusion ?? undefined,
    };
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
        body: string | null;
        state: string;
        html_url: string;
        user?: { login: string };
        base: { ref: string; sha: string };
        head: { ref: string; sha: string };
      }>
    >(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=100`);
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.state,
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      url: pr.html_url,
      author: pr.user?.login,
    }));
  }

}

function mapStatus(s: string): DiffFile["status"] {
  if (s === "added") return "added";
  if (s === "removed") return "removed";
  if (s === "renamed") return "renamed";
  return "modified";
}
