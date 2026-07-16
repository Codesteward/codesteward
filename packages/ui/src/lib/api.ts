const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  status: number;
  body: string;
  /** Parsed JSON body when the API returned structured error */
  payload?: {
    error?: string;
    message?: string;
    code?: string;
    feature?: string;
  };
  constructor(status: number, body: string) {
    let payload: ApiError["payload"];
    try {
      payload = JSON.parse(body) as ApiError["payload"];
    } catch {
      payload = undefined;
    }
    const friendly =
      payload?.message ||
      payload?.error ||
      (body && !body.startsWith("{") ? body : null) ||
      "request failed";
    super(friendly);
    this.status = status;
    this.body = body;
    this.payload = payload;
    this.name = "ApiError";
  }

  get code(): string | undefined {
    return this.payload?.code;
  }

  get isPlanGate(): boolean {
    return (
      this.status === 402 ||
      this.code === "ORG_LICENSE_REQUIRED" ||
      this.code === "LICENSE_REQUIRED" ||
      this.code === "SEAT_LIMIT"
    );
  }
}

/** Human copy for plan/seat gates (UI banners). */
export function describePlanGate(err: unknown): {
  title: string;
  body: string;
  planRequired: "pro" | "enterprise" | "paid" | null;
  isSeatLimit: boolean;
} | null {
  if (!(err instanceof ApiError) || !err.isPlanGate) {
    // Also accept raw Error messages that still look like 402 JSON dumps
    if (err instanceof Error) {
      const m = err.message;
      if (m.includes("ORG_LICENSE_REQUIRED") || m.startsWith("402 ")) {
        try {
          const jsonStart = m.indexOf("{");
          const parsed = jsonStart >= 0 ? JSON.parse(m.slice(jsonStart)) : null;
          return describePlanGate(
            Object.assign(new ApiError(402, JSON.stringify(parsed ?? { message: m })), {}),
          );
        } catch {
          return {
            title: "Upgrade required",
            body: m.replace(/^402\s*/, "").slice(0, 280),
            planRequired: "paid",
            isSeatLimit: false,
          };
        }
      }
    }
    return null;
  }
  const code = err.code;
  const msg = err.message;
  if (code === "SEAT_LIMIT" || /seat limit/i.test(msg)) {
    return {
      title: "Seat limit reached",
      body:
        msg ||
        "Your organization has used all purchased seats. Buy more seats under Billing before inviting members.",
      planRequired: null,
      isSeatLimit: true,
    };
  }
  const lower = msg.toLowerCase();
  let planRequired: "pro" | "enterprise" | "paid" = "paid";
  if (lower.includes("enterprise") && !lower.includes("pro or enterprise")) {
    planRequired = "enterprise";
  } else if (lower.includes("pro")) {
    planRequired = "pro";
  }
  // Clean server message: drop trailing (org=…, plan/tier=…)
  const body = msg.replace(/\s*\(org=[^)]+\)\s*$/i, "").trim() || msg;
  return {
    title:
      planRequired === "enterprise"
        ? "Enterprise plan required"
        : planRequired === "pro"
          ? "Pro plan required"
          : "Upgrade required",
    body,
    planRequired,
    isSeatLimit: false,
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  try {
    // Prefer Keycloak access_token (JWT); then legacy session; then API key
    let token: string | null = null;
    try {
      const { getAccessToken } = await import("./oidc.js");
      token = await getAccessToken();
    } catch {
      /* oidc not available */
    }
    if (!token) token = localStorage.getItem("cs-session-token");
    if (!token) token = localStorage.getItem("cs-api-key");
    if (token) headers.Authorization = `Bearer ${token}`;
    const org = localStorage.getItem("cs-org-id");
    if (org) headers["X-Org-Id"] = org;
  } catch {
    /* privacy mode */
  }
  return headers;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...(init?.headers as Record<string, string>),
  };
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      try {
        window.dispatchEvent(new CustomEvent("cs:unauthorized"));
      } catch {
        /* ignore */
      }
    }
    // Stale X-Org-Id (e.g. cached "local") or brand-new user with no memberships
    if (res.status === 403) {
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string; error?: string };
        const msg = `${parsed.message ?? ""} ${parsed.error ?? ""} ${text}`.toLowerCase();
        if (
          parsed.code === "ORG_REQUIRED" ||
          msg.includes("not a member of org") ||
          msg.includes("org_required")
        ) {
          const bad = localStorage.getItem("cs-org-id");
          if (bad) localStorage.removeItem("cs-org-id");
          window.dispatchEvent(
            new CustomEvent("cs:org-required", {
              detail: { message: parsed.message, code: parsed.code },
            }),
          );
        }
      } catch {
        /* not json */
      }
    }
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** After login / me: pick a valid org or clear a stale cached id (e.g. leftover "local"). */
export async function resolveActiveOrg(): Promise<{
  orgs: OrgSummary[];
  needsOrg: boolean;
  orgId: string | null;
}> {
  // Clear stale header first so listOrgs is not blocked by X-Org-Id: local
  const cached = getOrgId();
  try {
    const me = await api.authMe();
    const orgs =
      me.orgs ??
      (await api.listOrgs().then((r) => r.orgs).catch(() => [] as OrgSummary[]));
    if (!orgs.length) {
      if (cached) setOrgId(null);
      return { orgs: [], needsOrg: Boolean(me.needsOrg ?? true), orgId: null };
    }
    if (cached && orgs.some((o) => o.id === cached)) {
      return { orgs, needsOrg: false, orgId: cached };
    }
    const next = me.user?.orgId && orgs.some((o) => o.id === me.user!.orgId)
      ? me.user.orgId
      : orgs[0]!.id;
    setOrgId(next);
    return { orgs, needsOrg: false, orgId: next };
  } catch {
    try {
      const r = await api.listOrgs();
      if (!r.orgs.length) {
        if (cached) setOrgId(null);
        return { orgs: [], needsOrg: true, orgId: null };
      }
      if (cached && r.orgs.some((o) => o.id === cached)) {
        return { orgs: r.orgs, needsOrg: false, orgId: cached };
      }
      setOrgId(r.orgs[0]!.id);
      return { orgs: r.orgs, needsOrg: false, orgId: r.orgs[0]!.id };
    } catch {
      if (cached) setOrgId(null);
      return { orgs: [], needsOrg: true, orgId: null };
    }
  }
}

export const api = {
  health: () => req<{ ok: boolean; service?: string }>("/healthz"),
  readyz: () => req<{ ready: boolean }>("/v1/readyz"),

  // Auth
  authStatus: () =>
    req<{
      authRequired: boolean;
      bootstrapRequired?: boolean;
      mode: string;
      hint?: string;
      userCount?: number;
      oidc?: { status?: string; issuer?: string };
      worker?: WorkerStatus;
      identityMode?: "keycloak" | "local" | string;
      keycloakIdentity?: boolean;
    }>("/v1/auth/status"),
  identityStatus: () =>
    req<{
      mode: string;
      keycloak: boolean;
      oidc: { status?: string; issuer?: string; error?: string };
      adminConfigured: boolean;
      admin: { ok: boolean; realm?: string; error?: string } | null;
      note?: string;
    }>("/v1/identity/status"),
  authBootstrap: (body: { email: string; password: string; name?: string }) =>
    req<{ ok: boolean; user: AuthUser; token: string }>("/v1/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  authLogin: (body: { email: string; password: string }) =>
    req<{ ok: boolean; user: AuthUser; token: string }>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProfile: (body: { displayName?: string; email?: string }) =>
    req<{ user: AuthUser }>("/v1/auth/me", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    req<{ ok: boolean; message?: string }>("/v1/auth/me/password", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateOrg: (orgId: string, body: { name?: string; slug?: string }) =>
    req<{ org: OrgSummary }>(`/v1/orgs/${encodeURIComponent(orgId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  authMe: () =>
    req<{
      user: AuthUser | null;
      authMode?: string;
      orgs?: OrgSummary[];
      needsOrg?: boolean;
    }>("/v1/auth/me"),
  authLogout: (body?: { idToken?: string; postLogoutRedirectUri?: string }) =>
    req<{ ok: boolean; idpLogoutUrl?: string }>("/v1/auth/logout", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  oidcStatus: () =>
    req<{
      status: "ready" | "misconfigured" | "optional_not_configured";
      issuer?: string;
      error?: string;
      authorizationEndpoint?: string;
      clientId?: string;
    }>("/v1/auth/oidc/status"),
  oidcLogin: (returnTo?: string) => {
    const q = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
    return req<{ url: string; state?: string }>(`/v1/auth/oidc/login${q}`);
  },
  listUsers: () =>
    req<{
      users: Array<{
        id: string;
        email: string;
        displayName?: string;
        role: string;
        orgId?: string;
        createdAt?: string;
      }>;
    }>("/v1/auth/users"),
  createUser: (body: {
    email: string;
    password: string;
    displayName?: string;
    role?: "admin" | "reviewer" | "viewer";
    orgId?: string;
  }) =>
    req<{ user: AuthUser }>("/v1/auth/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Orgs & membership
  listOrgs: () =>
    req<{ orgs: OrgSummary[] }>("/v1/orgs"),
  createOrg: (body: {
    name: string;
    slug?: string;
    planId?: string;
    seats?: number;
    billingEmail?: string;
  }) =>
    req<{ org: OrgSummary; plan?: string; note?: string }>("/v1/orgs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  billingStatus: () =>
    req<{
      configured: boolean;
      saasMode?: boolean;
      publicUrl?: string | null;
      plans: Array<{
        id: string;
        label: string;
        description?: string;
        priceLabel?: string;
        highlights?: string[];
        pricing?: string;
        requiresSeatPurchase?: boolean;
        minSeats?: number;
        maxSeats?: number;
        defaultSeats?: number;
        pricePerSeatCents?: number | null;
      }>;
      note?: string;
    }>("/v1/billing/status"),
  openBillingPortal: (body?: { returnTo?: string }) =>
    req<{
      url: string;
      orgId: string;
      expiresInSeconds?: number;
      note?: string;
    }>("/v1/org/billing/portal", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  listMembers: (orgId: string) =>
    req<{ members: OrgMember[] }>(`/v1/orgs/${encodeURIComponent(orgId)}/members`),
  updateMember: (orgId: string, userId: string, body: { role: string }) =>
    req<{ member: OrgMember }>(
      `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  removeMember: (orgId: string, userId: string) =>
    req<{ deleted: boolean }>(
      `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    ),
  inviteMember: (orgId: string, body: { email: string; role?: string }) =>
    req<{
      invitation: {
        id: string;
        orgId: string;
        email: string;
        role: string;
        expiresAt: string;
        token: string;
        acceptPath: string;
      };
    }>(`/v1/orgs/${encodeURIComponent(orgId)}/invitations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listInvitations: (orgId: string) =>
    req<{
      invitations: Array<{
        id: string;
        email: string;
        role: string;
        expiresAt: string;
        createdAt: string;
      }>;
    }>(`/v1/orgs/${encodeURIComponent(orgId)}/invitations`),

  sessions: () => req<{ sessions: Session[] }>("/v1/sessions"),
  session: (id: string) => req<{ session: Session }>(`/v1/sessions/${id}`),
  sessionAudit: (id: string) =>
    req<{ sessionId: string; audit: SessionAudit | null; hint?: string }>(
      `/v1/sessions/${id}/audit`,
    ),
  orgAudit: (params?: {
    limit?: number;
    offset?: number;
    action?: string;
    actionPrefix?: string;
    actor?: string;
    resourceType?: string;
    outcome?: string;
    since?: string;
    until?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset != null) q.set("offset", String(params.offset));
    if (params?.action) q.set("action", params.action);
    if (params?.actionPrefix) q.set("actionPrefix", params.actionPrefix);
    if (params?.actor) q.set("actor", params.actor);
    if (params?.resourceType) q.set("resourceType", params.resourceType);
    if (params?.outcome) q.set("outcome", params.outcome);
    if (params?.since) q.set("since", params.since);
    if (params?.until) q.set("until", params.until);
    const qs = q.toString();
    return req<{
      orgId: string;
      events: Array<{
        id: string;
        action: string;
        orgId?: string;
        actorUserId?: string;
        resourceType?: string;
        resourceId?: string;
        metadata?: Record<string, unknown>;
        ip?: string;
        userAgent?: string;
        requestId?: string;
        outcome?: string;
        createdAt: string;
      }>;
      count: number;
      total?: number;
      limit?: number;
      offset?: number;
      retentionDays?: number;
    }>(`/v1/org/audit${qs ? `?${qs}` : ""}`);
  },
  pruneAudit: (body?: { retentionDays?: number }) =>
    req<{ ok: boolean; deleted: number }>("/v1/org/audit/prune", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  orgLangfuse: () =>
    req<{
      orgId: string;
      entitled: boolean;
      config: {
        enabled: boolean;
        publicKeySet: boolean;
        publicKeyHint?: string;
        secretKeySet: boolean;
        baseUrl?: string;
      };
      destinations?: Array<{ source: string; baseUrl?: string; publicKeyHint?: string }>;
      dualWrite?: boolean;
      /** @deprecated use destinations */
      effective?: { source: string; baseUrl?: string; publicKeyHint?: string } | null;
      platformFallback?: boolean;
      note?: string;
    }>("/v1/org/langfuse"),
  putOrgLangfuse: (body: {
    enabled?: boolean;
    publicKey?: string;
    secretKey?: string;
    baseUrl?: string;
    clear?: boolean;
  }) =>
    req<{
      ok: boolean;
      orgId: string;
      config: {
        enabled: boolean;
        publicKeySet: boolean;
        publicKeyHint?: string;
        secretKeySet: boolean;
        baseUrl?: string;
      };
    }>("/v1/org/langfuse", { method: "PUT", body: JSON.stringify(body) }),
  platformLangfuse: () =>
    req<{
      entitled: boolean;
      config: {
        enabled: boolean;
        publicKeySet: boolean;
        publicKeyHint?: string;
        secretKeySet: boolean;
        baseUrl?: string;
      };
      effective: { source: string; baseUrl?: string; publicKeyHint?: string } | null;
      envFallback: boolean;
      note?: string;
    }>("/v1/platform/langfuse"),
  putPlatformLangfuse: (body: {
    enabled?: boolean;
    publicKey?: string;
    secretKey?: string;
    baseUrl?: string;
    clear?: boolean;
  }) =>
    req<{
      ok: boolean;
      config: {
        enabled: boolean;
        publicKeySet: boolean;
        publicKeyHint?: string;
        secretKeySet: boolean;
        baseUrl?: string;
      };
    }>("/v1/platform/langfuse", { method: "PUT", body: JSON.stringify(body) }),
  platformGithubApp: () =>
    req<{
      config: {
        enforce?: boolean;
        allowOrgPat?: boolean;
        appId?: string | null;
        clientId?: string | null;
        baseUrl?: string | null;
        slug?: string | null;
        privateKeyConfigured?: boolean;
        privateKeyRef?: string | null;
        webhookSecretConfigured?: boolean;
        updatedAt?: string | null;
      } | null;
      policy: {
        enforce: boolean;
        allowOrgPat: boolean;
        configured: boolean;
        source: string;
        appId?: string | null;
        slug?: string | null;
      };
      envBootstrap?: Record<string, string | null>;
      note?: string;
    }>("/v1/platform/github-app"),
  putPlatformGithubApp: (body: {
    enforce?: boolean;
    allowOrgPat?: boolean;
    appId?: string;
    clientId?: string;
    privateKeyPem?: string;
    privateKeyRef?: string;
    webhookSecret?: string;
    baseUrl?: string;
    slug?: string;
    clear?: boolean;
  }) =>
    req<{ ok: boolean; config: unknown; note?: string }>("/v1/platform/github-app", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  scimStatus: () =>
    req<{
      orgId: string;
      orgSlug?: string;
      multiTenant?: boolean;
      entitled: boolean;
      planRequired?: "enterprise" | string | null;
      tokenConfigured: boolean;
      tokens?: Array<{ id: string; label?: string; last4: string; createdAt: string; lastUsedAt?: string }>;
      hardDelete: boolean;
      baseUrl: string;
      endpoints: Record<string, string>;
      legacyUnscopedBase?: string;
      auth: { header: string; note: string };
      roleGroups: string[];
    }>("/v1/org/scim"),
  mintScimToken: (body?: { label?: string }) =>
    req<{
      ok: boolean;
      token: string;
      meta: { id: string; orgId: string; label?: string; last4: string; createdAt: string };
      warning?: string;
    }>("/v1/org/scim/tokens", { method: "POST", body: JSON.stringify(body ?? {}) }),
  revokeScimToken: (id: string) =>
    req<{ ok: boolean; revoked: boolean }>(`/v1/org/scim/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  orgAuditNdjsonUrl: () => {
    const base = `${API_URL}/v1/org/audit?format=ndjson`;
    return base;
  },
  cancelSession: (id: string) =>
    req<{ session: Session }>(`/v1/sessions/${id}/cancel`, { method: "POST" }),
  resumeSession: (id: string, paths?: string[]) =>
    req<{ job: Job; session: Session }>(`/v1/sessions/${id}/start`, {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),
  sessionFindings: (id: string) =>
    req<{ findings: Finding[] }>(`/v1/sessions/${id}/findings`),
  eventsUrl: (sessionId: string) => {
    const base = `${API_URL}/v1/sessions/${sessionId}/events`;
    try {
      // EventSource cannot set Authorization headers — pass token as query param
      const session = localStorage.getItem("cs-session-token");
      const key = localStorage.getItem("cs-api-key");
      const token = session || key;
      if (token) {
        return `${base}?access_token=${encodeURIComponent(token)}`;
      }
    } catch {
      /* privacy mode */
    }
    return base;
  },

  findings: (params?: {
    sessionId?: string;
    severity?: string;
    status?: string;
    repoId?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.sessionId) q.set("sessionId", params.sessionId);
    if (params?.severity) q.set("severity", params.severity);
    if (params?.status) q.set("status", params.status);
    if (params?.repoId) q.set("repoId", params.repoId);
    const qs = q.toString();
    return req<{ findings: Finding[]; repos?: string[] }>(
      `/v1/findings${qs ? `?${qs}` : ""}`,
    );
  },
  reports: (params?: { repoId?: string; mode?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.repoId) q.set("repoId", params.repoId);
    if (params?.mode) q.set("mode", params.mode);
    if (params?.limit != null) q.set("limit", String(params.limit));
    const qs = q.toString();
    return req<{ reports: SessionReportIndexItem[]; repos: string[]; total: number }>(
      `/v1/reports${qs ? `?${qs}` : ""}`,
    );
  },
  finding: (id: string) => req<{ finding: Finding }>(`/v1/findings/${id}`),
  patchFinding: (id: string, body: Partial<Finding> & Record<string, unknown>) =>
    req<{ finding: Finding }>(`/v1/findings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /**
   * Train learning: 👍/👎 hits POST /v1/findings/:id/react (org memories + suppress).
   * Clearing (null) only removes the display tag — memories stay.
   */
  reactFinding: async (
    id: string,
    reaction: "up" | "down" | null,
    existingTags: string[] = [],
  ) => {
    if (reaction === null) {
      const cleaned = existingTags.filter((t) => !t.startsWith("reaction:"));
      return api.patchFinding(id, { tags: cleaned });
    }
    return req<{ reaction: unknown; finding: Finding }>(`/v1/findings/${id}/react`, {
      method: "POST",
      body: JSON.stringify({ reaction }),
    });
  },

  links: () => req<{ links: RepoLink[] }>("/v1/org/repo-links"),
  putLink: (body: Partial<RepoLink> & { fromRepoId: string; toRepoId: string }) =>
    req<{ link: RepoLink }>("/v1/org/repo-links", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteLink: (id: string) =>
    req<{ deleted: boolean }>(`/v1/org/repo-links/${id}`, { method: "DELETE" }),
  previewLinks: (body: { repoId: string; paths?: string[]; tenantId?: string }) =>
    req<Record<string, unknown>>("/v1/org/repo-links/preview", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getPromptPack: (role?: string) => {
    const q = role ? `?role=${encodeURIComponent(role)}` : "";
    return req<{
      defaults: unknown;
      pack: unknown | null;
      effective: unknown;
      catalog: Array<{
        id: string;
        label: string;
        kind: string;
        description: string;
        maxChars: number;
      }>;
      limits?: {
        components: Record<string, number>;
        roleEditableSystemMax: number;
        roleEditableUserMax: number;
      };
      roles: string[];
      previewRole: string;
      preview: unknown;
      learningPreviewChars?: number;
      note?: string;
    }>(`/v1/org/prompt-pack${q}`);
  },
  putPromptPack: (body: { pack?: unknown; reset?: boolean }) =>
    req<{ ok: boolean; pack: unknown | null; effective: unknown; reset?: boolean }>(
      "/v1/org/prompt-pack",
      { method: "PUT", body: JSON.stringify(body) },
    ),
  previewPromptPack: (body: { role?: string; pack?: unknown; repoId?: string }) =>
    req<{
      role: string;
      preview: unknown;
      learningPreviewChars?: number;
      learningInjected?: boolean;
    }>("/v1/org/prompt-pack/preview", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  models: () => req<ModelProfile>("/v1/org/model-profiles"),
  putModels: (body: {
    defaultProvider?: string;
    defaultModel?: string;
    strongModel?: string;
    cheapModel?: string;
    roles?: Record<string, { provider?: string; model?: string; baseUrl?: string; apiKeyRef?: string }>;
    /** Per-org provider secrets — empty apiKey keeps existing; "__clear__" removes */
    providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
  }) =>
    req<{ ok: boolean; modelMatrix: unknown }>("/v1/org/model-profiles", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  license: () =>
    req<{
      license: LicenseInfo;
      plan?: {
        id?: string;
        status?: string;
        seats?: number;
        customerName?: string;
        source: "billing" | "license" | "open";
      } | null;
      billingConfigured?: boolean;
      features?: Array<{ id: string; label: string; description: string; enabled: boolean }>;
      catalog?: Array<{ id: string; label: string; description: string }>;
      openMode?: boolean;
      hideLicenseUi?: boolean;
      upload?: {
        path: string;
        formats: string[];
        note: string;
        filePath?: string;
        disabled?: boolean;
      };
    }>("/v1/org/license"),
  installLicense: (key: string) =>
    req<{
      ok: boolean;
      license: LicenseInfo;
      features?: Array<{ id: string; label: string; description: string; enabled: boolean }>;
      error?: string;
    }>("/v1/org/license", {
      method: "PUT",
      body: JSON.stringify({ key }),
    }),
  clearLicense: () =>
    req<{ ok: boolean; license: LicenseInfo }>("/v1/org/license", { method: "DELETE" }),
  testModel: (body?: { role?: string }) =>
    req<{ ok: boolean; content: string; model: string; provider: string; role?: string }>(
      "/v1/org/model-profiles/test",
      { method: "POST", body: JSON.stringify(body ?? {}) },
    ),

  // Policy
  getPolicy: () =>
    req<{ orgId: string; content: string; source: string; note?: string }>("/v1/org/policy"),
  putPolicy: (body: { content: string }) =>
    req<{ ok: boolean; orgId: string; bytes: number }>("/v1/org/policy", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // Org / repo / PR memories (learnings)
  listMemories: (params?: {
    repoId?: string;
    prKey?: string;
    scope?: "org" | "repo" | "pr";
    polarity?: "positive" | "negative";
    applicable?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params?.repoId) q.set("repoId", params.repoId);
    if (params?.prKey) q.set("prKey", params.prKey);
    if (params?.scope) q.set("scope", params.scope);
    if (params?.polarity) q.set("polarity", params.polarity);
    if (params?.applicable) q.set("applicable", "1");
    const qs = q.toString();
    return req<{ memories: OrgMemory[] }>(`/v1/org/memories${qs ? `?${qs}` : ""}`);
  },
  createMemory: (body: {
    orgId?: string;
    scope?: "org" | "repo" | "pr";
    repoId?: string;
    prKey?: string;
    prNumber?: number;
    kind?: string;
    polarity?: "positive" | "negative";
    fingerprint?: string;
    pattern?: string;
    title?: string;
    body?: string;
    source?: string;
    weight?: number;
  }) =>
    req<{ memory: OrgMemory }>("/v1/org/memories", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  moveMemoryScope: (
    id: string,
    body: {
      scope: "org" | "repo" | "pr";
      repoId?: string;
      prKey?: string;
      prNumber?: number;
    },
  ) =>
    req<{ memory: OrgMemory }>(`/v1/org/memories/${encodeURIComponent(id)}/scope`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteMemory: (id: string) =>
    req<{ deleted: boolean; message?: string }>(`/v1/org/memories/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // Analytics
  addressRate: (params?: { minSeverity?: string }) => {
    const q = new URLSearchParams();
    if (params?.minSeverity) q.set("minSeverity", params.minSeverity);
    const qs = q.toString();
    return req<AddressRateAnalytics>(`/v1/analytics/address-rate${qs ? `?${qs}` : ""}`);
  },

  // Connectors
  connectors: () => req<{ connectors: Connector[] }>("/v1/org/connectors"),
  githubAppStatus: () =>
    req<{
      authMode: string;
      githubAppConfigured: boolean;
      installationReady?: boolean;
      patConfigured: boolean;
      patDevOnly?: boolean;
      /** False when platform GitHub App is enforced — tenant cannot upload PEMs / create their own App */
      patAllowed?: boolean;
      orgCanConfigureApp?: boolean;
      platformGithubApp?: {
        enforce: boolean;
        configured: boolean;
        source: string;
        appId?: string | null;
        slug?: string | null;
        allowOrgPat?: boolean;
      };
      appId: string | null;
      installations: Array<Record<string, unknown>>;
      detail?: string;
      enterpriseRecommendation: string;
      installPath?: string;
      docs: string;
    }>("/v1/org/connectors/github/status"),
  githubInstall: (orgId?: string) => {
    const id = orgId ?? getOrgId() ?? "local";
    return req<{
      url: string;
      state?: string;
      orgId?: string;
      note?: string;
      error?: string;
      message?: string;
      docs?: string;
    }>(`/v1/scm/github/install?orgId=${encodeURIComponent(id)}`);
  },
  putGitHubApp: (body: Record<string, unknown>) =>
    req<Record<string, unknown>>("/v1/org/connectors/github/app", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteGitHubApp: () =>
    req<{ ok: boolean; cleared?: boolean; installationsRemoved?: number; note?: string }>(
      "/v1/org/connectors/github/app",
      { method: "DELETE" },
    ),
  githubManifest: (opts?: { orgId?: string; githubOrg?: string }) => {
    const q = new URLSearchParams();
    if (opts?.orgId) q.set("orgId", opts.orgId);
    if (opts?.githubOrg) q.set("githubOrg", opts.githubOrg);
    const qs = q.toString();
    return req<{
      manifest: Record<string, unknown>;
      createUrl: string;
      note?: string;
      warnings?: string[];
      webhookPublic?: boolean;
      webhookUrl?: string | null;
      state?: string;
      docs?: string;
    }>(`/v1/scm/github/manifest${qs ? `?${qs}` : ""}`);
  },
  testGitHubApp: () =>
    req<Record<string, unknown>>("/v1/org/connectors/github/app/test", {
      method: "POST",
      body: "{}",
    }),
  /** List GitHub orgs/users where the App is installed (for account selector). */
  listGitHubAppInstallations: (body?: {
    appId?: string;
    privateKeyPem?: string;
    baseUrl?: string;
  }) =>
    req<{
      ok: boolean;
      installations: Array<{
        installationId: string;
        accountLogin: string;
        accountType?: string;
        suspended?: boolean;
        htmlUrl?: string;
        source?: string;
      }>;
      error?: string;
      count?: number;
    }>("/v1/org/connectors/github/app/installations", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  putConnector: (type: string, body: Record<string, unknown>) =>
    req<{ connector: Connector; saved: boolean }>(`/v1/org/connectors/${encodeURIComponent(type)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteConnector: (type: string) =>
    req<{ deleted: boolean }>(`/v1/org/connectors/${encodeURIComponent(type)}`, {
      method: "DELETE",
    }),
  testConnector: (type: string, owner?: string) => {
    const q = owner ? `?owner=${encodeURIComponent(owner)}` : "";
    return req<{ ok: boolean; type: string; result?: unknown; error?: string; hint?: string }>(
      `/v1/org/connectors/${encodeURIComponent(type)}/test${q}`,
      { method: "POST", body: "{}" },
    );
  },

  // SCM
  listRepos: (params?: { owner?: string; provider?: string }) => {
    const q = new URLSearchParams();
    if (params?.owner) q.set("owner", params.owner);
    if (params?.provider) q.set("provider", params.provider);
    const qs = q.toString();
    return req<{
      repos: ScmRepo[];
      errors?: Array<{ provider: string; error: string }>;
    }>(`/v1/scm/repos${qs ? `?${qs}` : ""}`);
  },
  listPrs: (provider: string, owner: string, repo: string) =>
    req<{ prs: ScmPr[]; provider: string; owner: string; repo: string }>(
      `/v1/scm/prs/${encodeURIComponent(provider)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    ),
  getPr: (provider: string, owner: string, repo: string, number: number) =>
    req<{ pr: ScmPr; provider: string; owner: string; repo: string }>(
      `/v1/scm/prs/${encodeURIComponent(provider)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`,
    ),
  getPrDiff: (provider: string, owner: string, repo: string, number: number) =>
    req<{
      provider: string;
      owner: string;
      repo: string;
      number: number;
      pr: ScmPr | null;
      files: DiffFile[];
      diff: string;
      error?: string;
      hint?: string;
    }>(
      `/v1/scm/prs/${encodeURIComponent(provider)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/diff`,
    ),

  startGate: (body: Record<string, unknown>) =>
    req<{ session: Session; job: Job }>("/v1/reviews/gate", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  startSteward: (body: Record<string, unknown>) =>
    req<{ session: Session; job: Job }>("/v1/reviews/stewardship", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  graphStatus: (repoId: string) =>
    req<GraphStatus>(`/v1/repos/${encodeURIComponent(repoId)}/graph/status`),
  graphRebuild: (repoId: string, body?: { repoPath?: string; changedFiles?: string[] }) =>
    req<Record<string, unknown>>(`/v1/repos/${encodeURIComponent(repoId)}/graph/rebuild`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  jobs: () =>
    req<{ jobs: Job[]; worker?: WorkerStatus; message?: string }>("/v1/jobs"),

  /** Org-overridable prefs only (e.g. suggested code fixes). */
  getRuntimeConfig: () =>
    req<{
      orgId: string;
      entries: RuntimeConfigEntry[];
      note: string;
    }>("/v1/org/runtime-config"),
  putRuntimeConfig: (values: Record<string, string | null>) =>
    req<{ orgId: string; entries: RuntimeConfigEntry[] }>("/v1/org/runtime-config", {
      method: "PUT",
      body: JSON.stringify({ values }),
    }),
  /** Install-wide runtime (clone, DeepAgents, graph, worker, …). Platform operators only. */
  getPlatformRuntimeConfig: () =>
    req<{
      entries: RuntimeConfigEntry[];
      note: string;
    }>("/v1/platform/runtime-config"),
  putPlatformRuntimeConfig: (values: Record<string, string | null>) =>
    req<{ entries: RuntimeConfigEntry[] }>("/v1/platform/runtime-config", {
      method: "PUT",
      body: JSON.stringify({ values }),
    }),
  /** Install-wide performance analytics (platform operators only). */
  platformAnalytics: (days = 14) =>
    req<PlatformAnalytics>(`/v1/platform/analytics?days=${days}`),
};

export interface PlatformAnalytics {
  windowDays: number;
  generatedAt: string;
  sessions: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    completedWithErrors: number;
    cancelled: number;
    byMode: Record<string, number>;
    byStage: Record<string, number>;
    successRate: number | null;
  };
  latency: {
    sampleSize: number;
    p50Ms: number | null;
    p95Ms: number | null;
    avgMs: number | null;
    maxMs: number | null;
    byStageAvgMs: Record<string, number>;
    longestStages: Array<{ stage: string; avgMs: number; samples: number }>;
  };
  specialists: {
    runs: number;
    avgMs: number | null;
    maxMs: number | null;
    byRole: Array<{
      role: string;
      runs: number;
      avgMs: number | null;
      maxMs: number | null;
      errorRate: number | null;
    }>;
  };
  workers: {
    jobsPending: number;
    jobsRunning: number;
    jobsDead: number;
    jobsCompletedSample: number;
    distinctWorkers: number;
    workerIds: string[];
    inlineWorker: WorkerStatus & { hint?: string; mode?: string };
  };
  tokens: {
    totalPrompt: number;
    totalCompletion: number;
    total: number;
    estimatedCostUsd: number | null;
    sessionsWithUsage: number;
  };
  recentSlow: Array<{
    sessionId: string;
    repoId: string;
    mode: string;
    totalDurationMs: number;
    longestStage?: string;
    status: string;
    completedAt?: string;
  }>;
}

export interface RuntimeConfigEntry {
  key: string;
  label: string;
  description: string;
  type: "boolean" | "string" | "number" | "enum";
  enumValues?: string[];
  group: string;
  default: string;
  scope?: "platform" | "org";
  value: string;
  source: "env" | "platform" | "org" | "db" | "default";
  envSet: boolean;
  envValue?: string;
  /** Install-wide UI/DB value when set */
  platformValue?: string;
  /** Org override when set */
  orgValue?: string;
  /** @deprecated use orgValue / platformValue */
  dbValue?: string;
  editable: boolean;
  envOnly?: boolean;
  orgEditable?: boolean;
}

/** Session report list item for /v1/reports */
export interface SessionReportIndexItem {
  sessionId: string;
  repoId: string;
  mode: string;
  status: string;
  verdict?: string;
  riskTier?: string;
  depth?: string;
  baseBranch?: string;
  headBranch?: string;
  prNumber?: number;
  createdAt: string;
  completedAt?: string;
  updatedAt?: string;
  headline?: string;
  findingCount?: number;
  severityCounts?: Record<string, number>;
  llmNarrative?: boolean;
  generatedAt?: string;
  markdown?: string;
  codeSource?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt?: string;
  displayName?: string;
  orgId?: string;
  /** Install-wide operator (license / runtime). Not the same as tenant org admin. */
  platformAdmin?: boolean;
}

/** Whether the current auth session may open Platform settings (install-wide). */
export function isPlatformOperator(
  user: AuthUser | null | undefined,
  authMode?: string | null,
): boolean {
  if (authMode === "api_key" || authMode === "dev_open") return true;
  if (!user) return false;
  if (user.id === "api_key" || user.id === "dev") return true;
  return Boolean(user.platformAdmin);
}

export interface OrgSummary {
  id: string;
  name: string;
  slug?: string;
  tenantId?: string;
  createdAt?: string;
  /** Membership role when listed via listOrgsForUser / authMe.orgs */
  role?: string;
}

export interface OrgMember {
  orgId: string;
  userId: string;
  role: string;
  createdAt?: string;
  email?: string;
  displayName?: string;
}

export type LearningScope = "org" | "repo" | "pr";

export interface OrgMemory {
  id: string;
  orgId: string;
  /** org = all repos; repo = one repository; pr = one pull request */
  scope?: LearningScope;
  repoId?: string;
  /** `{repoId}#{prNumber}` when scope is pr */
  prKey?: string;
  kind: string;
  polarity: "positive" | "negative";
  fingerprint?: string;
  pattern?: string;
  title?: string;
  body?: string;
  source?: string;
  weight?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface AddressRateAnalytics {
  orgId: string;
  addressRate: number | null;
  considered: number;
  addressed: number;
  dismissed: number;
  open: number;
  sessions: number;
  completedSessions: number;
  weekBuckets: number[];
  empty: boolean;
  definition?: string;
}

export interface WorkerStatus {
  /** Queue is expected to be drained (inline running or external workers). */
  enabled: boolean;
  /** inline = jobs in API process; external = dedicated worker pods */
  mode?: "inline" | "external";
  inlineEnabled?: boolean;
  running?: boolean;
  processing?: boolean;
  lastClaimAt?: string | null;
  lastExternalClaimAt?: string | null;
  jobsProcessed?: number;
  pollMs?: number;
  hint?: string;
  healthy?: boolean;
  pendingCount?: number;
  runningCount?: number;
}

export interface ReviewUnit {
  id: string;
  sessionId?: string;
  kind?: string;
  label: string;
  paths?: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  assignedRoles?: string[];
  error?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
  discourseNotes?: unknown[];
}

export interface SessionFailureEntry {
  id: string;
  sessionId?: string;
  unitId?: string;
  unitLabel?: string;
  attempt: number;
  strategy?: string;
  error: string;
  recovered?: boolean;
  ts: string;
}

export interface SessionAuditContext {
  repoId: string;
  source: "mount" | "scm_diff" | "clone" | "unverified_mount" | string;
  repoPath?: string;
  workdir?: string;
  verified?: boolean;
  verifiedSha?: string;
  baseSha?: string;
  headSha?: string;
  baseBranch?: string;
  headBranch?: string;
  prNumber?: number;
  pathsRequested?: string[];
  pathsEffective?: string[];
  filesIncluded?: string[];
  filesOmitted?: string[];
  tokenBudget?: number;
  estimatedTokens?: number;
  truncated?: boolean;
  incremental?: boolean;
  graph?: {
    mock?: boolean;
    lastBuild?: string | null;
    degraded?: boolean;
    message?: string;
  };
  notes?: string[];
  preparedAt?: string;
}

export interface SpecialistRunAudit {
  id: string;
  unitId: string;
  unitLabel?: string;
  role: string;
  runner?: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: string;
  findingCount: number;
  error?: string;
  responseExcerpt?: string;
  responseSha256?: string;
  toolCallCount?: number;
  pathsReviewed?: string[];
  filesReviewed?: string[];
  avgConfidence?: number;
  usedGraph?: boolean;
  stepIndex?: number;
  timedOut?: boolean;
  timeoutMs?: number;
  findingsSummary?: Array<{
    title: string;
    severity?: string;
    /** Product (evidence-derived) confidence */
    confidence?: number;
    modelConfidence?: number;
    tokenConfidence?: number;
    path?: string;
    startLine?: number;
    category?: string;
  }>;
}

export interface SessionAudit {
  version: number;
  sessionId: string;
  context: SessionAuditContext;
  specialistRuns?: SpecialistRunAudit[];
  tools?: {
    total: number;
    byTool?: Record<string, number>;
    errors?: number;
    entries?: Array<{
      id: string;
      tool: string;
      name: string;
      summary: string;
      ok: boolean;
      ts: string;
    }>;
    truncated?: boolean;
  };
  judge?: {
    inputCount: number;
    outputCount: number;
    dropped?: Array<{ title: string; reason: string }>;
    sastCount?: number;
    discourse?: { ran?: boolean; notes?: number };
  };
  zeroFindings?: {
    reason: string;
    message: string;
    evidence?: string[];
  };
  /** Incomplete specialist coverage (timeouts) — not a clean empty scan for those roles */
  coverageGaps?: {
    specialistTimeouts: number;
    roles: string[];
    unitLabels?: string[];
    message: string;
    criticalRolesAffected?: boolean;
  };
  heal?: {
    recoveredUnits?: number;
    failedUnits?: number;
    failureCount?: number;
  };
  /** Stage / unit wall clocks for bottleneck analysis */
  timings?: {
    sessionStartedAt: string;
    sessionEndedAt?: string;
    totalDurationMs?: number;
    stages?: Array<{
      stage: string;
      startedAt: string;
      endedAt?: string;
      durationMs?: number;
      message?: string;
    }>;
    units?: Array<{
      unitId: string;
      unitLabel?: string;
      startedAt?: string;
      endedAt?: string;
      durationMs?: number;
      status?: string;
      roles?: string[];
      specialistMaxMs?: number;
      specialistSumMs?: number;
      findingCount?: number;
    }>;
    summary?: {
      longestStage?: string;
      longestStageMs?: number;
      longestUnitId?: string;
      longestUnitMs?: number;
      longestSpecialistRole?: string;
      longestSpecialistMs?: number;
      byStageMs?: Record<string, number>;
      specialistsMs?: number;
      verificationMs?: number;
      specialistRunsCount?: number;
      specialistRunsSumMs?: number;
      specialistRunsMaxMs?: number;
      toolsSumMs?: number;
      unitCount?: number;
    };
  };
  completedAt?: string;
}

export interface Session {
  id: string;
  mode: string;
  status: string;
  stage: string;
  repoId: string;
  repoPath?: string;
  riskTier: string;
  depth?: string;
  verdict?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  prNumber?: number;
  baseBranch?: string;
  headBranch?: string;
  baseSha?: string;
  headSha?: string;
  scmProvider?: string;
  scmFullName?: string;
  tenantId?: string;
  orgId?: string;
  units?: ReviewUnit[];
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Estimated USD from list prices (not invoice). */
    costUsd?: number;
    costEstimated?: boolean;
    calls?: number;
    byModel?: Record<
      string,
      {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        costUsd: number;
        calls: number;
      }
    >;
  };
  error?: string;
  failureLog?: SessionFailureEntry[];
  /** Review-run forensics (provenance + specialist runs). */
  audit?: SessionAudit;
  metadata?: Record<string, unknown>;
}

export interface FindingEvidence {
  id: string;
  type: string;
  summary?: string;
  payload?: Record<string, unknown>;
  artifactUri?: string;
}

export interface Finding {
  id: string;
  sessionId: string;
  path: string;
  title: string;
  body: string;
  severity: string;
  category: string;
  status: string;
  startLine?: number;
  endLine?: number;
  repoId?: string;
  /** Product (evidence-derived) confidence — primary UI/audit score */
  confidence?: number;
  /** Specialist self-report (diagnostic) */
  modelConfidence?: number;
  /** Mean token probability from logprobs when provider supports it */
  tokenConfidence?: number;
  fingerprint?: string;
  agents?: string[];
  ruleIds?: string[];
  suggestion?: string;
  /** Concrete code fix when STEW_SUGGESTED_CODE_FIXES is enabled for the org */
  suggestedFix?: string;
  existingCode?: string;
  evidence?: FindingEvidence[];
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface RepoLink {
  id: string;
  fromRepoId: string;
  toRepoId: string;
  edgeType: string;
  enabled: boolean;
  pathFilters?: { from?: string[]; to?: string[] };
  maxDepth?: number;
  tokenBudget?: number;
  fromRepoPath?: string;
  toRepoPath?: string;
  hints?: Record<string, string>;
  orgId?: string;
}

export interface LicenseInfo {
  tier: string;
  multiOrg: boolean;
  sso: boolean;
  thoroughDiscourse: boolean;
  prove: boolean;
  crossRepo: boolean;
  langfuse: boolean;
  byok?: boolean;
  enterpriseConnectors?: boolean;
  maxSeats: number;
  features: string[];
  source: string;
  enforced?: boolean;
  signatureRequired?: boolean;
  signatureValid?: boolean;
  validUntil?: string;
  customer?: string;
  status?: string;
  /** Community open mode — all features, no commercial gate */
  openMode?: boolean;
  hideLicenseUi?: boolean;
}

export interface ModelProfile {
  provider: string;
  model: string;
  strongModel?: string;
  cheapModel?: string;
  hasOpenAI?: boolean;
  hasAnthropic?: boolean;
  hasXai?: boolean;
  hasOpenRouter?: boolean;
  litellmBaseUrl?: string;
  openaiBaseUrl?: string;
  openrouterBaseUrl?: string;
  /** Masked provider credentials for this org */
  providers?: Record<string, { apiKeySet: boolean; baseUrl?: string }>;
  roleMatrix?: Record<
    string,
    { provider?: string; model?: string; baseUrl?: string; apiKeyRef?: string; apiKeySet?: boolean }
  >;
  availableRoles?: string[];
  langfuseEnabled?: boolean;
  source?: string;
  note?: string;
}

export interface Connector {
  type: string;
  status: string;
  configured?: boolean;
  url?: string;
  note?: string;
  baseUrl?: string;
  username?: string;
  org?: string;
  project?: string;
  hasToken?: boolean;
  tokenMasked?: string;
  hasWebhookSecret?: boolean;
  enabled?: boolean;
  updatedAt?: string;
}

export interface ScmRepo {
  provider: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  url: string;
}

export interface ScmPr {
  number: number;
  title: string;
  body?: string;
  state: string;
  baseBranch: string;
  headBranch: string;
  baseSha?: string;
  headSha?: string;
  url?: string;
  author?: string;
}

export interface DiffFile {
  path: string;
  status: string;
  patch?: string;
  previousPath?: string;
  additions: number;
  deletions: number;
}

export interface GraphStatus {
  backend_connected?: boolean;
  graph_backend?: string;
  last_build?: string | null;
  nodes?: { total?: number } | null;
  edges?: { total?: number } | null;
  repo_id?: string;
}

export interface Job {
  id: string;
  sessionId?: string;
  status?: string;
  mode?: string;
  createdAt?: string;
  enqueuedAt?: string;
  repoId?: string;
}

export interface ProgressEvent {
  type: string;
  sessionId?: string;
  stage?: string;
  message?: string;
  unitId?: string;
  unitLabel?: string;
  label?: string;
  status?: string;
  role?: string;
  model?: string;
  runner?: string;
  durationMs?: number;
  error?: string;
  timedOut?: boolean;
  timeoutMs?: number;
  finding?: Finding;
  level?: string;
  ts?: string;
  findingCount?: number;
  retriable?: boolean;
  strategy?: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
}

/** Client-side SARIF 2.1.0 export for findings. */
export function findingsToSarif(findings: Finding[]) {
  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Codesteward Review",
            informationUri: "https://codesteward.ai",
            version: "0.1.0",
            rules: [],
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleIds?.[0] ?? f.category,
          level:
            f.severity === "critical" || f.severity === "high"
              ? "error"
              : f.severity === "medium"
                ? "warning"
                : "note",
          message: { text: `${f.title}${f.body ? `\n\n${f.body}` : ""}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path },
                region: f.startLine
                  ? { startLine: f.startLine, endLine: f.endLine ?? f.startLine }
                  : undefined,
              },
            },
          ],
          properties: {
            category: f.category,
            severity: f.severity,
            status: f.status,
            sessionId: f.sessionId,
            fingerprint: f.fingerprint,
            tags: f.tags,
          },
        })),
      },
    ],
  };
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function reactionOf(f: Finding): "up" | "down" | null {
  const tag = f.tags?.find((t) => t.startsWith("reaction:"));
  if (tag === "reaction:up") return "up";
  if (tag === "reaction:down") return "down";
  return null;
}

export function setSessionToken(token: string | null) {
  if (token) localStorage.setItem("cs-session-token", token);
  else localStorage.removeItem("cs-session-token");
}

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem("cs-session-token");
  } catch {
    return null;
  }
}

export function getOrgId(): string | null {
  try {
    return localStorage.getItem("cs-org-id");
  } catch {
    return null;
  }
}

/** Fired after setOrgId so sidebar / pages pick up the active org without a hard refresh. */
export const ORG_CHANGED_EVENT = "cs:org-changed";

export function setOrgId(orgId: string | null) {
  try {
    if (orgId) localStorage.setItem("cs-org-id", orgId);
    else localStorage.removeItem("cs-org-id");
  } catch {
    /* privacy mode */
  }
  try {
    window.dispatchEvent(
      new CustomEvent(ORG_CHANGED_EVENT, { detail: { orgId: orgId ?? null } }),
    );
  } catch {
    /* non-browser */
  }
}
