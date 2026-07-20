/**
 * Resolve candidate GitHub webhook HMAC secrets (org-aware).
 *
 * Order:
 * 1. process.env.GITHUB_WEBHOOK_SECRET
 * 2. Platform GitHub App store
 * 3. Installation → product org → tenancy GitHub App config (org_scm_secrets / scm_apps)
 * 4. Explicit "local" org GitHub App config (self-host dogfood)
 * 5. Org connector type=github webhookSecret (PAT path / mirrored fields)
 *
 * GitHub Apps created via manifest store webhook_secret on the **org App config**,
 * not only as a generic connector — missing that path causes 401 when env is empty
 * in the shell but the API process (or vault) still has a different secret.
 */
import { decryptConfigSecrets } from "./connectors-file.js";
import { decryptSecret } from "./secrets.js";

function pushUnique(
  out: string[],
  value: unknown,
  label: string,
  labels: string[],
) {
  if (value == null) return;
  let s = String(value).trim();
  if (!s || s === "dev-insecure") return;
  // Encrypted-at-rest blobs from tenancy vault / scm_apps inline refs
  if (s.startsWith("inline:enc:")) s = s.slice("inline:enc:".length);
  try {
    const dec = decryptSecret(s);
    if (dec?.trim()) s = dec.trim();
  } catch {
    /* keep raw plaintext secrets */
  }
  if (!s || s === "dev-insecure") return;
  if (out.includes(s)) return;
  out.push(s);
  labels.push(label);
}

async function pushOrgGithubAppSecret(
  secrets: string[],
  labels: string[],
  orgId: string,
) {
  try {
    const { getTenancyStore } = await import("./tenancy/orgs.js");
    const cfg = await getTenancyStore().getGitHubAppConfig(orgId);
    if (cfg?.webhookSecret) {
      pushUnique(
        secrets,
        cfg.webhookSecret,
        `tenancy:github_app:${orgId}`,
        labels,
      );
    }
  } catch {
    /* optional */
  }
}

async function pushOrgConnectorSecret(
  secrets: string[],
  labels: string[],
  orgId: string,
) {
  try {
    const { globalConnectorsStore } = await import("./connectors-store.js");
    await globalConnectorsStore.ensureLoaded();
    const row = await globalConnectorsStore.getAsync("github", orgId);
    if (row?.config) {
      const plain = decryptConfigSecrets(row.config as Record<string, unknown>);
      pushUnique(
        secrets,
        plain.webhookSecret,
        `connector:github:${orgId}`,
        labels,
      );
    }
  } catch {
    /* optional */
  }
}

export async function resolveGithubWebhookSecrets(opts: {
  rawBody: string;
  headers: Record<string, string | undefined>;
}): Promise<string[]> {
  const secrets: string[] = [];
  const labels: string[] = [];

  pushUnique(
    secrets,
    process.env.GITHUB_WEBHOOK_SECRET,
    "env:GITHUB_WEBHOOK_SECRET",
    labels,
  );

  try {
    const { resolvePlatformGithubAppPolicy } = await import(
      "./platform-github-app-store.js"
    );
    const plat = await resolvePlatformGithubAppPolicy(process.env);
    pushUnique(secrets, plat.webhookSecret, "platform_github_app", labels);
  } catch {
    /* optional */
  }

  // Resolve product org(s) from installation + always include local
  const orgIds = new Set<string>([
    process.env.DEFAULT_ORG_ID?.trim() || "local",
    "local",
  ]);

  try {
    const payload = JSON.parse(opts.rawBody) as {
      installation?: { id?: number };
      repository?: { owner?: { login?: string } };
    };
    const instId = payload.installation?.id;
    if (instId) {
      const { getTenancyStore } = await import("./tenancy/orgs.js");
      const inst = await getTenancyStore().findInstallationByProviderId(
        "github",
        String(instId),
      );
      if (inst?.orgId) orgIds.add(inst.orgId);
    }
    // STEW_SCM_ORG_MAP: "github-owner:productOrg,..."
    const owner = payload.repository?.owner?.login;
    const map = process.env.STEW_SCM_ORG_MAP;
    if (map && owner) {
      for (const part of map.split(",")) {
        const [scmOwner, org] = part.split(":");
        if (scmOwner === owner && org?.trim()) orgIds.add(org.trim());
      }
    }
  } catch {
    /* payload not JSON yet / ignore */
  }

  for (const orgId of orgIds) {
    await pushOrgGithubAppSecret(secrets, labels, orgId);
    await pushOrgConnectorSecret(secrets, labels, orgId);
  }

  if (labels.length) {
    console.info(
      `[webhooks/github] signature candidates (${labels.length}): ${labels.join(", ")}`,
    );
  } else {
    console.info(
      "[webhooks/github] no webhook secrets found (env / platform / org App / connector)",
    );
  }
  return secrets;
}
