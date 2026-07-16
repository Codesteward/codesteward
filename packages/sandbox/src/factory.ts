import { LocalSandbox } from "./local.js";
import { K8sSandbox } from "./k8s.js";
import { NullSandbox } from "./null.js";
import type { Sandbox } from "./types.js";

/**
 * Multi-tenant: STEW_TENANT_ISOLATION=strict refuses host-local shells so agents
 * cannot `cat ../other-org-session` on a shared worker filesystem.
 */
function resolveProvider(
  provider: string = process.env.STEW_SANDBOX_PROVIDER ?? "null",
): string {
  const isolation = (process.env.STEW_TENANT_ISOLATION ?? "path").toLowerCase();
  const strict = isolation === "strict" || isolation === "hard" || isolation === "2";
  if (!strict) return provider;
  if (provider === "docker" || provider === "k8s" || provider === "kubernetes") {
    return provider;
  }
  // Prefer docker for hard multi-tenant isolation of agent tools
  if (process.env.STEW_SANDBOX_DOCKER !== "0") {
    console.warn(
      "[sandbox] STEW_TENANT_ISOLATION=strict — using docker sandbox (not local/null)",
    );
    return "docker";
  }
  console.warn(
    "[sandbox] STEW_TENANT_ISOLATION=strict but STEW_SANDBOX_DOCKER=0 — k8s preferred; local host shell is unsafe for multi-tenant",
  );
  return provider === "null" ? "local" : provider;
}

/**
 * Create a sandbox provider.
 * When STEW_SANDBOX_PROVIDER=k8s but kubectl is missing, auto-fallback to LocalSandbox.
 */
export function createSandbox(
  provider: string = process.env.STEW_SANDBOX_PROVIDER ?? "null",
): Sandbox {
  switch (resolveProvider(provider)) {
    case "docker":
      return new LocalSandbox({ useDocker: true });
    case "local":
      return new LocalSandbox({ useDocker: false });
    case "k8s":
    case "kubernetes":
      return new K8sSandboxWithFallback();
    case "null":
    default:
      return new NullSandbox();
  }
}

/**
 * Async factory that can probe kubectl before choosing K8s.
 * Preferred when caller can await (worker/orchestrator startup).
 */
export async function createSandboxAsync(
  provider: string = process.env.STEW_SANDBOX_PROVIDER ?? "null",
): Promise<Sandbox> {
  if (provider === "k8s" || provider === "kubernetes") {
    const ok = await K8sSandbox.kubectlAvailable();
    if (!ok) {
      console.warn(
        "[sandbox] STEW_SANDBOX_PROVIDER=k8s but kubectl unavailable — falling back to LocalSandbox",
      );
      return new LocalSandbox({ useDocker: process.env.STEW_SANDBOX_DOCKER === "1" });
    }
    return new K8sSandbox();
  }
  return createSandbox(provider);
}

/**
 * Lazy K8s sandbox: on first createSession, probe kubectl and fallback to local.
 */
class K8sSandboxWithFallback implements Sandbox {
  private inner: Sandbox | null = null;

  private async resolve(): Promise<Sandbox> {
    if (this.inner) return this.inner;
    const ok = await K8sSandbox.kubectlAvailable();
    if (!ok) {
      console.warn(
        "[sandbox] STEW_SANDBOX_PROVIDER=k8s but kubectl missing — auto-fallback to LocalSandbox",
      );
      this.inner = new LocalSandbox({
        useDocker: process.env.STEW_SANDBOX_DOCKER === "1",
      });
    } else {
      this.inner = new K8sSandbox();
    }
    return this.inner;
  }

  async createSession(opts: Parameters<Sandbox["createSession"]>[0]) {
    return (await this.resolve()).createSession(opts);
  }
  async exec(
    sessionId: string,
    command: string,
    opts?: Parameters<Sandbox["exec"]>[2],
  ) {
    return (await this.resolve()).exec(sessionId, command, opts);
  }
  async upload(sessionId: string, localPath: string, remotePath: string) {
    return (await this.resolve()).upload(sessionId, localPath, remotePath);
  }
  async download(sessionId: string, remotePath: string, localPath: string) {
    return (await this.resolve()).download(sessionId, remotePath, localPath);
  }
  async destroy(sessionId: string) {
    return (await this.resolve()).destroy(sessionId);
  }
}
