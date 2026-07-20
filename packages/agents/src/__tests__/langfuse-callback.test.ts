/**
 * Unit tests for dual-write Langfuse LangChain callback (no network).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  DualLangfuseCallbackHandler,
  normalizeLangfuseValue,
  sanitizeModelParameters,
  safeJson,
} from "../langfuse-langchain.js";

describe("DualLangfuseCallbackHandler", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    delete process.env.STEW_LICENSE_LANGFUSE;
    delete process.env.STEW_LANGFUSE_ENABLED;
  });

  afterEach(() => {
    process.env = { ...prev };
  });

  it("returns null when no destinations", () => {
    const h = DualLangfuseCallbackHandler.create({
      destinations: [],
      sessionId: "ses_1",
      role: "security",
    });
    assert.equal(h, null);
  });

  it("creates handler with org+platform destinations", () => {
    const h = DualLangfuseCallbackHandler.create({
      destinations: [
        {
          publicKey: "pk-org",
          secretKey: "sk-org",
          enabled: true,
          source: "org",
        },
        {
          publicKey: "pk-plat",
          secretKey: "sk-plat",
          enabled: true,
          source: "platform",
        },
      ],
      sessionId: "ses_review_abc",
      orgId: "org_1",
      role: "security",
      unitId: "u1",
      unitLabel: "unit-1",
    });
    assert.ok(h);
    // Name is session-scoped so LangChain cannot reuse another review's handler
    assert.equal(h!.name, "cs_lf_ses_review_abc_security_u1");
    assert.equal(h!.awaitHandlers, true);
  });

  it("skips incomplete destinations", () => {
    const h = DualLangfuseCallbackHandler.create({
      destinations: [
        { publicKey: "pk", secretKey: "", enabled: true, source: "org" },
        {
          publicKey: "pk-plat",
          secretKey: "sk-plat",
          enabled: true,
          source: "platform",
        },
      ],
      sessionId: "ses_x",
      role: "judge",
    });
    assert.ok(h);
  });
});

describe("normalizeLangfuseValue (span I/O for Langfuse UI)", () => {
  it("unwraps LangChain serialized HumanMessage", () => {
    const raw = {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "HumanMessage"],
      kwargs: { content: "review this file", additional_kwargs: {} },
    };
    const n = normalizeLangfuseValue(raw) as { role: string; content: string };
    assert.equal(n.role, "user");
    assert.equal(n.content, "review this file");
    assert.equal("lc" in (n as object), false);
  });

  it("unwraps messages[] on graph state", () => {
    const n = normalizeLangfuseValue({
      messages: [
        {
          lc: 1,
          type: "constructor",
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            content: "",
            tool_calls: [{ name: "sandbox_read", args: { path: "a.ts" } }],
          },
        },
      ],
    }) as { messages: Array<{ role: string; tool_calls?: unknown }> };
    assert.equal(n.messages[0]!.role, "assistant");
    assert.ok(n.messages[0]!.tool_calls);
  });

  it("safeJson does not leave lc constructor blobs", () => {
    const out = safeJson({
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "ToolMessage"],
      kwargs: { content: "file contents here", status: "success", name: "sandbox_read" },
    }) as { role: string; content: string; status?: string };
    assert.equal(out.role, "tool");
    assert.match(out.content, /file contents/);
  });
});

describe("sanitizeModelParameters (Langfuse MapValue)", () => {
  it("keeps primitives and string arrays", () => {
    const out = sanitizeModelParameters({
      temperature: 0.2,
      max_tokens: 1000,
      stream: false,
      stop: ["\n\n"],
    });
    assert.deepEqual(out, {
      temperature: 0.2,
      max_tokens: 1000,
      stream: false,
      stop: ["\n\n"],
    });
  });

  it("does not pass tools as object arrays (Langfuse 400 root cause)", () => {
    const out = sanitizeModelParameters({
      model: "gpt-4.1",
      tools: [
        { type: "function", function: { name: "sandbox_read", parameters: {} } },
        { type: "function", function: { name: "graph_query", parameters: {} } },
      ],
    });
    assert.ok(out);
    assert.equal(out!.tools, undefined);
    assert.equal(out!.toolsCount, 2);
    assert.deepEqual(out!.toolsNames, ["sandbox_read", "graph_query"]);
    assert.equal(out!.model, "gpt-4.1");
  });

  it("stringifies nested objects", () => {
    const out = sanitizeModelParameters({
      response_format: { type: "json_object" },
    });
    assert.ok(out);
    assert.equal(typeof out!.response_format, "string");
    assert.ok(String(out!.response_format).includes("json_object"));
  });
});
