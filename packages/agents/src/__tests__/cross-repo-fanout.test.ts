import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planCrossRepoFanOut } from "../cross-repo/fanout.js";
import type { MaterializedRepo } from "../cross-repo/materialize.js";
import type { CrossRepoLink } from "@codesteward/core";

const baseLink = (over: Partial<CrossRepoLink> = {}): CrossRepoLink => ({
  id: "lnk1",
  orgId: "local",
  fromRepoId: "acme/api",
  toRepoId: "acme/lib",
  edgeType: "depends_on_api",
  pathFilters: { from: [], to: [] },
  hints: {},
  maxDepth: 2,
  tokenBudget: 50_000,
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe("planCrossRepoFanOut materialize", () => {
  it("skips linked units without a materialized path", async () => {
    const fan = await planCrossRepoFanOut({
      sessionId: "s1",
      primaryRepoId: "acme/api",
      primaryPaths: ["src/x.ts"],
      links: [baseLink()],
    });
    assert.equal(fan.units.length, 0);
    assert.ok(fan.skipped.some((s) => s.repoId === "acme/lib"));
  });

  it("emits unit with clone path when materialized", async () => {
    const mat = new Map<string, MaterializedRepo>([
      [
        "acme/lib",
        {
          repoId: "acme/lib",
          repoPath: "/tmp/workspaces/s1/cross/acme__lib",
          source: "clone",
          notes: ["Cloned acme/lib"],
        },
      ],
    ]);
    const fan = await planCrossRepoFanOut({
      sessionId: "s1",
      primaryRepoId: "acme/api",
      primaryPaths: ["src/x.ts"],
      links: [baseLink()],
      materialized: mat,
    });
    assert.equal(fan.units.length, 1);
    assert.equal(fan.units[0]!.metadata?.repoId, "acme/lib");
    assert.equal(
      fan.units[0]!.metadata?.repoPath,
      "/tmp/workspaces/s1/cross/acme__lib",
    );
    assert.equal(fan.units[0]!.metadata?.crossRepo, true);
  });
});
