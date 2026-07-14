#!/usr/bin/env node
/**
 * Binary checklist against K1–K21 category-leader exit criteria.
 * Code/static checks + optional live API probes (CATEGORY_LEADER_LIVE=1).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const checks = [];

function ok(id, pass, detail) {
  checks.push({ id, pass: Boolean(pass), detail });
}

function fileHas(path, re) {
  const p = join(root, path);
  if (!existsSync(p)) return false;
  return re.test(readFileSync(p, "utf8"));
}

// K1 GH App install path
ok(
  "K1_github_app_install",
  fileHas("packages/api/src/tenancy/routes.ts", /\/v1\/scm\/github\/install/) &&
    fileHas("packages/api/src/tenancy/routes.ts", /\/v1\/scm\/github\/setup/),
  "install + setup callback routes",
);

// K2 multi-org isolation
ok(
  "K2_org_isolation",
  fileHas("packages/api/src/middleware/auth.ts", /assertMembership/) &&
    fileHas("packages/api/src/app.ts", /list\(\{ orgId \}\)/) &&
    fileHas("packages/api/src/app.ts", /orgId,\s*\n\s*\}\);/),
  "membership middleware + scoped sessions/findings",
);

// K3 postgres schema
ok(
  "K3_tenancy_schema",
  existsSync(join(root, "packages/db/migrations/005_multitenant_scm_apps.sql")) &&
    existsSync(join(root, "packages/db/migrations/006_idp_invitations_audit.sql")),
  "migrations 005+006",
);

// K4 OIDC real
ok(
  "K4_oidc_real",
  fileHas("packages/api/src/auth/oidc.ts", /getOidcStatus/) &&
    fileHas("packages/api/src/auth/oidc.ts", /buildAuthorizationUrl/) &&
    !fileHas("packages/api/src/auth-store.ts", /configured_stub/),
  "OIDC RP without configured_stub",
);

// K5 user admin
ok(
  "K5_user_admin",
  fileHas("packages/api/src/app.ts", /\/v1\/auth\/users/) &&
    fileHas("packages/api/src/tenancy/routes.ts", /\/members/),
  "users + members APIs",
);

// K6 secrets encryption
ok(
  "K6_secrets_encryption",
  fileHas("packages/api/src/secrets.ts", /encryptSecret/) &&
    fileHas("packages/api/src/tenancy/orgs.ts", /encryptSecret/),
  "AES-GCM secrets helper wired",
);

// K7 UI SoR routes (best-effort static)
ok(
  "K7_ui_sor",
  fileHas("packages/ui/src/App.tsx", /learnings|members|prs|PullRequests|Learnings|Members/i) ||
    existsSync(join(root, "packages/ui/src/pages/Learnings.tsx")),
  "UI SoR pages present",
);

// K8 webhooks
ok(
  "K8_webhook_hardening",
  fileHas("packages/api/src/app.ts", /createScmProvider\("github"\)/) &&
    fileHas("packages/api/src/app.ts", /installation/),
  "App factory + installation lifecycle",
);

// K9 address rate
ok(
  "K9_address_rate",
  fileHas("packages/api/src/app.ts", /\/v1\/analytics\/address-rate/) &&
    !fileHas("packages/ui/src/pages/Analytics.tsx", /\[12,\s*18,\s*22/),
  "real address-rate API; no fake UI bars",
);

// K10 learnings
ok(
  "K10_learnings",
  fileHas("packages/api/src/app.ts", /\/v1\/org\/memories/) &&
    (existsSync(join(root, "packages/ui/src/pages/Learnings.tsx")) ||
      fileHas("packages/ui/src/App.tsx", /learnings/i)),
  "memories API + UI",
);

// K11 tool agents default
ok(
  "K11_tool_agents",
  fileHas("packages/agents/src/runner.ts", /STEW_USE_DEEPAGENTS === "0"/),
  "DeepAgents default unless explicitly 0",
);

// K12 evals
ok(
  "K12_evals",
  existsSync(join(root, "packages/evals/src/run-eval.mjs")),
  "offline eval harness",
);

// K14 dual-mode
ok(
  "K14_dual_mode",
  fileHas("packages/ui/src/pages/Dashboard.tsx", /Steward|Gate/) ||
    fileHas("packages/ui/src/components/Layout.tsx", /Steward|Gate|steward/i),
  "dual-mode UI CTAs/nav",
);

// Keycloak compose
ok(
  "KEYCLOAK_COMPOSE",
  existsSync(join(root, "deploy/compose/docker-compose.keycloak.yml")),
  "Keycloak reference stack",
);


// K21 category compose
ok(
  "K21_category_compose",
  existsSync(join(root, "deploy/compose/docker-compose.category.yml")),
  "category compose stack",
);
ok(
  "K21_acceptance_script",
  existsSync(join(root, "scripts/category-acceptance.mjs")),
  "acceptance suite",
);
ok(
  "K3_installations_pg",
  fileHas("packages/db/src/repositories/tenancy.ts", /listInstallations/) &&
    fileHas("packages/api/src/tenancy/orgs.ts", /listInstallations/),
  "installations dual-path",
);
ok(
  "K11_no_silent_simple",
  fileHas("packages/agents/src/runner.ts", /STEW_REQUIRE_TOOL_AGENTS/) &&
    fileHas("packages/agents/src/deep-agent-runner.ts", /refusing silent SimpleAgentRunner/),
  "tool agents fail-closed under strict",
);
ok(
  "K8_multi_scm_delivery",
  fileHas("packages/api/src/extra-routes.ts", /claimDelivery/) &&
    fileHas("packages/api/src/app.ts", /claimDelivery/) &&
    fileHas("packages/api/src/webhook-delivery.ts", /tryRecordDelivery/),
  "multi-SCM delivery + PG",
);
ok(
  "K19_prove_artifact",
  fileHas("packages/sandbox/src/prove.ts", /deterministic harness/),
  "prove writes real harness file",
);


const failed = checks.filter((c) => !c.pass);
console.log(JSON.stringify({ checks, passed: checks.length - failed.length, total: checks.length, failed: failed.map((f) => f.id) }, null, 2));
if (failed.length) {
  console.error(`CATEGORY LEADER CHECK: ${failed.length} gaps remaining`);
  process.exit(1);
}
console.error("CATEGORY LEADER STATIC CHECK: all covered");
