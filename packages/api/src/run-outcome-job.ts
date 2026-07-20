/**
 * Post-merge outcome job: classify findings (accepted / ignored / FN candidates),
 * persist pr_outcomes + finding_outcomes, update findings, seed learning.
 */
import type { ReviewJob, ReviewSession } from "@codesteward/core";
import {
  analyzePrMerge,
  createOutcomeStore,
  type OutcomeFinding,
} from "@codesteward/learning";
import { findingsStore, learningStore } from "./shared-stores.js";
import { globalSessionStore } from "./store.js";
import type { RunJobLog } from "./run-job.js";

export async function runPrOutcomeJob(
  job: ReviewJob,
  session: ReviewSession,
  log: RunJobLog,
): Promise<void> {
  const orgId = job.orgId ?? session.orgId ?? "local";
  const prNumber = job.prNumber ?? session.prNumber;
  if (prNumber == null) {
    log(`pr_outcome skip: no prNumber on job ${job.id}`);
    globalSessionStore.update(session.id, {
      status: "completed",
      stage: "completed",
      metadata: { ...session.metadata, outcomeError: "missing prNumber" },
    });
    return;
  }

  const repoId = job.repoId ?? session.repoId;
  const mergeSha =
    (job.metadata?.mergeSha as string | undefined) ??
    job.headSha ??
    session.headSha;
  const pathsChanged =
    job.paths ??
    (Array.isArray(job.metadata?.pathsChanged)
      ? (job.metadata!.pathsChanged as string[])
      : []);
  const patches = job.patches?.map((p) => ({ path: p.path, patch: p.patch }));
  const gateVerdict =
    (job.metadata?.gateVerdict as string | undefined) ??
    (session.verdict as string | undefined);

  log(
    `pr_outcome org=${orgId} repo=${repoId} pr=#${prNumber} paths=${pathsChanged.length}`,
  );

  const all = await findingsStore.list({ orgId, repoId });
  const findings: OutcomeFinding[] = all.map((f) => ({
    id: f.id,
    sessionId: f.sessionId,
    orgId: f.orgId,
    repoId: f.repoId,
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    title: f.title,
    body: f.body,
    severity: f.severity,
    confidence: f.confidence,
    fingerprint: f.fingerprint,
    status: f.status,
    tags: f.tags,
    suggestedFix: f.suggestedFix,
    suggestion: f.suggestion,
    createdAt: f.createdAt,
  }));

  const result = analyzePrMerge({
    orgId,
    repoId,
    prNumber,
    mergeSha,
    baseSha: job.baseSha ?? session.baseSha,
    headSha: job.headSha ?? session.headSha,
    pathsChanged,
    patches,
    findings,
    gateVerdict,
    sessionIds: [
      session.id,
      ...findings
        .filter((f) => f.sessionId)
        .map((f) => f.sessionId as string),
    ],
  });

  const store = createOutcomeStore();
  await store.savePrOutcome(result.pr);
  await store.saveFindingOutcomes(result.findingOutcomes);

  for (const id of result.markFixedIds) {
    try {
      const f = await findingsStore.get(id);
      if (!f) continue;
      const tags = [
        ...(f.tags ?? []).filter((t) => !t.startsWith("auto-fixed:")),
        `auto-fixed:merge:${mergeSha ?? "unknown"}`,
        "lifecycle:merge_outcome",
      ];
      await findingsStore.update(id, {
        status: "fixed",
        tags: [...new Set(tags)],
      });
    } catch (err) {
      log(`mark fixed failed ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Do NOT eagerly write a repo memory on every merge accept/miss.
  // Promote only when patterns are common (repo-scoped) or cross-repo / important (org-scoped).
  let consolidateSummary: Record<string, unknown> | undefined;
  try {
    const { consolidateOutcomeMemories } = await import("@codesteward/learning");
    const cons = await consolidateOutcomeMemories(store, learningStore, {
      orgId,
    });
    consolidateSummary = {
      scanned: cons.scanned,
      planned: cons.planned.length,
      written: cons.written,
      updated: cons.updated,
      skipped: cons.skipped,
      scopes: cons.promotions.map((p) => ({
        scope: p.promotion.scope,
        repoId: p.promotion.repoId,
        key: p.promotion.key,
        reason: p.promotion.evidence.reason,
      })),
    };
    log(
      `outcome consolidate planned=${cons.planned.length} written=${cons.written} updated=${cons.updated} skipped=${cons.skipped}`,
    );
  } catch (err) {
    log(
      `outcome consolidate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  globalSessionStore.update(session.id, {
    status: "completed",
    stage: "completed",
    metadata: {
      ...session.metadata,
      prOutcomeId: result.pr.id,
      prOutcomeCounts: result.pr.counts,
      prOutcomeRates: result.pr.rates,
      jobKind: "pr_outcome",
      outcomeConsolidate: consolidateSummary,
    },
  });

  log(
    `pr_outcome done posted=${result.pr.counts.posted} fixAccept=${
      (result.pr.counts.accepted ?? 0) +
      (result.pr.counts.fixed ?? 0) +
      (result.pr.counts.thumbsUp ?? 0)
    } noise=${result.pr.counts.falsePositive + result.pr.counts.dismissed} ignore=${result.pr.counts.unaddressedAtMerge} fnCandidates=${result.pr.counts.agentMissCandidates}`,
  );
}
