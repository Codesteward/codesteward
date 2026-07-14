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
   * GitHub Checks API (or provider equivalent). Used for required status /
   * branch protection — stronger than PR review events alone.
   */
  postCheckRun?(
    owner: string,
    repo: string,
    input: CheckRunInput,
  ): Promise<PostedCheckRun>;
}
