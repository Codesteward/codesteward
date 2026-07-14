import { spawn, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createId, nowIso } from "@codesteward/core";
import type { CreateSessionOpts, ExecResult, Sandbox, SandboxSession } from "./types.js";

const execFile = promisify(execFileCb);

/**
 * K8sSandbox — minimal real Job create via `kubectl` when KUBECONFIG is available.
 *
 * Env:
 * - STEW_SANDBOX_NAMESPACE (default: codesteward-sandboxes)
 * - STEW_SANDBOX_IMAGE (default: node:22-bookworm-slim)
 * - KUBECONFIG or in-cluster config used by kubectl
 */
export class K8sSandbox implements Sandbox {
  private sessions = new Map<
    string,
    SandboxSession & { jobName: string; namespace: string }
  >();

  static async kubectlAvailable(): Promise<boolean> {
    try {
      await execFile("kubectl", ["version", "--client", "--output=json"], {
        timeout: 8_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async createSession(opts: CreateSessionOpts): Promise<SandboxSession> {
    const ok = await K8sSandbox.kubectlAvailable();
    if (!ok) {
      throw new Error(
        "K8sSandbox requires kubectl on PATH and a valid KUBECONFIG (or in-cluster config). " +
          "Set STEW_SANDBOX_PROVIDER=local|docker or install kubectl.",
      );
    }

    const namespace =
      process.env.STEW_SANDBOX_NAMESPACE ?? "codesteward-sandboxes";
    const image =
      opts.image ??
      process.env.STEW_SANDBOX_IMAGE ??
      "node:22-bookworm-slim";
    const id = createId("sbx");
    const jobName = `stew-sbx-${id.replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 40)}`;
    const deadline = Number(process.env.STEW_SANDBOX_DEADLINE_SEC ?? 900);

    // Ensure namespace exists (best-effort)
    await runKubectl(
      ["create", "namespace", namespace, "--dry-run=client", "-o", "yaml"],
      15_000,
    ).then((r) =>
      r.exitCode === 0
        ? runKubectl(["apply", "-f", "-"], 15_000, r.stdout)
        : r,
    );

    const manifest = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace,
        labels: {
          app: "codesteward-sandbox",
          "steward.session": id,
        },
      },
      spec: {
        activeDeadlineSeconds: deadline,
        ttlSecondsAfterFinished: 300,
        backoffLimit: 0,
        template: {
          metadata: {
            labels: { app: "codesteward-sandbox", "steward.session": id },
          },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "sandbox",
                image,
                command: ["sleep", "infinity"],
                workingDir: "/workspace/repo",
                resources: {
                  requests: { cpu: "100m", memory: "256Mi" },
                  limits: { cpu: "1", memory: "1Gi" },
                },
              },
            ],
          },
        },
      },
    };

    const apply = await runKubectl(
      ["apply", "-f", "-"],
      30_000,
      JSON.stringify(manifest),
    );
    if (apply.exitCode !== 0) {
      throw new Error(
        `K8sSandbox Job create failed: ${apply.stderr || apply.stdout}`,
      );
    }

    // Wait briefly for pod to be schedulable
    await waitForJobPod(namespace, jobName, 60_000);

    const s: SandboxSession & { jobName: string; namespace: string } = {
      id,
      provider: "k8s",
      repoPath: opts.repoPath,
      workdir: "/workspace/repo",
      sha: opts.sha,
      status: "ready",
      createdAt: nowIso(),
      metadata: {
        namespace,
        jobName,
        image,
        kubeconfig: process.env.KUBECONFIG ?? "(default)",
      },
      jobName,
      namespace,
    };
    this.sessions.set(s.id, s);

    // Best-effort copy repo into pod if path provided
    if (opts.repoPath) {
      try {
        const pod = await getJobPodName(namespace, jobName);
        if (pod) {
          await runKubectl(
            ["exec", "-n", namespace, pod, "--", "mkdir", "-p", "/workspace/repo"],
            15_000,
          );
          await runKubectl(
            ["cp", `${opts.repoPath}/.`, `${namespace}/${pod}:/workspace/repo`],
            120_000,
          );
        }
      } catch (err) {
        console.warn(
          "[k8s-sandbox] repo copy skipped:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return s;
  }

  async exec(
    sessionId: string,
    command: string,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ExecResult> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    s.status = "busy";
    const start = Date.now();
    try {
      const pod = await getJobPodName(s.namespace, s.jobName);
      if (!pod) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "K8sSandbox: no running pod for job",
          durationMs: Date.now() - start,
        };
      }
      const cwd = opts?.cwd ?? "/workspace/repo";
      const envPrefix = Object.entries(opts?.env ?? {})
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ");
      const full = envPrefix
        ? `cd ${shellQuote(cwd)} && ${envPrefix} bash -lc ${shellQuote(command)}`
        : `cd ${shellQuote(cwd)} && bash -lc ${shellQuote(command)}`;
      const result = await runKubectl(
        ["exec", "-n", s.namespace, pod, "--", "bash", "-lc", full],
        opts?.timeoutMs ?? 180_000,
      );
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - start,
      };
    } finally {
      s.status = "ready";
    }
  }

  async upload(
    sessionId: string,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const pod = await getJobPodName(s.namespace, s.jobName);
    if (!pod) throw new Error("K8sSandbox.upload: no pod");
    const dest = remotePath.startsWith("/")
      ? remotePath
      : `/workspace/repo/${remotePath}`;
    const parent = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : "/workspace/repo";
    await runKubectl(
      ["exec", "-n", s.namespace, pod, "--", "mkdir", "-p", parent],
      15_000,
    );
    const r = await runKubectl(
      ["cp", localPath, `${s.namespace}/${pod}:${dest}`],
      60_000,
    );
    if (r.exitCode !== 0) {
      throw new Error(`kubectl cp failed: ${r.stderr}`);
    }
  }

  async download(
    sessionId: string,
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const pod = await getJobPodName(s.namespace, s.jobName);
    if (!pod) throw new Error("K8sSandbox.download: no pod");
    const src = remotePath.startsWith("/")
      ? remotePath
      : `/workspace/repo/${remotePath}`;
    const r = await runKubectl(
      ["cp", `${s.namespace}/${pod}:${src}`, localPath],
      60_000,
    );
    if (r.exitCode !== 0) {
      throw new Error(`kubectl cp failed: ${r.stderr}`);
    }
  }

  async destroy(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await runKubectl(
      ["delete", "job", s.jobName, "-n", s.namespace, "--ignore-not-found=true"],
      30_000,
    );
    this.sessions.delete(sessionId);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function runKubectl(
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("kubectl", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        exitCode: 124,
        stdout,
        stderr: stderr + "\n[timeout]",
        durationMs: Date.now() - start,
      });
    }, timeoutMs);
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}

async function getJobPodName(
  namespace: string,
  jobName: string,
): Promise<string | undefined> {
  const r = await runKubectl(
    [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      `job-name=${jobName}`,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
    15_000,
  );
  const name = r.stdout.trim();
  return name || undefined;
}

async function waitForJobPod(
  namespace: string,
  jobName: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pod = await getJobPodName(namespace, jobName);
    if (pod) {
      const phase = await runKubectl(
        [
          "get",
          "pod",
          pod,
          "-n",
          namespace,
          "-o",
          "jsonpath={.status.phase}",
        ],
        10_000,
      );
      if (["Running", "Succeeded"].includes(phase.stdout.trim())) return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Don't fail hard — exec may still work after scheduling
}
