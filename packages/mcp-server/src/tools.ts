import { createGraphClient } from "@codesteward/graph-client";
import { loadPolicyFromDir, DEFAULT_POLICY } from "@codesteward/policy";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const apiBase = () => process.env.STEW_API_URL ?? "http://localhost:8081";

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiGet(path: string) {
  const res = await fetch(`${apiBase()}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function createReviewTools(): McpTool[] {
  return [
    {
      name: "stew_start_gate_review",
      description: "Start a PR/MR gate review session",
      inputSchema: {
        type: "object",
        properties: {
          repoId: { type: "string" },
          repoPath: { type: "string" },
          prNumber: { type: "number" },
          paths: { type: "array", items: { type: "string" } },
          riskTier: { type: "string" },
        },
        required: ["repoId"],
      },
      handler: async (args) =>
        apiPost("/v1/reviews/gate", {
          mode: "gate",
          repoId: args.repoId,
          repoPath: args.repoPath,
          prNumber: args.prNumber,
          paths: args.paths,
          riskTier: args.riskTier ?? "full",
        }),
    },
    {
      name: "stew_start_stewardship",
      description: "Start a branch/codebase stewardship scan",
      inputSchema: {
        type: "object",
        properties: {
          repoId: { type: "string" },
          repoPath: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          riskTier: { type: "string" },
        },
        required: ["repoId"],
      },
      handler: async (args) =>
        apiPost("/v1/reviews/stewardship", {
          mode: "stewardship",
          repoId: args.repoId,
          repoPath: args.repoPath,
          paths: args.paths,
          riskTier: args.riskTier ?? "full",
        }),
    },
    {
      name: "stew_list_findings",
      description: "List findings, optionally filtered by session",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
      },
      handler: async (args) => {
        const q = args.sessionId
          ? `?sessionId=${encodeURIComponent(String(args.sessionId))}`
          : "";
        return apiGet(`/v1/findings${q}`);
      },
    },
    {
      name: "stew_list_sessions",
      description: "List review sessions",
      inputSchema: { type: "object", properties: {} },
      handler: async () => apiGet("/v1/sessions"),
    },
    {
      name: "stew_graph_status",
      description: "Proxy graph_status for a repo",
      inputSchema: {
        type: "object",
        properties: {
          repoId: { type: "string" },
          tenantId: { type: "string" },
        },
      },
      handler: async (args) => {
        const g = createGraphClient({
          repoId: args.repoId as string | undefined,
          tenantId: args.tenantId as string | undefined,
        });
        return g.status({
          repoId: args.repoId as string | undefined,
          tenantId: args.tenantId as string | undefined,
        });
      },
    },
    {
      name: "stew_effective_policy",
      description: "Load effective STEWARD.md policy from a repo path",
      inputSchema: {
        type: "object",
        properties: { repoPath: { type: "string" } },
        required: ["repoPath"],
      },
      handler: async (args) => {
        try {
          return await loadPolicyFromDir(String(args.repoPath));
        } catch {
          return DEFAULT_POLICY;
        }
      },
    },
  ];
}
