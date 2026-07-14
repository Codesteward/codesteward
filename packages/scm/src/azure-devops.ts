import type {
  DiffFile,
  PostedComment,
  PostedReview,
  PullRequest,
  Repository,
  ReviewComment,
  ScmProvider,
} from "./types.js";

export interface AzureDevOpsOptions {
  token?: string;
  org?: string;
  project?: string;
  baseUrl?: string;
  /** Azure AD tenant ID for Service Principal (client credentials) */
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** OAuth scope; default Azure DevOps resource */
  spScope?: string;
  fetchImpl?: typeof fetch;
}

interface SpTokenCache {
  accessToken: string;
  expiresAt: number;
}

/**
 * Azure DevOps REST adapter.
 * Auth:
 * - PAT: AZURE_DEVOPS_TOKEN / opts.token (Basic :pat)
 * - Service Principal: tenantId + clientId + clientSecret → AAD client_credentials → Bearer
 * Env: AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_TENANT_ID, AZURE_DEVOPS_CLIENT_ID, AZURE_DEVOPS_CLIENT_SECRET
 * owner = project (or org), repo = repository name
 */
export class AzureDevOpsScm implements ScmProvider {
  readonly name = "azure-devops";
  private readonly token: string | undefined;
  private readonly org: string;
  private readonly project: string;
  private readonly baseUrl: string;
  private readonly tenantId: string | undefined;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly spScope: string;
  private readonly fetchImpl: typeof fetch;
  private spCache: SpTokenCache | null = null;

  constructor(opts: AzureDevOpsOptions = {}) {
    this.token = opts.token ?? process.env.AZURE_DEVOPS_TOKEN ?? process.env.AZDO_PAT;
    this.org = opts.org ?? process.env.AZURE_DEVOPS_ORG ?? "";
    this.project = opts.project ?? process.env.AZURE_DEVOPS_PROJECT ?? "";
    this.baseUrl = (
      opts.baseUrl ??
      process.env.AZURE_DEVOPS_API_URL ??
      "https://dev.azure.com"
    ).replace(/\/$/, "");
    this.tenantId =
      opts.tenantId ?? process.env.AZURE_DEVOPS_TENANT_ID ?? process.env.AZURE_TENANT_ID;
    this.clientId =
      opts.clientId ?? process.env.AZURE_DEVOPS_CLIENT_ID ?? process.env.AZURE_CLIENT_ID;
    this.clientSecret =
      opts.clientSecret ??
      process.env.AZURE_DEVOPS_CLIENT_SECRET ??
      process.env.AZURE_CLIENT_SECRET;
    this.spScope =
      opts.spScope ??
      process.env.AZURE_DEVOPS_SP_SCOPE ??
      "499b84ac-1321-427f-aa17-267ca6975798/.default";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** True when Service Principal credentials are present. */
  usesServicePrincipal(): boolean {
    return Boolean(this.tenantId && this.clientId && this.clientSecret);
  }

  private async resolveAccessToken(): Promise<{ kind: "pat" | "sp"; value: string } | null> {
    if (this.usesServicePrincipal()) {
      const now = Date.now();
      if (this.spCache && this.spCache.expiresAt > now + 60_000) {
        return { kind: "sp", value: this.spCache.accessToken };
      }
      const url = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
      const body = new URLSearchParams({
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
        scope: this.spScope,
        grant_type: "client_credentials",
      });
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Azure DevOps SP token exchange failed ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const json = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!json.access_token) {
        throw new Error("Azure DevOps SP token response missing access_token");
      }
      this.spCache = {
        accessToken: json.access_token,
        expiresAt: now + (json.expires_in ?? 3600) * 1000,
      };
      return { kind: "sp", value: json.access_token };
    }
    if (this.token) return { kind: "pat", value: this.token };
    return null;
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "codesteward-review",
    };
    const auth = await this.resolveAccessToken();
    if (auth?.kind === "sp") {
      h.Authorization = `Bearer ${auth.value}`;
    } else if (auth?.kind === "pat") {
      const basic = Buffer.from(`:${auth.value}`).toString("base64");
      h.Authorization = `Basic ${basic}`;
    }
    return h;
  }

  private projectOf(owner: string): string {
    // Allow owner to encode "org/project" or just project when org is set via env
    if (owner.includes("/")) return owner.split("/").pop()!;
    return owner || this.project;
  }

  private orgOf(owner: string): string {
    if (owner.includes("/")) return owner.split("/")[0]!;
    return this.org;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}${path}${sep}api-version=7.1`;
    const authHeaders = await this.headers();
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...authHeaders, ...(init?.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Azure DevOps API ${res.status} ${path}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest> {
    const org = this.orgOf(owner);
    const project = this.projectOf(owner);
    const pr = await this.api<{
      pullRequestId: number;
      title: string;
      description?: string;
      status: string;
      url?: string;
      createdBy?: { displayName?: string; uniqueName?: string };
      sourceRefName?: string;
      targetRefName?: string;
      lastMergeSourceCommit?: { commitId?: string };
      lastMergeTargetCommit?: { commitId?: string };
    }>(`/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${number}`);

    return {
      number: pr.pullRequestId,
      title: pr.title,
      body: pr.description ?? "",
      state: pr.status?.toLowerCase() ?? "active",
      baseBranch: stripRefs(pr.targetRefName),
      headBranch: stripRefs(pr.sourceRefName),
      baseSha: pr.lastMergeTargetCommit?.commitId ?? "",
      headSha: pr.lastMergeSourceCommit?.commitId ?? "",
      url: pr.url ?? "",
      author: pr.createdBy?.uniqueName ?? pr.createdBy?.displayName,
    };
  }

  async getDiff(owner: string, repo: string, number: number): Promise<DiffFile[]> {
    const org = this.orgOf(owner);
    const project = this.projectOf(owner);
    // iterations latest
    const iters = await this.api<{
      value?: Array<{ id: number }>;
    }>(
      `/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${number}/iterations`,
    );
    const latest = iters.value?.[iters.value.length - 1]?.id ?? 1;
    const changes = await this.api<{
      changeEntries?: Array<{
        changeType?: string;
        item?: { path?: string };
        originalPath?: string;
      }>;
    }>(
      `/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${number}/iterations/${latest}/changes`,
    );

    return (changes.changeEntries ?? []).map((c) => {
      const path = (c.item?.path ?? c.originalPath ?? "").replace(/^\//, "");
      return {
        path,
        status: mapAdoStatus(c.changeType),
        previousPath: c.originalPath?.replace(/^\//, ""),
        additions: 0,
        deletions: 0,
        // ADO does not return unified patches in this endpoint; leave undefined
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
    const org = this.orgOf(owner);
    const project = this.projectOf(owner);

    // Create a comment thread on the PR
    const thread = await this.api<{ id: number }>(
      `/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${number}/threads`,
      {
        method: "POST",
        body: JSON.stringify({
          comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
          status: 1,
        }),
      },
    );

    for (const c of comments.slice(0, 25)) {
      try {
        await this.api(
          `/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${number}/threads`,
          {
            method: "POST",
            body: JSON.stringify({
              comments: [{ parentCommentId: 0, content: c.body, commentType: 1 }],
              status: 1,
              threadContext: c.line
                ? {
                    filePath: c.path.startsWith("/") ? c.path : `/${c.path}`,
                    rightFileStart: { line: c.line, offset: 1 },
                    rightFileEnd: { line: c.line, offset: 1 },
                  }
                : { filePath: c.path.startsWith("/") ? c.path : `/${c.path}` },
            }),
          },
        );
      } catch {
        /* best-effort */
      }
    }

    return { id: String(thread.id) };
  }

  async postComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<PostedComment> {
    const posted = await this.postReview(owner, repo, number, body, []);
    return { id: posted.id, htmlUrl: posted.htmlUrl };
  }

  async listRepos(owner: string): Promise<Repository[]> {
    const org = this.orgOf(owner);
    const project = this.projectOf(owner);
    const res = await this.api<{
      value?: Array<{
        name: string;
        remoteUrl?: string;
        isDisabled?: boolean;
        defaultBranch?: string;
        project?: { name?: string };
      }>;
    }>(`/${org}/${encodeURIComponent(project)}/_apis/git/repositories`);
    return (res.value ?? []).map((r) => ({
      fullName: `${project}/${r.name}`,
      defaultBranch: stripRefs(r.defaultBranch) || "main",
      private: true,
      url: r.remoteUrl ?? "",
    }));
  }

  async listAuthenticatedRepos(): Promise<Repository[]> {
    if (!this.org) return [];
    // List repos across default project, or all projects if project empty
    if (this.project) {
      return this.listRepos(this.project);
    }
    const projects = await this.api<{ value?: Array<{ name: string }> }>(
      `/${this.org}/_apis/projects?api-version=7.1`,
    );
    const out: Repository[] = [];
    for (const p of projects.value ?? []) {
      try {
        const repos = await this.listRepos(p.name);
        out.push(...repos);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async listPullRequests(
    owner: string,
    repo: string,
    opts: { state?: "open" | "closed" | "all" } = {},
  ): Promise<PullRequest[]> {
    const org = this.orgOf(owner);
    const project = this.projectOf(owner);
    const status =
      opts.state === "closed" ? "completed" : opts.state === "all" ? "all" : "active";
    const res = await this.api<{
      value?: Array<{
        pullRequestId: number;
        title: string;
        description?: string;
        status: string;
        createdBy?: { displayName?: string; uniqueName?: string };
        sourceRefName?: string;
        targetRefName?: string;
        lastMergeSourceCommit?: { commitId?: string };
        lastMergeTargetCommit?: { commitId?: string };
        url?: string;
      }>;
    }>(
      `/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.status=${status}&api-version=7.1`,
    );
    return (res.value ?? []).map((pr) => ({
      number: pr.pullRequestId,
      title: pr.title,
      body: pr.description ?? "",
      state: pr.status === "active" ? "open" : pr.status,
      baseBranch: stripRefs(pr.targetRefName),
      headBranch: stripRefs(pr.sourceRefName),
      baseSha: pr.lastMergeTargetCommit?.commitId ?? "",
      headSha: pr.lastMergeSourceCommit?.commitId ?? "",
      url: pr.url ?? "",
      author: pr.createdBy?.displayName ?? pr.createdBy?.uniqueName,
    }));
  }

}

function stripRefs(ref?: string): string {
  if (!ref) return "";
  return ref.replace(/^refs\/heads\//, "");
}

function mapAdoStatus(t?: string): DiffFile["status"] {
  const s = (t ?? "").toLowerCase();
  if (s.includes("add")) return "added";
  if (s.includes("delete")) return "removed";
  if (s.includes("rename")) return "renamed";
  return "modified";
}
