export class ApiClient {
  constructor(private readonly baseUrl: string = process.env.STEW_API_URL ?? "http://localhost:8081") {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string>),
    };
    if (process.env.STEW_API_KEY) {
      headers.Authorization = `Bearer ${process.env.STEW_API_KEY}`;
    }
    if (process.env.STEW_ORG_ID) {
      headers["X-Org-Id"] = process.env.STEW_ORG_ID;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`API ${res.status}: ${t.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  health() {
    return this.req<{ ok: boolean }>("/healthz");
  }

  listSessions() {
    return this.req<{ sessions: unknown[] }>("/v1/sessions");
  }

  startGate(body: Record<string, unknown>) {
    return this.req("/v1/reviews/gate", { method: "POST", body: JSON.stringify(body) });
  }

  startSteward(body: Record<string, unknown>) {
    return this.req("/v1/reviews/stewardship", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  findings(sessionId?: string) {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.req<{ findings: unknown[] }>(`/v1/findings${q}`);
  }

  findingsSarif(sessionId: string) {
    return this.req<unknown>(`/v1/sessions/${sessionId}/findings.sarif`);
  }

  resumeSession(sessionId: string, body: Record<string, unknown> = {}) {
    return this.req(`/v1/sessions/${sessionId}/resume`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  react(findingId: string, reaction: string, note?: string) {
    return this.req(`/v1/findings/${findingId}/react`, {
      method: "POST",
      body: JSON.stringify({ reaction, note }),
    });
  }

  memories(orgId = "local") {
    return this.req<{ memories: unknown[] }>(
      `/v1/org/memories?orgId=${encodeURIComponent(orgId)}`,
    );
  }
}
