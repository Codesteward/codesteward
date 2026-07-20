export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  url: string;
  author?: string;
}

/** Issue used for linked PR context (Fixes #n, etc.). */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  url?: string;
  labels?: string[];
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  patch?: string;
  previousPath?: string;
  additions: number;
  deletions: number;
}

export interface ReviewComment {
  path: string;
  line?: number;
  body: string;
  side?: "LEFT" | "RIGHT";
}

export interface PostedReview {
  id: string;
  htmlUrl?: string;
}

export interface PostedComment {
  id: string;
  htmlUrl?: string;
}

export interface Repository {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  url: string;
}

export interface CheckRunInput {
  name: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "skipped";
  title?: string;
  summary?: string;
  text?: string;
  detailsUrl?: string;
  /** Update existing check run when set */
  checkRunId?: string;
}

export interface PostedCheckRun {
  id: string;
  htmlUrl?: string;
  status: string;
  conclusion?: string;
}

/** Upload third-party analysis to GitHub Code Scanning (Security tab). */
export interface CodeScanningSarifUpload {
  /** Full commit SHA the analysis applies to */
  commitSha: string;
  /**
   * Git ref, e.g. `refs/heads/main` or `refs/pull/12/head`.
   * Required by GitHub Code Scanning upload API.
   */
  ref: string;
  /** SARIF 2.1.0 object or already-stringified JSON */
  sarif: unknown;
  /** Optional checkout URI (file:///… or https://…) */
  checkoutUri?: string;
  /** Optional wall-clock start of analysis (ISO-8601) */
  startedAt?: string;
  /** Tool name override when not present in SARIF driver */
  toolName?: string;
}

export interface PostedCodeScanningSarif {
  /** GitHub analysis id / sarif id */
  id: string;
  /** URL to poll analysis status when returned */
  url?: string;
}

/** GitHub reaction content values (+ common aliases). */
export type ScmReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export interface ScmProvider {
  readonly name: string;
  getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest>;
  getDiff(owner: string, repo: string, number: number): Promise<DiffFile[]>;
  postReview(
    owner: string,
    repo: string,
    number: number,
    body: string,
    comments?: ReviewComment[],
    event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  ): Promise<PostedReview>;
  postComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<PostedComment>;
  /** Update an existing issue/PR comment body (e.g. progress → failed). */
  updateComment?(
    owner: string,
    repo: string,
    commentId: string | number,
    body: string,
  ): Promise<PostedComment>;
  /**
   * List PR review comments (inline on files). GitHub: pulls comments API.
   * Used to map posted bodies → comment ids and resolve threads on re-review.
   */
  listPullReviewComments?(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{ id: string; path?: string; body: string; htmlUrl?: string }>>;
  /**
   * Resolve a PR review thread that contains a given review comment id and/or
   * fingerprint/finding markers in the comment body. GitHub GraphQL.
   * Returns true if a thread was resolved (or already resolved).
   */
  resolveReviewThreadForComment?(
    owner: string,
    repo: string,
    prNumber: number,
    match: {
      commentId?: string | number;
      fingerprint?: string;
      findingId?: string;
    },
  ): Promise<{ resolved: boolean; threadId?: string; alreadyResolved?: boolean }>;
  /**
   * Upload SARIF to GitHub Code Scanning so findings appear under Security → Code scanning.
   * GitHub only; requires code scanning enabled and token with `security_events: write`.
   */
  uploadCodeScanningSarif?(
    owner: string,
    repo: string,
    input: CodeScanningSarifUpload,
  ): Promise<PostedCodeScanningSarif>;
  /**
   * Optional SCM reaction (GitHub: eyes/rocket/etc on issue/PR or issue comment).
   * Used for "agent saw your request" feedback on webhook-triggered reviews only.
   */
  createReaction?(
    owner: string,
    repo: string,
    target: {
      /** PR / issue number (GitHub issues API covers PRs) */
      issueNumber?: number;
      /** Issue comment id (e.g. @mention that triggered review) */
      commentId?: string | number;
    },
    content: ScmReactionContent,
  ): Promise<{ id: string } | undefined>;
  listRepos(owner: string): Promise<Repository[]>;
  /** Authenticated user's repos (optional; falls back to listRepos). */
  listAuthenticatedRepos?(): Promise<Repository[]>;
  /** List open (or all) PRs/MRs for a repository. */
  listPullRequests?(
    owner: string,
    repo: string,
    opts?: { state?: "open" | "closed" | "all" },
  ): Promise<PullRequest[]>;
  /**
   * Fetch a single issue (for linked PR context: Fixes #n).
   * Optional — providers without issues API skip linked-issue enrichment.
   */
  getIssue?(owner: string, repo: string, number: number): Promise<Issue>;
  /**
   * GitHub Checks API (or provider equivalent). Used for required status /
   * branch protection — stronger than PR review events alone.
   */
  postCheckRun?(
    owner: string,
    repo: string,
    input: CheckRunInput,
  ): Promise<PostedCheckRun>;
}
