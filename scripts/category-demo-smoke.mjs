#!/usr/bin/env node
/**
 * Smoke the API surfaces required by the category demo (no live GitHub required).
 * Usage: API_URL=http://localhost:8081 node scripts/category-demo-smoke.mjs
 */
const base = (process.env.API_URL ?? "http://localhost:8081").replace(/\/$/, "");
const key = process.env.STEW_API_KEY;

async function req(path, init = {}) {
  const headers = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const health = await req("/healthz");
check("healthz", health.status === 200, String(health.status));

const auth = await req("/v1/auth/status");
check("auth_status", auth.status === 200, auth.body?.mode);
check(
  "oidc_not_stub",
  auth.body?.oidc?.status !== "configured_stub",
  auth.body?.oidc?.status,
);

const ar = await req("/v1/analytics/address-rate");
check("address_rate", ar.status === 200 || ar.status === 401, String(ar.status));
if (ar.status === 200) {
  check("address_rate_no_fake", ar.body?.empty === true || Array.isArray(ar.body?.weekBuckets), "empty or buckets");
}

const gh = await req("/v1/org/connectors/github/status");
check("github_status", gh.status === 200 || gh.status === 401, String(gh.status));

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, failed }, null, 2));
process.exit(failed.length ? 1 : 0);
