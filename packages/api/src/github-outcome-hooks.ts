/**
 * GitHub webhook hooks for indirect eval signals beyond merge:
 * - review thread resolved/unresolved → finding outcomes
 * - security / repository advisories → coverage / FN candidates
 */
import { createId, nowIso } from "@codesteward/core";
import {
  createOutcomeStore,
  consolidateOutcomeMemories,
  makePrKey,
} from "@codesteward/learning";
import { findingsStore, learningStore } from "./shared-stores.js";

export async function handleReviewThreadOutcome(input: {
  action: "resolved" | "unresolved" | string;
  orgId: string;
  repoId: string;
  prNumber: number;
  commentIds: string[];
  threadNodeId?: string;
  delivery: string;
}): Promise<{ matched: number; outcomeIds: string[] }> {
  const kind =
    input.action === "resolved"
      ? ("thread_resolved" as const)
      : input.action === "unresolved"
        ? ("thread_unresolved" as const)
        : null;
  if (!kind) return { matched: 0, outcomeIds: [] };

  const prKey = makePrKey(input.repoId, input.prNumber);
  const store = createOutcomeStore();
  const outcomeIds: string[] = [];
  let matched = 0;
  const seenFindings = new Set<string>();

  for (const commentId of input.commentIds) {
    const finding =
      (await findingsStore.findByScmCommentId?.(commentId, {
        orgId: input.orgId,
        repoId: input.repoId,
      })) ??
      (await findingsStore.findByScmCommentId?.(commentId, {
        orgId: input.orgId,
      }));
    if (!finding || seenFindings.has(finding.id)) continue;
    seenFindings.add(finding.id);
    matched++;

    const outcomeId = createId("fout");
    await store.saveFindingOutcomes([
      {
        id: outcomeId,
        orgId: input.orgId,
        repoId: finding.repoId || input.repoId,
        prNumber: input.prNumber,
        prKey,
        findingId: finding.id,
        fingerprint: finding.fingerprint,
        kind,
        sessionId: finding.sessionId,
        // Soft confidence: resolved ≠ code fixed
        confidence: kind === "thread_resolved" ? 0.7 : 0.6,
        note:
          kind === "thread_resolved"
            ? `GitHub review thread resolved for comment ${commentId}`
            : `GitHub review thread unresolved for comment ${commentId}`,
        metadata: {
          source: "pull_request_review_thread",
          action: input.action,
          commentId,
          threadNodeId: input.threadNodeId,
          delivery: input.delivery,
          severity: finding.severity,
          path: finding.path,
        },
        createdAt: nowIso(),
      },
    ]);
    outcomeIds.push(outcomeId);

    // Soft status nudge — do not force false_positive; only tag lifecycle
    try {
      const tags = [
        ...(finding.tags ?? []).filter(
          (t) => !t.startsWith("thread:"),
        ),
        kind === "thread_resolved" ? "thread:resolved" : "thread:unresolved",
      ];
      if (kind === "thread_resolved" && finding.status === "open") {
        await findingsStore.update(finding.id, {
          status: "acknowledged",
          tags: [...new Set(tags)],
        });
      } else if (
        kind === "thread_unresolved" &&
        (finding.status === "acknowledged" || finding.status === "fixed")
      ) {
        await findingsStore.update(finding.id, {
          status: "reopened",
          tags: [...new Set([...tags, "lifecycle:reopened"])],
        });
      } else {
        await findingsStore.update(finding.id, { tags: [...new Set(tags)] });
      }
    } catch {
      /* optional */
    }
  }

  // Promote frequent thread-resolved patterns into scoped memories
  if (matched > 0) {
    try {
      await consolidateOutcomeMemories(store, learningStore, {
        orgId: input.orgId,
      });
    } catch {
      /* optional */
    }
  }

  return { matched, outcomeIds };
}

export async function handleSecurityAdvisoryOutcome(input: {
  action: string;
  orgId: string;
  repoId?: string;
  ghsaId?: string;
  summary?: string;
  severity?: string;
  packageNames?: string[];
  delivery: string;
}): Promise<{ outcomeId?: string }> {
  const store = createOutcomeStore();
  const repoId = input.repoId ?? `${input.orgId}/advisories`;
  const outcomeId = createId("fout");
  const packages = input.packageNames ?? [];
  const pattern =
    packages[0] ??
    (input.ghsaId ? `ghsa:${input.ghsaId}` : "security-advisory");

  await store.saveFindingOutcomes([
    {
      id: outcomeId,
      orgId: input.orgId,
      repoId,
      kind: "security_advisory",
      confidence: 0.45,
      note: [
        input.ghsaId ? `GHSA ${input.ghsaId}` : "security advisory",
        input.summary?.slice(0, 200),
        packages.length ? `packages: ${packages.slice(0, 8).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" — "),
      metadata: {
        source: "security_advisory",
        action: input.action,
        ghsaId: input.ghsaId,
        severity: input.severity,
        packages,
        delivery: input.delivery,
        repository: input.repoId,
      },
      createdAt: nowIso(),
    },
  ]);

  // Soft positive pattern memory so consolidator / next reviews can focus packages
  try {
    await learningStore.addMemory({
      orgId: input.orgId,
      scope: input.repoId ? "repo" : "org",
      repoId: input.repoId,
      kind: "pattern",
      polarity: "positive",
      pattern,
      title: input.ghsaId
        ? `Advisory ${input.ghsaId}`
        : `Security advisory: ${pattern}`,
      body:
        input.summary?.slice(0, 400) ||
        `External advisory signal (${input.action}). Review dependency / related code for ${packages.join(", ") || pattern}.`,
      source: "security_advisory",
      weight: 0.45,
    });
  } catch {
    /* optional */
  }

  try {
    await consolidateOutcomeMemories(store, learningStore, {
      orgId: input.orgId,
    });
  } catch {
    /* optional */
  }

  return { outcomeId };
}
