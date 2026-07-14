#!/usr/bin/env node
/**
 * Validates category compose file structure and required env contracts (K21 packaging).
 * Does not require Docker daemon if `docker compose config` fails — still validates YAML presence.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const compose = join(root, "deploy/compose/docker-compose.category.yml");
const checks = [];
function ok(id, pass, detail = "") {
  checks.push({ id, pass: Boolean(pass), detail });
  console.log(`${pass ? "✓" : "✗"} ${id}${detail ? " — " + detail : ""}`);
}

ok("compose_exists", existsSync(compose));
const text = existsSync(compose) ? readFileSync(compose, "utf8") : "";
ok("has_postgres", text.includes("postgres:"));
ok("has_keycloak", text.includes("keycloak"));
ok("has_graph", text.includes("graph-mcp"));
ok("has_api", text.includes("SERVICE: api") || text.includes("api:"));
ok("has_worker", text.includes("worker:"));
ok("has_ui", text.includes("ui:"));
ok("graph_mock_off", /GRAPH_MOCK:\s*"0"/.test(text));
ok("tool_agents_required", text.includes("STEW_REQUIRE_TOOL_AGENTS"));
ok("auth_strict", text.includes("STEW_AUTH_STRICT"));
ok("oidc_issuer", text.includes("OIDC_ISSUER"));
ok("secrets_key", text.includes("STEW_SECRETS_KEY"));
ok("require_pg_tenancy", text.includes("STEW_REQUIRE_PG_TENANCY"));
ok("checklist", existsSync(join(root, "scripts/category-demo-checklist.md")));
ok("acceptance", existsSync(join(root, "scripts/category-acceptance.mjs")));

const cfg = spawnSync(
  "docker",
  ["compose", "-f", "deploy/compose/docker-compose.category.yml", "config", "--quiet"],
  { cwd: root, encoding: "utf8" },
);
ok(
  "docker_compose_config",
  cfg.status === 0 || cfg.error?.code === "ENOENT",
  cfg.status === 0
    ? "valid"
    : cfg.error?.code === "ENOENT"
      ? "docker not installed (file checks only)"
      : (cfg.stderr || cfg.stdout || "").slice(0, 200),
);
// If docker missing, still pass file contract; if docker present must config ok
if (!cfg.error && cfg.status !== 0) {
  checks[checks.length - 1].pass = false;
}

const failed = checks.filter((c) => !c.pass);
console.log(
  JSON.stringify(
    {
      passed: checks.length - failed.length,
      total: checks.length,
      failed: failed.map((f) => f.id),
      verdict: failed.length === 0 ? "COMPOSE_CONTRACT_PASS" : "COMPOSE_CONTRACT_FAIL",
    },
    null,
    2,
  ),
);
process.exit(failed.length ? 1 : 0);
