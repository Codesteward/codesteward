/**
 * Pick the correct GitHub App installation for a product org + target repo owner.
 * Avoids minting a token for the wrong installation when multiple installs exist
 * (e.g. product org "local" has both a personal install and scigility).
 */
export type InstallPick = {
  provider: string;
  installationId: string;
  accountLogin?: string;
  status?: string;
};

/**
 * @param installs - tenancy installations for the product org
 * @param preferredAccount - GitHub org/user login that owns the repo (e.g. "scigility")
 */
export function pickGithubInstallation(
  installs: InstallPick[],
  preferredAccount?: string | null,
): InstallPick | undefined {
  const active = installs.filter(
    (i) =>
      i.provider === "github" &&
      i.status !== "suspended" &&
      i.status !== "deleted" &&
      i.installationId &&
      !String(i.installationId).startsWith("pending:") &&
      /^\d+$/.test(String(i.installationId)),
  );
  if (!active.length) return undefined;

  const want = preferredAccount?.trim().toLowerCase();
  if (want) {
    const byLogin = active.find(
      (i) => (i.accountLogin ?? "").trim().toLowerCase() === want,
    );
    if (byLogin) return byLogin;
    // accountLogin sometimes stored as "installation-123" — weak match skip
  }

  // Prefer non-placeholder account logins over "local" / "installation-*"
  const ranked = [...active].sort((a, b) => scoreInstall(b) - scoreInstall(a));
  return ranked[0];
}

function scoreInstall(i: InstallPick): number {
  const login = (i.accountLogin ?? "").toLowerCase();
  if (!login || login === "local" || login === "_pending") return 0;
  if (login.startsWith("installation-")) return 1;
  return 5;
}

/** Parse owner from scm full name or job fields. */
export function repoOwnerFromJob(input: {
  owner?: string;
  scmFullName?: string;
  repoId?: string;
}): string | undefined {
  if (input.owner?.trim()) return input.owner.trim();
  const full = input.scmFullName?.trim() || input.repoId?.trim();
  if (!full || !full.includes("/")) return undefined;
  return full.split("/")[0] || undefined;
}
