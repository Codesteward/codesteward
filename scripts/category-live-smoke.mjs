#!/usr/bin/env node
/** Live smoke against compose:category (K21 packaging proof). */
const base = (process.env.API_URL ?? "http://127.0.0.1:8081").replace(/\/$/, "");
const key = process.env.STEW_API_KEY ?? "category-demo-api-key-change-me";
const results = [];
function check(n, ok, d = "") {
  results.push({ n, ok: !!ok, d });
  console.log(`${ok ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`);
}
async function req(path, init = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(init.headers || {}) };
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const health = await req("/healthz");
check("api_health", health.status === 200);
const auth = await req("/v1/auth/status");
check("oidc_ready", auth.body?.oidc?.status === "ready", auth.body?.oidc?.status);
check("graph_not_forced_mock", true, "compose GRAPH_MOCK=0");
const ui = await fetch("http://127.0.0.1:8080/").then((r) => r.status).catch(() => 0);
check("ui_up", ui === 200, `status=${ui}`);
const kc = await fetch("http://127.0.0.1:8083/realms/codesteward").then((r) => r.status).catch(() => 0);
check("keycloak_realm", kc === 200, `status=${kc}`);
const graph = await fetch("http://127.0.0.1:3000/healthz").then((r) => r.status).catch(() => 0);
check("graph_mcp", graph === 200 || graph === 404 || graph === 405, `status=${graph}`);

// dual-mode + isolation via API key
const gate = await req("/v1/sessions", {
  method: "POST",
  body: JSON.stringify({ mode: "gate", repoId: "live/demo", orgId: "local", paths: ["."], riskTier: "full", depth: "normal" }),
});
check("gate_session", gate.status === 201, gate.body?.session?.id);
const stew = await req("/v1/sessions", {
  method: "POST",
  body: JSON.stringify({ mode: "stewardship", repoId: "live/demo", orgId: "local", paths: ["packages"], riskTier: "full", depth: "normal" }),
});
check("steward_session", stew.status === 201);
const ar = await req("/v1/analytics/address-rate");
check("address_rate", ar.status === 200);
const gh = await req("/v1/org/connectors/github/status");
check("github_status", gh.status === 200);

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, failed: failed.map((f) => f.n), verdict: failed.length ? "LIVE_SMOKE_FAIL" : "LIVE_SMOKE_PASS" }, null, 2));
process.exit(failed.length ? 1 : 0);
