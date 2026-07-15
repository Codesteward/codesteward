import type { Hono } from "hono";
import { getTenancyStore, type OrgRole } from "./orgs.js";
import { isGitHubAppConfigured, createScmProvider } from "@codesteward/scm";
import { globalAuthStore } from "../auth-store.js";
import { orgErrorResponse } from "../org-context.js";

export function registerTenancyRoutes(app: Hono) {
  const store = getTenancyStore();

  /**
   * Complete GitHub App Manifest flow: exchange one-time code for App credentials.
   * Happy path — no PEM paste. Saves encrypted credentials + returns install URL.
   * @see https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
   */
  app.get("/v1/scm/github/manifest/callback", async (c) => {
    const code = c.req.query("code");
    const orgId = c.req.query("state") ?? c.req.query("orgId") ?? "local";
    if (!code) return c.json({ error: "code required from GitHub manifest redirect" }, 400);
    try {
      const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "codesteward-review",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!res.ok) {
        const text = await res.text();
        return c.json({ error: "manifest_conversion_failed", detail: text.slice(0, 500) }, 400);
      }
      const data = (await res.json()) as {
        id?: number;
        slug?: string;
        pem?: string;
        client_id?: string;
        client_secret?: string;
        webhook_secret?: string;
        html_url?: string;
      };
      if (!data.id || !data.pem) {
        return c.json({ error: "manifest response missing id or pem" }, 400);
      }
      await store.saveGitHubAppConfig(
        {
          appId: String(data.id),
          clientId: data.client_id,
          privateKeyPem: data.pem,
          webhookSecret: data.webhook_secret,
          slug: data.slug,
          orgId: String(orgId),
        },
        { applyToProcessEnv: process.env.STEW_APPLY_SCM_ENV === "1" || orgId === "local" },
      );
      const install = await store.listInstallations(String(orgId));
      const ui = (process.env.STEW_PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, "");
      if ((c.req.header("accept") ?? "").includes("text/html")) {
        return c.redirect(`${ui}/connectors?manifest=1&appId=${data.id}&slug=${data.slug ?? ""}`);
      }
      return c.json({
        ok: true,
        appId: String(data.id),
        slug: data.slug,
        htmlUrl: data.html_url,
        installPath: `/v1/scm/github/install?orgId=${encodeURIComponent(String(orgId))}`,
        installations: install.length,
        note: "App credentials stored encrypted. Next: Install App on org.",
      });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });


  /** GitHub App Manifest — pre-filled create form (happy path; no PEM paste). */
  app.get("/v1/scm/github/manifest", async (c) => {
    const orgId = String(c.req.query("orgId") ?? c.get("orgId") ?? "local");
    const githubOrg = c.req.query("githubOrg") ?? undefined;
    const { buildGitHubAppManifest } = await import("../github-app-manifest.js");
    const built = buildGitHubAppManifest({
      orgId,
      githubOrg: githubOrg || undefined,
    });
    return c.json({
      orgId,
      manifest: built.manifest,
      createUrl: built.createUrl,
      warnings: built.warnings,
      webhookPublic: built.webhookPublic,
      webhookUrl: built.webhookUrl,
      /** Pass as form `state` so conversion callback can attribute org */
      state: orgId,
      note: built.webhookPublic
        ? "POST this manifest to GitHub (Create App). Credentials return via redirect — no PEM paste."
        : "Manifest omits webhook URL because it is not public (localhost). Create App works; set STEW_WEBHOOK_PUBLIC_URL to a tunnel and configure the webhook after create, or re-run Create with the tunnel set.",
      docs: "https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest",
    });
  });


  /** Orgs the current user can access */
  app.get("/v1/orgs", async (c) => {
    await store.ensureDefaults();
    const user = c.get("user") as { id?: string } | undefined;
    const authMode = c.get("authMode") as string | undefined;
    if (authMode === "dev_open" || authMode === "api_key" || !user?.id) {
      return c.json({ orgs: await store.listOrgs() });
    }
    const orgs = await store.listOrgsForUser(user.id);
    return c.json({ orgs });
  });

  app.post("/v1/orgs", async (c) => {
    try {
      const body = (await c.req.json()) as {
        name?: string;
        slug?: string;
        /** SaaS: free | pro | enterprise (default free) */
        planId?: string;
        seats?: number;
        billingEmail?: string;
      };
      if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
      const user = c.get("user") as { id?: string; email?: string } | undefined;
      // Free plan: multi_org false — block creating a second org without Pro+
      if (user?.id && user.id !== "api_key") {
        const existing = await store.listOrgsForUser(user.id);
        if (existing.length > 0) {
          const { isOrgEntitled } = await import("../license.js");
          let allowed = false;
          for (const o of existing) {
            if (await isOrgEntitled(o.id, "multiOrg")) {
              allowed = true;
              break;
            }
          }
          if (!allowed) {
            return c.json(
              {
                error:
                  "Multiple organizations require a Pro or Enterprise plan. Upgrade under Billing, or use your existing org.",
                code: "ORG_LICENSE_REQUIRED",
                feature: "multi_org",
              },
              402,
            );
          }
        }
      }
      const org = await store.createOrg({
        name: body.name.trim(),
        slug: body.slug,
        ownerUserId: user?.id,
      });
      // Home org for the creator (shadow user)
      if (user?.id) {
        try {
          await globalAuthStore.updateUser(user.id, { orgId: org.id });
        } catch {
          /* non-fatal */
        }
      }
      // SaaS control plane: seed chosen plan (default free)
      let planId = "free";
      {
        const { isBillingConfigured, putOrgSubscription } = await import(
          "../billing-portal.js"
        );
        if (isBillingConfigured()) {
          const requested = (body.planId ?? "free").toLowerCase().trim();
          planId =
            requested === "pro" || requested === "enterprise" || requested === "free"
              ? requested
              : "free";
          const seats =
            typeof body.seats === "number" && body.seats > 0
              ? body.seats
              : planId === "enterprise"
                ? 50
                : planId === "pro"
                  ? 10
                  : 5;
          const ok = await putOrgSubscription(org.id, {
            planId,
            seats,
            customerName: org.name,
            billingEmail: body.billingEmail?.trim() || user?.email,
            status: planId === "free" ? "active" : "trialing",
          });
          if (!ok) {
            console.warn("[orgs] billing plan seed failed for", org.id, planId);
            planId = "free";
          }
        }
      }
      // Keycloak SoT: mirror product org as /orgs/{slug} group (required in keycloak mode)
      {
        const { isKeycloakIdentityMode } = await import("../identity/mode.js");
        const { isKeycloakAdminConfigured, ensureOrgGroup, addUserToOrgGroup, findUserByEmail } =
          await import("../identity/keycloak-admin.js");
        if (isKeycloakIdentityMode()) {
          if (!isKeycloakAdminConfigured()) {
            return c.json(
              {
                error:
                  "Identity directory not configured — cannot create org group in Keycloak",
              },
              503,
            );
          }
          await ensureOrgGroup(org.slug || org.id, org.name);
          if (user?.id) {
            const u = await globalAuthStore.getUserById(user.id);
            if (u?.email) {
              const kc = await findUserByEmail(u.email);
              if (kc?.id) await addUserToOrgGroup(kc.id, org.slug || org.id);
            }
          }
        }
      }
      try {
        const { auditLog } = await import("../audit.js");
        await auditLog({
          action: "org.create",
          orgId: org.id,
          actorUserId: user?.id,
          resourceType: "org",
          resourceId: org.id,
          metadata: { name: org.name, slug: org.slug },
        });
      } catch {
        /* ignore */
      }
      return c.json(
        {
          org,
          plan: process.env.STEW_BILLING_URL ? planId : undefined,
          note: process.env.STEW_BILLING_URL
            ? planId === "free"
              ? "Organization created on Free. Manage plans under Billing."
              : `Organization created on ${planId} (trialing until checkout is wired). Manage under Billing.`
            : undefined,
        },
        201,
      );
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  /** Rename org (admin/owner of that org). */
  app.patch("/v1/orgs/:orgId", async (c) => {
    try {
      const orgId = c.req.param("orgId");
      const user = c.get("user") as { id?: string; role?: string } | undefined;
      const authMode = c.get("authMode") as string | undefined;
      const membership = await store.assertMembership(user?.id, orgId, { authMode });
      const role = membership?.role ?? user?.role;
      if (
        authMode !== "api_key" &&
        authMode !== "dev_open" &&
        role !== "admin" &&
        role !== "owner"
      ) {
        return c.json({ error: "forbidden", message: "admin or owner role required" }, 403);
      }
      const body = (await c.req.json()) as { name?: string; slug?: string };
      if (!body.name?.trim() && !body.slug?.trim()) {
        return c.json({ error: "name or slug required" }, 400);
      }
      const org = await store.updateOrg(orgId, {
        name: body.name,
        slug: body.slug,
      });
      try {
        const { auditLog } = await import("../audit.js");
        await auditLog({
          action: "org.update",
          orgId: org.id,
          actorUserId: user?.id,
          resourceType: "org",
          resourceId: org.id,
          metadata: { name: org.name, slug: org.slug },
        });
      } catch {
        /* ignore */
      }
      return c.json({ org });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.get("/v1/orgs/:orgId/members", async (c) => {
    try {
      const orgId = c.req.param("orgId");
      const user = c.get("user") as { id?: string } | undefined;
      // Membership gate — path orgId must match a real membership (not free-form spoof)
      await store.assertMembership(user?.id, orgId, { authMode: c.get("authMode") as string });
      const members = await store.listMembers(orgId);
      // Resolve profile fields per member only — never return other tenants' directories
      const profiles = await Promise.all(
        members.map(async (m) => {
          const u = await globalAuthStore.getUserById(m.userId);
          return {
            ...m,
            email: u?.email,
            displayName: u?.displayName,
          };
        }),
      );
      return c.json({ orgId, members: profiles });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.put("/v1/orgs/:orgId/members/:userId", async (c) => {
    try {
      const orgId = c.req.param("orgId");
      const userId = c.req.param("userId");
      const actor = c.get("user") as { id?: string } | undefined;
      await store.assertMembership(actor?.id, orgId, {
        authMode: c.get("authMode") as string,
        minRole: "admin",
      });
      // New member (not already in org) counts against seat limit
      const existingMember = await store.getMembership(orgId, userId);
      if (!existingMember) {
        try {
          const { requireOrgSeatAvailable } = await import("../license.js");
          await requireOrgSeatAvailable(orgId, 1);
        } catch (err) {
          const e = err as Error & { status?: number; code?: string };
          if (e.status === 402) {
            return c.json(
              { error: e.message, code: e.code ?? "SEAT_LIMIT" },
              402,
            );
          }
          throw err;
        }
      }
      const body = (await c.req.json()) as { role?: OrgRole };
      if (!body.role) return c.json({ error: "role required" }, 400);
      // Keycloak SoT: mirror role to realm roles first (login/RBAC SoT)
      {
        const { isKeycloakIdentityMode } = await import("../identity/mode.js");
        const { isKeycloakAdminConfigured, setUserProductRole, findUserByEmail } =
          await import("../identity/keycloak-admin.js");
        if (isKeycloakIdentityMode()) {
          if (!isKeycloakAdminConfigured()) {
            return c.json(
              { error: "Identity directory not configured — cannot change roles in Keycloak" },
              503,
            );
          }
          const u = await globalAuthStore.getUserById(userId);
          if (!u?.email) {
            return c.json({ error: "member has no email for identity lookup" }, 400);
          }
          const kc = await findUserByEmail(u.email);
          if (!kc?.id) {
            return c.json(
              {
                error:
                  "No matching identity user for this member. Provision them via Invite/Add member first.",
              },
              404,
            );
          }
          await setUserProductRole(kc.id, body.role);
        }
      }
      const member = await store.upsertMember({ orgId, userId, role: body.role });
      return c.json({ member });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.delete("/v1/orgs/:orgId/members/:userId", async (c) => {
    try {
      const orgId = c.req.param("orgId");
      const userId = c.req.param("userId");
      const actor = c.get("user") as { id?: string } | undefined;
      await store.assertMembership(actor?.id, orgId, {
        authMode: c.get("authMode") as string,
        minRole: "admin",
      });
      // Keycloak SoT: remove from org group first
      {
        const { isKeycloakIdentityMode } = await import("../identity/mode.js");
        const {
          isKeycloakAdminConfigured,
          removeUserFromOrgGroup,
          findUserByEmail,
        } = await import("../identity/keycloak-admin.js");
        if (isKeycloakIdentityMode()) {
          if (!isKeycloakAdminConfigured()) {
            return c.json(
              {
                error: "Identity directory not configured — cannot remove member in Keycloak",
              },
              503,
            );
          }
          const org = await store.getOrg(orgId);
          const u = await globalAuthStore.getUserById(userId);
          if (u?.email && org) {
            const kc = await findUserByEmail(u.email);
            if (kc?.id) await removeUserFromOrgGroup(kc.id, org.slug || org.id);
          }
        }
      }
      const ok = await store.removeMember(orgId, userId);
      return c.json({ deleted: ok });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.post("/v1/orgs/:orgId/invitations", async (c) => {
    try {
      const orgId = c.req.param("orgId");
      const actor = c.get("user") as { id?: string } | undefined;
      await store.assertMembership(actor?.id, orgId, {
        authMode: c.get("authMode") as string,
        minRole: "admin",
      });
      try {
        const { requireOrgSeatAvailable } = await import("../license.js");
        await requireOrgSeatAvailable(orgId, 1);
      } catch (err) {
        const e = err as Error & { status?: number; code?: string };
        if (e.status === 402) {
          return c.json(
            { error: e.message, code: e.code ?? "SEAT_LIMIT" },
            402,
          );
        }
        throw err;
      }
      const body = (await c.req.json()) as {
        email?: string;
        role?: OrgRole;
        password?: string;
        displayName?: string;
      };
      if (!body.email) return c.json({ error: "email required" }, 400);

      // Keycloak mode: provision user in KC (SoT) + local shadow membership
      const { isKeycloakIdentityMode } = await import("../identity/mode.js");
      const { isKeycloakAdminConfigured, provisionMember } = await import(
        "../identity/keycloak-admin.js"
      );
      if (isKeycloakIdentityMode() && isKeycloakAdminConfigured()) {
        const org = await store.getOrg(orgId);
        const slug = org?.slug || orgId;
        const tempPassword =
          body.password ??
          `ChangeMe-${Math.random().toString(36).slice(2, 10)}!`;
        const prov = await provisionMember({
          email: body.email,
          password: tempPassword,
          displayName: body.displayName,
          orgSlug: slug,
          role: body.role ?? "reviewer",
          temporaryPassword: !body.password,
        });
        // Shadow local user for FKs
        let localUser = await globalAuthStore.getUserByEmail(prov.email);
        if (!localUser) {
          const created = await globalAuthStore.createUser({
            email: prov.email,
            password: tempPassword,
            displayName: body.displayName,
            role:
              (body.role === "admin" || body.role === "owner"
                ? "admin"
                : body.role === "viewer"
                  ? "viewer"
                  : "reviewer") as "admin" | "reviewer" | "viewer",
            orgId,
          });
          localUser = created as never;
        }
        const shadow = localUser as { id: string };
        await store.upsertMember({
          orgId,
          userId: shadow.id,
          role: body.role ?? "reviewer",
        });
        return c.json(
          {
            invitation: {
              id: `kc_${prov.kcUserId}`,
              orgId,
              email: prov.email,
              role: body.role ?? "reviewer",
              expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
              token: tempPassword,
              acceptPath: "/login",
              keycloak: true,
              note:
                "User provisioned in the platform identity directory. Temporary password returned once if set — prefer Sign in on the login page.",
            },
            provisioned: true,
          },
          201,
        );
      }

      const inv = await store.createInvitation({
        orgId,
        email: body.email,
        role: body.role ?? "reviewer",
        invitedBy: actor?.id ?? "admin",
      });
      return c.json(
        {
          invitation: {
            id: inv.id,
            orgId: inv.orgId,
            email: inv.email,
            role: inv.role,
            expiresAt: inv.expiresAt,
            // token returned once for admin to share (self-host)
            token: inv.token,
            acceptPath: `/v1/orgs/invitations/accept`,
          },
        },
        201,
      );
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.get("/v1/orgs/:orgId/invitations", async (c) => {
    try {
      const orgId = c.req.param("orgId");
      const actor = c.get("user") as { id?: string } | undefined;
      await store.assertMembership(actor?.id, orgId, {
        authMode: c.get("authMode") as string,
        minRole: "admin",
      });
      const list = await store.listInvitations(orgId);
      return c.json({
        invitations: list.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          expiresAt: i.expiresAt,
          createdAt: i.createdAt,
        })),
      });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.post("/v1/orgs/invitations/accept", async (c) => {
    try {
      const body = (await c.req.json()) as { token?: string };
      if (!body.token) return c.json({ error: "token required" }, 400);
      const user = c.get("user") as { id?: string; email?: string } | undefined;
      if (!user?.id || !user.email) {
        return c.json({ error: "login required to accept invitation" }, 401);
      }
      const member = await store.acceptInvitation(body.token, user.id, user.email);
      return c.json({ member });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.get("/v1/orgs/:orgId/scm/installations", async (c) => {
    try {
      const orgId = c.req.param("orgId");
      const user = c.get("user") as { id?: string } | undefined;
      await store.assertMembership(user?.id, orgId, { authMode: c.get("authMode") as string });
      const list = await store.listInstallations(orgId);
      return c.json({ installations: list });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.put("/v1/orgs/:orgId/scm/installations", async (c) => {
    try {
      const orgId = c.req.param("orgId");
      const user = c.get("user") as { id?: string } | undefined;
      await store.assertMembership(user?.id, orgId, {
        authMode: c.get("authMode") as string,
        minRole: "admin",
      });
      const body = (await c.req.json()) as {
        provider?: string;
        installationId?: string;
        accountLogin?: string;
        accountType?: string;
        baseUrl?: string;
        authMode?: ScmInstallationAuth;
      };
      if (!body.installationId || !body.accountLogin) {
        return c.json({ error: "installationId and accountLogin required" }, 400);
      }
      const row = await store.upsertInstallation({
        tenantId: "local",
        orgId,
        provider: body.provider ?? "github",
        installationId: String(body.installationId),
        accountLogin: body.accountLogin,
        accountType: body.accountType ?? "Organization",
        baseUrl: body.baseUrl,
        status: "active",
        authMode: body.authMode ?? "github_app",
      });
      return c.json({ installation: row }, 201);
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  /**
   * GitHub App install URL — happy path (not PEM paste).
   * Requires GITHUB_APP_SLUG or app slug in config + client id for state.
   */
  app.get("/v1/scm/github/install", async (c) => {
    const orgId = c.req.query("orgId") ?? c.get("orgId") ?? "local";
    const cfg = await store.getGitHubAppConfig(orgId);
    const platform = await import("../platform-github-app-store.js").then((m) =>
      m.resolvePlatformGithubAppPolicy(),
    );
    const appId = platform.appId ?? cfg?.appId ?? process.env.GITHUB_APP_ID;
    const slug = platform.slug ?? cfg?.slug ?? process.env.GITHUB_APP_SLUG;
    const { signState } = await import("../signed-state.js");
    const user = c.get("user") as { id?: string } | undefined;
    const state = signState({ orgId, userId: user?.id ?? null, n: Math.random().toString(36).slice(2) });
    // Persist state briefly for callback validation
    await store.upsertInstallation({
      tenantId: "local",
      orgId,
      provider: "github",
      installationId: `pending:${state}`,
      accountLogin: "_pending",
      accountType: "Organization",
      status: "active",
      authMode: "github_app",
    }).catch(() => undefined);

    const base = process.env.GITHUB_APP_INSTALL_URL;
    let url: string;
    if (base) {
      url = base.includes("?") ? `${base}&state=${state}` : `${base}?state=${state}`;
    } else if (slug) {
      url = `https://github.com/apps/${slug}/installations/new?state=${state}`;
    } else if (appId && slug) {
      url = `https://github.com/apps/${slug}/installations/new?state=${state}`;
    } else if (appId) {
      // App credentials present (env or store); slug optional — use setup URL pattern
      url = `https://github.com/settings/apps/${appId}/installations?state=${state}`;
    } else if (process.env.GITHUB_APP_ID && (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_REF)) {
      // Env-only enterprise path: no PEM paste in UI
      const envSlug = process.env.GITHUB_APP_SLUG ?? "APP";
      url = process.env.GITHUB_APP_INSTALL_URL
        ?? `https://github.com/apps/${envSlug}/installations/new?state=${state}`;
    } else {
      return c.json(
        {
          error: "github_app_not_configured",
          message:
            "Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_REF (or PEM once as admin) and GITHUB_APP_SLUG, then Install. PAT is break-glass only.",
          envFirst: true,
          requiredEnv: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_REF|GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG"],
          docs: "https://docs.github.com/en/apps/creating-github-apps",
        },
        400,
      );
    }
    return c.json({
      url,
      state,
      orgId,
      note: "Redirect user to url. On return, GitHub calls setup URL with installation_id + state.",
    });
  });

  /**
   * GitHub App setup callback — installation_id + setup_action + state.
   * Register this as the App's Setup URL: {API}/v1/scm/github/setup
   */
  app.get("/v1/scm/github/setup", async (c) => {
    const installationId = c.req.query("installation_id");
    const setupAction = c.req.query("setup_action");
    const state = c.req.query("state");
    let orgId = "local";
    if (state) {
      try {
        const { verifyState } = await import("../signed-state.js");
        const parsed = verifyState<{ orgId?: string }>(state);
        if (parsed.orgId) orgId = parsed.orgId;
      } catch (err) {
        return c.json(
          { error: "invalid_state", message: err instanceof Error ? err.message : String(err) },
          400,
        );
      }
    }
    if (!installationId) {
      return c.json({ error: "installation_id required" }, 400);
    }

    // Resolve account login via GitHub API when App creds present
    let accountLogin = `installation-${installationId}`;
    let accountType = "Organization";
    try {
      const cfg = await store.getGitHubAppConfig(orgId);
      const creds = store.resolveGitHubAppCredentials(cfg);
      if (creds) {
        // apply briefly for token mint
        process.env.GITHUB_APP_ID = creds.appId;
        process.env.GITHUB_APP_PRIVATE_KEY = creds.privateKey;
        process.env.GITHUB_APP_INSTALLATION_ID = installationId;
        const { createGitHubAppJwt } = await import("@codesteward/scm");
        const jwt = createGitHubAppJwt({
          appId: creds.appId,
          privateKeyPem: creds.privateKey,
        });
        const apiRoot =
          !creds.baseUrl || creds.baseUrl.includes("github.com")
            ? "https://api.github.com"
            : `${creds.baseUrl.replace(/\/$/, "")}/api/v3`;
        const instRes = await fetch(`${apiRoot}/app/installations/${installationId}`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "codesteward",
          },
        });
        if (instRes.ok) {
          const inst = (await instRes.json()) as {
            account?: { login?: string; type?: string };
          };
          if (inst.account?.login) accountLogin = inst.account.login;
          if (inst.account?.type) accountType = inst.account.type;
        }
      }
    } catch {
      /* best-effort */
    }

    // Remove pending placeholder
    if (state) {
      await store.deleteInstallation("github", `pending:${state}`).catch(() => undefined);
    }

    const row = await store.upsertInstallation({
      tenantId: "local",
      orgId,
      provider: "github",
      installationId: String(installationId),
      accountLogin,
      accountType,
      status: "active",
      authMode: "github_app",
    });

    const uiBase = (process.env.STEW_PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, "");
    // Browser-friendly redirect back to UI connectors
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      return c.redirect(
        `${uiBase}/connectors?installed=1&installation_id=${installationId}&orgId=${orgId}`,
      );
    }
    return c.json({
      ok: true,
      setupAction: setupAction ?? "install",
      installation: row,
      next: `${uiBase}/connectors`,
    });
  });

  /** Configure GitHub App credentials (enterprise path — not PAT). Secrets encrypted. */
  app.put("/v1/org/connectors/github/app", async (c) => {
    try {
      const body = (await c.req.json()) as {
        appId?: string;
        clientId?: string;
        privateKeyPem?: string;
        privateKeyRef?: string;
        webhookSecret?: string;
        baseUrl?: string;
        installationId?: string;
        accountLogin?: string;
        orgId?: string;
        slug?: string;
      };
      const orgId = body.orgId ?? c.get("orgId") ?? "local";
      const user = c.get("user") as { id?: string } | undefined;
      await store.assertMembership(user?.id, orgId, {
        authMode: c.get("authMode") as string,
        minRole: "admin",
      });
      // Platform-enforced App: orgs may only register installation IDs, not upload PEMs
      try {
        const { assertOrgMayConfigureGithubApp, resolvePlatformGithubAppPolicy } =
          await import("../platform-github-app-store.js");
        const platform = await resolvePlatformGithubAppPolicy();
        if (platform.enforce && platform.configured) {
          if (body.privateKeyPem || body.privateKeyRef || body.appId) {
            // Allow installation-only upserts without PEM when platform App is set
            if (!body.installationId) {
              await assertOrgMayConfigureGithubApp();
            }
            // installation-only path below uses platform credentials
            if (body.installationId && !body.privateKeyPem && !body.privateKeyRef) {
              await store.upsertInstallation({
                tenantId: "local",
                orgId: String(orgId),
                provider: "github",
                installationId: String(body.installationId),
                accountLogin: body.accountLogin || "unknown",
                accountType: "Organization",
                baseUrl: body.baseUrl || platform.baseUrl,
                status: "active",
                authMode: "github_app",
              });
              return c.json({
                ok: true,
                authMode: "github_app",
                configured: true,
                installationReady: true,
                platformEnforced: true,
                note: "Installation linked to the platform GitHub App.",
                installUrl: `/v1/scm/github/install?orgId=${encodeURIComponent(String(orgId))}`,
              });
            }
            await assertOrgMayConfigureGithubApp();
          }
        }
      } catch (err) {
        const e = err as Error & { status?: number; code?: string };
        if (e.status === 403) {
          return c.json({ error: e.message, code: e.code }, 403);
        }
        throw err;
      }
      if (!body.appId) return c.json({ error: "appId required" }, 400);
      if (!body.privateKeyPem && !body.privateKeyRef) {
        return c.json({ error: "privateKeyPem or privateKeyRef required" }, 400);
      }
      await store.saveGitHubAppConfig(
        {
          appId: body.appId,
          clientId: body.clientId,
          privateKeyPem: body.privateKeyPem,
          privateKeyRef: body.privateKeyRef,
          webhookSecret: body.webhookSecret,
          baseUrl: body.baseUrl,
          slug: body.slug,
          orgId,
        },
        {
          // Single-tenant self-host convenience only
          applyToProcessEnv: process.env.STEW_APPLY_SCM_ENV === "1" || orgId === "local",
        },
      );
      if (body.installationId) {
        await store.upsertInstallation({
          tenantId: "local",
          orgId,
          provider: "github",
          installationId: String(body.installationId),
          accountLogin: body.accountLogin || "unknown",
          accountType: "Organization",
          baseUrl: body.baseUrl,
          status: "active",
          authMode: "github_app",
        });
        if (process.env.STEW_APPLY_SCM_ENV === "1" || orgId === "local") {
          process.env.GITHUB_APP_INSTALLATION_ID = String(body.installationId);
        }
      }
      // Mirror into connectors store so Connectors UI shows "configured" (not missing_token)
      try {
        const { globalConnectorsStore } = await import("../connectors-store.js");
        await globalConnectorsStore.upsert(
          "github",
          {
            enabled: true,
            config: {
              authMode: "github_app",
              appId: body.appId,
              installationId: body.installationId,
              accountLogin: body.accountLogin,
              baseUrl: body.baseUrl || "https://api.github.com",
              // Store PEM so connector path can mint tokens if tenancy is cold
              ...(body.privateKeyPem
                ? { privateKeyPem: body.privateKeyPem }
                : {}),
              ...(body.webhookSecret ? { webhookSecret: body.webhookSecret } : {}),
              note: body.installationId
                ? "GitHub App + installation"
                : "GitHub App credentials (install on an org next)",
            },
          },
          orgId,
        );
      } catch (err) {
        console.warn("[github/app] mirror to connectors failed", err);
      }
      const hasInstall = Boolean(
        body.installationId ||
          (await store.listInstallations(orgId)).some((i) => i.provider === "github"),
      );
      return c.json({
        ok: true,
        authMode: "github_app",
        configured: true,
        installationReady: hasInstall,
        public: await store.getGitHubAppConfigPublic(orgId),
        note: hasInstall
          ? "GitHub App saved with installation — repos should list on PRs / Sessions."
          : "GitHub App credentials saved. Install the app on an org (step 2) or set Installation ID, then retry.",
        installUrl: `/v1/scm/github/install?orgId=${encodeURIComponent(orgId)}`,
      });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  /** Remove GitHub App credentials + installations for the active org. */
  app.delete("/v1/org/connectors/github/app", async (c) => {
    try {
      const orgId = String(c.get("orgId") ?? c.req.query("orgId") ?? "local");
      const user = c.get("user") as { id?: string } | undefined;
      await store.assertMembership(user?.id, orgId, {
        authMode: c.get("authMode") as string,
        minRole: "admin",
      });
      const result = await store.clearGitHubAppConfig(orgId);
      try {
        const { globalConnectorsStore } = await import("../connectors-store.js");
        await globalConnectorsStore.delete("github", orgId);
      } catch (err) {
        console.warn("[github/app] connector delete after app clear", err);
      }
      return c.json({
        ok: true,
        ...result,
        note: "GitHub App credentials and installations removed for this org",
      });
    } catch (err) {
      return orgErrorResponse(c, err);
    }
  });

  app.get("/v1/org/connectors/github/status", async (c) => {
    const orgId = c.get("orgId") ?? c.req.query("orgId") ?? "local";
    const appCfg = await store.getGitHubAppConfigPublic(orgId);
    const installs = await store.listInstallations(orgId);
    const ghInstalls = installs.filter((i) => i.provider === "github");
    const { orgHasGithubAuth } = await import("../org-scm.js");
    const auth = await orgHasGithubAuth(String(orgId));
    const { resolvePlatformGithubAppPolicy, maskPlatformGithubApp, getPlatformGithubApp } =
      await import("../platform-github-app-store.js");
    const platform = await resolvePlatformGithubAppPolicy();
    const platformStored = await getPlatformGithubApp();
    // PAT may live in connector store (not process.env) after UI save
    let patInConnector = false;
    try {
      const { globalConnectorsStore } = await import("../connectors-store.js");
      const row = await globalConnectorsStore.getAsync("github", String(orgId));
      const { decryptConfigSecrets } = await import("../connectors-file.js");
      const plain = row?.config ? decryptConfigSecrets(row.config) : {};
      patInConnector = Boolean(plain.token);
    } catch {
      /* ignore */
    }
    return c.json({
      authMode:
        auth.mode === "github_app" || auth.mode === "app_pending_install"
          ? "github_app"
          : auth.mode === "pat" || patInConnector || process.env.GITHUB_TOKEN
            ? "pat_legacy"
            : "none",
      githubAppConfigured:
        Boolean(appCfg?.privateKeyConfigured || appCfg?.appId) ||
        platform.configured ||
        auth.mode === "github_app" ||
        auth.mode === "app_pending_install",
      installationReady: auth.mode === "github_app",
      patConfigured: patInConnector || Boolean(process.env.GITHUB_TOKEN),
      patDevOnly: true,
      patAllowed: !platform.enforce || platform.allowOrgPat,
      orgCanConfigureApp: !(platform.enforce && platform.configured),
      platformGithubApp: {
        enforce: platform.enforce,
        configured: platform.configured,
        source: platform.source,
        appId: platform.appId ?? null,
        slug: platform.slug ?? null,
        allowOrgPat: platform.allowOrgPat,
        public: maskPlatformGithubApp(platformStored),
      },
      appId:
        platform.appId ??
        (appCfg?.appId as string) ??
        process.env.GITHUB_APP_ID ??
        null,
      installations: ghInstalls.map((i) => ({
        id: i.id,
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        orgId: i.orgId,
        status: i.status,
      })),
      detail: auth.detail,
      enterpriseRecommendation: platform.enforce
        ? "This install enforces a shared platform GitHub App. Install that App on your GitHub org — do not paste PEMs or PATs."
        : "Use a GitHub App with installation tokens. Personal Access Tokens are for local dev only.",
      installPath: `/v1/scm/github/install?orgId=${encodeURIComponent(String(orgId))}`,
      docs: "https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app",
    });
  });

  /**
   * List GitHub orgs/users where this App is installed.
   * Accepts form PEM (not yet saved) or uses stored App credentials.
   * Powers the Connectors "Account / installation" selector.
   */
  app.post("/v1/org/connectors/github/app/installations", async (c) => {
    try {
      const orgId = c.get("orgId") ?? "local";
      const body = (await c.req.json().catch(() => ({}))) as {
        appId?: string;
        privateKeyPem?: string;
        baseUrl?: string;
      };
      let appId = body.appId?.trim();
      let privateKeyPem = body.privateKeyPem?.trim();
      let baseUrl = body.baseUrl?.trim();

      if (!appId || !privateKeyPem) {
        const cfg = await store.getGitHubAppConfig(String(orgId));
        const creds = store.resolveGitHubAppCredentials(cfg);
        if (creds) {
          appId = appId || creds.appId;
          privateKeyPem = privateKeyPem || creds.privateKey;
          baseUrl = baseUrl || creds.baseUrl || cfg?.baseUrl;
        }
      }
      if (!appId || !privateKeyPem) {
        return c.json(
          {
            ok: false,
            error:
              "App ID and private key required (paste above, or save App credentials first)",
            installations: [],
          },
          400,
        );
      }

      const { listGitHubAppInstallations } = await import("@codesteward/scm");
      const installations = await listGitHubAppInstallations({
        credentials: {
          appId,
          privateKeyPem: privateKeyPem.replace(/\\n/g, "\n"),
          baseUrl: baseUrl || "https://api.github.com",
        },
      });

      // Also surface locally stored installs (may include pending)
      const local = (await store.listInstallations(String(orgId)))
        .filter((i) => i.provider === "github")
        .map((i) => ({
          installationId: i.installationId,
          accountLogin: i.accountLogin,
          accountType: i.accountType ?? "Organization",
          suspended: i.status === "suspended",
          source: "local" as const,
        }));

      const byId = new Map<string, Record<string, unknown>>();
      for (const i of local) {
        if (/^\d+$/.test(String(i.installationId))) {
          byId.set(String(i.installationId), { ...i, source: "local" });
        }
      }
      for (const i of installations) {
        byId.set(i.installationId, { ...i, source: "github" });
      }

      return c.json({
        ok: true,
        installations: [...byId.values()].sort((a, b) =>
          String(a.accountLogin).localeCompare(String(b.accountLogin)),
        ),
        count: byId.size,
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          installations: [],
        },
        400,
      );
    }
  });

  app.post("/v1/org/connectors/github/app/test", async (c) => {
    try {
      const orgId = c.get("orgId") ?? "local";
      const { createOrgScmProvider, orgHasGithubAuth } = await import("../org-scm.js");
      const auth = await orgHasGithubAuth(String(orgId));
      if (!auth.configured) {
        return c.json(
          {
            ok: false,
            error: "No GitHub App or PAT configured for this org",
            authMode: "none",
          },
          400,
        );
      }
      if (auth.mode === "app_pending_install") {
        return c.json(
          {
            ok: false,
            error: auth.detail ?? "Install the GitHub App and set Installation ID",
            authMode: "github_app",
            installationReady: false,
          },
          400,
        );
      }
      const scm = await createOrgScmProvider(String(orgId), "github");
      const repos =
        (await scm.listAuthenticatedRepos?.()) ??
        (await scm.listRepos("octocat").catch(() => []));
      return c.json({
        ok: true,
        authMode: auth.mode,
        sampleRepos: repos.slice(0, 5).map((r) => r.fullName),
        repoCount: repos.length,
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          authMode: isGitHubAppConfigured() ? "github_app" : "pat_legacy",
        },
        400,
      );
    }
  });
}

type ScmInstallationAuth = "github_app" | "pat_legacy" | "gitlab_oauth" | "oauth_app";
