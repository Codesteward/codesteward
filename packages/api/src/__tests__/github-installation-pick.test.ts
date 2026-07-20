import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickGithubInstallation,
  repoOwnerFromJob,
} from "../github-installation-pick.js";

describe("pickGithubInstallation", () => {
  const installs = [
    {
      provider: "github",
      installationId: "146378294",
      accountLogin: "local",
      status: "active",
    },
    {
      provider: "github",
      installationId: "147804120",
      accountLogin: "scigility",
      status: "active",
    },
  ];

  it("prefers account matching repo owner scigility", () => {
    const pick = pickGithubInstallation(installs, "scigility");
    assert.equal(pick?.installationId, "147804120");
  });

  it("repoOwnerFromJob parses scm full name", () => {
    assert.equal(
      repoOwnerFromJob({ scmFullName: "scigility/navique-agentic-operator" }),
      "scigility",
    );
  });
});
