import type { AgentRole, FindingCandidate, ReviewUnit } from "@codesteward/core";
import type { GraphClient } from "@codesteward/graph-client";
import type { ModelRouter } from "@codesteward/model-router";
import type { Policy } from "@codesteward/policy";
import type { Sandbox } from "@codesteward/sandbox";
import type { SpecialistContext } from "./specialists.js";
import { runSpecialist } from "./specialists.js";
import {
  mapPool,
  maxSpecialistsPerUnit,
  specialistTimeoutMs,
  withTimeout,
} from "./concurrency.js";

/**
 * Agent runner interface — DeepAgents or simple LLM loop.
 */
export interface AgentRunner {
  runSpecialist(role: AgentRole, ctx: SpecialistContext): Promise<FindingCandidate[]>;
  runUnit?(
    roles: AgentRole[],
    ctx: Omit<SpecialistContext, "unit"> & { unit: ReviewUnit },
  ): Promise<FindingCandidate[]>;
}

export interface RunnerDeps {
  modelRouter: ModelRouter;
  graph: GraphClient;
  policy: Policy;
  sandbox?: Sandbox;
}

/** Default runner: sequential LLM complete() calls without deepagents. */
export class SimpleAgentRunner implements AgentRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async runSpecialist(role: AgentRole, ctx: SpecialistContext): Promise<FindingCandidate[]> {
    const timeoutMs = specialistTimeoutMs();
    const startedAtMs = Date.now();
    try {
      return await withTimeout(
        runSpecialist(role, {
          ...ctx,
          modelRouter: ctx.modelRouter ?? this.deps.modelRouter,
          graph: ctx.graph ?? this.deps.graph,
          policy: ctx.policy ?? this.deps.policy,
        }),
        timeoutMs,
        `Simple specialist ${role} (${ctx.unit.label})`,
      );
    } catch (err) {
      const { recordSpecialistFailure, isTimeoutError, specialistTimeoutGapFinding } =
        await import("./specialist-timeout.js");
      recordSpecialistFailure({
        audit: ctx.audit,
        onEvent: ctx.onEvent,
        sessionId: ctx.sessionId,
        unitId: ctx.unit.id,
        unitLabel: ctx.unit.label,
        role,
        runner: "simple",
        err,
        startedAtMs,
      });
      if (isTimeoutError(err)) {
        return [
          specialistTimeoutGapFinding({
            role,
            unitLabel: ctx.unit.label,
            unitPaths: ctx.unit.paths,
            sessionId: ctx.sessionId,
            repoId: ctx.repoId,
            timeoutMs,
            durationMs: Date.now() - startedAtMs,
            runner: "simple",
          }),
        ];
      }
      throw err;
    }
  }

  async runUnit(
    roles: AgentRole[],
    ctx: SpecialistContext,
  ): Promise<FindingCandidate[]> {
    // Parallel roles within a unit; barrier until all finish (same as DeepAgents).
    // Soft-fail per role so one timeout/error does not drop sibling findings.
    const concurrency = maxSpecialistsPerUnit();
    const batches = await mapPool(roles, concurrency, async (role) => {
      try {
        return await this.runSpecialist(role, ctx);
      } catch (err) {
        const {
          isTimeoutError,
          specialistTimeoutGapFinding,
          timeoutMsFromError,
        } = await import("./specialist-timeout.js");
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[agents] specialist ${role} on ${ctx.unit.label} failed (continuing unit): ${msg}`,
        );
        if (isTimeoutError(err)) {
          return [
            specialistTimeoutGapFinding({
              role,
              unitLabel: ctx.unit.label,
              unitPaths: ctx.unit.paths,
              sessionId: ctx.sessionId,
              repoId: ctx.repoId,
              timeoutMs: timeoutMsFromError(err) ?? specialistTimeoutMs(),
              runner: "simple",
            }),
          ];
        }
        return [];
      }
    });
    return batches.flat();
  }
}

/**
 * Create the best available runner.
 * - STEW_USE_DEEPAGENTS=0 → SimpleAgentRunner
 * - else DeepAgentRunner (falls back per-call if import fails)
 */
export function createDeepAgentRunner(deps: RunnerDeps): AgentRunner {
  // Lazy require to avoid circular import issues at typecheck of deep-agent-runner
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return createAgentRunner(deps);
}

export function createAgentRunner(deps: RunnerDeps): AgentRunner {
  if (process.env.STEW_USE_DEEPAGENTS === "0") {
    return new SimpleAgentRunner(deps);
  }
  // Dynamic sync construction of DeepAgentRunner
  // Import is static for bundling simplicity
  return new (requireDeepAgentRunner())(deps);
}

type DeepCtor = new (deps: RunnerDeps) => AgentRunner;

function requireDeepAgentRunner(): DeepCtor {
  // Use static import pattern via function that references module
  // Implemented below after module load
  return DeepAgentRunnerProxy;
}

// Proxy class that defers to deep-agent-runner
class DeepAgentRunnerProxy implements AgentRunner {
  private inner: AgentRunner | null = null;
  private simple: SimpleAgentRunner;
  private deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.simple = new SimpleAgentRunner(deps);
  }

  private requireToolAgents(): boolean {
    return (
      process.env.STEW_REQUIRE_TOOL_AGENTS === "1" ||
      process.env.STEW_AUTH_STRICT === "1" ||
      process.env.NODE_ENV === "production"
    );
  }

  private async load(): Promise<AgentRunner> {
    if (this.inner) return this.inner;
    try {
      const mod = await import("./deep-agent-runner.js");
      this.inner = new mod.DeepAgentRunner(this.deps);
      return this.inner;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.requireToolAgents() && process.env.STEW_USE_DEEPAGENTS !== "0") {
        throw new Error(
          `Tool-using agent runner required (STEW_REQUIRE_TOOL_AGENTS/strict/prod) but DeepAgentRunner failed to load: ${msg}. Set STEW_USE_DEEPAGENTS=0 only for explicit simple mode.`,
        );
      }
      console.warn("[agents] DeepAgentRunner load failed:", msg);
      this.inner = this.simple;
      return this.inner;
    }
  }

  async runSpecialist(role: AgentRole, ctx: SpecialistContext): Promise<FindingCandidate[]> {
    const r = await this.load();
    return r.runSpecialist(role, ctx);
  }

  async runUnit(
    roles: AgentRole[],
    ctx: SpecialistContext,
  ): Promise<FindingCandidate[]> {
    const r = await this.load();
    if (r.runUnit) return r.runUnit(roles, ctx);
    const batches = await Promise.all(roles.map((role) => r.runSpecialist(role, ctx)));
    return batches.flat();
  }
}
