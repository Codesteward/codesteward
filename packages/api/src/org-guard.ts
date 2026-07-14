/** Shared org resource ACL */
export function requireOrgMatch(
  resourceOrgId: string | undefined,
  activeOrgId: string,
  authMode?: string,
): void {
  if (authMode === "dev_open") return;
  if ((resourceOrgId ?? "local") !== activeOrgId) {
    throw Object.assign(new Error("resource not in active org"), { status: 403 });
  }
}

export function orgForbidden(message = "resource not in active org") {
  return { error: "forbidden", message };
}
