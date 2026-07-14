/**
 * Org-editable prompt packs.
 *
 * Users customize persona / grounding / output format without code changes.
 * Runtime slots (path rules, org learning) appear in the editor as locked
 * components — content is injected at review time.
 */

/**
 * - editable: org may change body
 * - runtime: filled at review time (path rules, code context)
 * - learning: filled from org feedback (locked)
 * - system: product contract — not org-editable (e.g. JSON output schema)
 */
export type PromptComponentKind = "editable" | "runtime" | "learning" | "system";

export type PromptComponentId =
  | "persona"
  | "grounding"
  | "output_format"
  | "severity"
  | "path_rules"
  | "org_learning"
  | "user_header"
  | "user_context"
  | "user_graph"
  | "deep_tools";

export interface PromptComponent {
  id: PromptComponentId;
  /** Stable display name for the editor */
  label: string;
  description?: string;
  kind: PromptComponentKind;
  /**
   * Template body. Use {{var}} placeholders.
   * Learning/runtime components typically only contain the injection marker text.
   */
  body: string;
  /** Variables this component may reference */
  vars?: string[];
  /** When true, omit component if all of its runtime vars are empty */
  omitIfEmptyVars?: string[];
}

export interface RolePromptTemplate {
  role: string;
  system: PromptComponent[];
  user: PromptComponent[];
}

export interface OrgPromptPack {
  version: 1;
  /** Per-role templates; missing roles fall back to defaults */
  roles: Record<string, RolePromptTemplate>;
  updatedAt?: string;
}

export type PromptRenderVars = {
  severity_floor?: string;
  path_rules?: string;
  org_learning?: string;
  session_id?: string;
  unit_label?: string;
  paths?: string;
  context_text?: string;
  graph_context?: string;
  [key: string]: string | undefined;
};

const OUTPUT_FORMAT_DEFAULT =
  'Respond ONLY with JSON: {"findings":[{"title","body","path","startLine","endLine","category","severity","confidence","suggestion","ruleIds","existingCode"}]}';

const GROUNDING_DEFAULT =
  "Ground findings in SOURCE CODE first (Context FILE excerpts / diffs). The structural graph is supporting evidence for callers, auth, and cross-file edges — not a substitute for reading code.\nWhen graph hits support a finding, cite symbols/callers in the body. Prefer structural evidence over style opinions.";

const SEVERITY_DEFAULT =
  "Severity floor: {{severity_floor}}. Prefer actionable findings. No style nits unless severity allows.";

const PATH_RULES_DEFAULT = "Path rules:\n{{path_rules}}";

const LEARNING_DEFAULT =
  "Org learning (model-side — honor before proposing findings):\n{{org_learning}}";

const DEEP_TOOLS_DEFAULT =
  "You are running inside CodeSteward Review with Codesteward Graph tools and optional sandbox file/exec tools.\nSOURCE CODE FIRST: read Diff/context and use sandbox_read for files you cite. Do not assert line-level bugs from graph topology alone.\nUse graph_query to support cross-file, auth, and call-chain claims — graph complements code, it does not replace it.";

/** Built-in role personas (defaults; orgs may override). */
export const DEFAULT_PERSONAS: Record<string, string> = {
  generalist:
    "You are a senior code reviewer. Find correctness issues, obvious bugs, and API misuse. Prefer high-signal findings.",
  correctness:
    "You are a correctness specialist. Focus on logic bugs, race conditions, error handling, null/edge cases, and invariant violations.",
  security:
    "You are a security specialist. Focus on injection, authz/authn gaps, secrets, SSRF, path traversal, insecure crypto, and taint flows. Use graph referential/semantic queries when available.",
  performance:
    "You are a performance specialist. Focus on N+1 queries, unbounded loops, memory leaks, blocking I/O on hot paths, and algorithmic complexity.",
  testing:
    "You are a testing specialist. Identify missing tests for critical paths, brittle tests, and untested error branches.",
  rules:
    "You are a standards specialist. Enforce project STEWARD.md and path-scoped rules. Cite rule ids.",
  requirements:
    "You are a requirements specialist. Check the change against stated PR goals and missing acceptance criteria.",
  discourse:
    "You are a discourse panelist. Challenge or support candidate findings with brief AGREE/CHALLENGE/CONCEDE notes.",
  evidence:
    "You are an evidence agent. Collect graph edges, tool output, and concrete proof for candidate findings.",
  prove:
    "You are a prove agent. Design minimal failing tests that would validate a critical claim.",
  judge:
    "You are the judge. Deduplicate findings, cap nits, enforce severity floor, and produce the final list.",
  verifier:
    "You are the verifier. For each finding decide keep, drop, or downgrade with a short reason.",
  coordinator:
    "You coordinate specialist agents for a code review. Plan units and merge results.",
};

const SPECIALIST_ROLES = [
  "generalist",
  "correctness",
  "security",
  "performance",
  "testing",
  "rules",
  "requirements",
  "evidence",
  "prove",
  "discourse",
  "judge",
  "verifier",
  "coordinator",
] as const;

function comp(
  id: PromptComponentId,
  label: string,
  kind: PromptComponentKind,
  body: string,
  extra?: Partial<PromptComponent>,
): PromptComponent {
  return { id, label, kind, body, ...extra };
}

function defaultSystemForRole(role: string, deep = false): PromptComponent[] {
  const persona =
    DEFAULT_PERSONAS[role] ?? DEFAULT_PERSONAS.generalist ?? "You are a code reviewer.";
  const parts: PromptComponent[] = [
    comp("persona", "Role persona", "editable", persona, {
      description: "Who the model is for this specialist stage.",
    }),
  ];
  if (deep) {
    parts.push(
      comp("deep_tools", "Tools & code-first rules", "editable", DEEP_TOOLS_DEFAULT, {
        description: "DeepAgents tool usage and code-vs-graph guidance.",
      }),
    );
  } else {
    parts.push(
      comp("grounding", "Code grounding", "editable", GROUNDING_DEFAULT, {
        description: "How to use source context vs structural graph.",
      }),
    );
  }
  parts.push(
    comp("output_format", "Output format (required)", "system", OUTPUT_FORMAT_DEFAULT, {
      description:
        "Product contract for finding extraction (simple + DeepAgents). Not editable — changing this would break the review pipeline.",
    }),
    comp("severity", "Severity bar", "editable", SEVERITY_DEFAULT, {
      description: "Quality bar; {{severity_floor}} is filled from policy.",
      vars: ["severity_floor"],
    }),
    comp("path_rules", "Path rules (policy)", "runtime", PATH_RULES_DEFAULT, {
      description: "Injected from STEWARD / path-scoped policy at review time.",
      vars: ["path_rules"],
      omitIfEmptyVars: ["path_rules"],
    }),
    comp("org_learning", "Org learning (feedback)", "learning", LEARNING_DEFAULT, {
      description:
        "Filled from 👍/👎, status dismissals, and Learnings — not editable here. Shown so you see where feedback lands in the prompt.",
      vars: ["org_learning"],
      omitIfEmptyVars: ["org_learning"],
    }),
  );
  return parts;
}

function defaultUserForRole(): PromptComponent[] {
  return [
    comp(
      "user_header",
      "User header",
      "editable",
      "Session: {{session_id}}\nUnit: {{unit_label}}\nPaths:\n{{paths}}",
      {
        description: "Session / unit framing.",
        vars: ["session_id", "unit_label", "paths"],
      },
    ),
    comp(
      "user_context",
      "Source / diff context",
      "runtime",
      "Source / diff context (read carefully):\n{{context_text}}",
      {
        description: "Packed source or PR diff — runtime only.",
        vars: ["context_text"],
        omitIfEmptyVars: ["context_text"],
      },
    ),
    comp(
      "user_graph",
      "Structural graph",
      "runtime",
      "Structural graph (supporting):\n{{graph_context}}",
      {
        description: "Graph query results — runtime only.",
        vars: ["graph_context"],
        omitIfEmptyVars: ["graph_context"],
      },
    ),
  ];
}

export function buildDefaultRoleTemplate(role: string, deep = false): RolePromptTemplate {
  return {
    role,
    system: defaultSystemForRole(role, deep),
    user: defaultUserForRole(),
  };
}

export function createDefaultPromptPack(): OrgPromptPack {
  const roles: Record<string, RolePromptTemplate> = {};
  for (const r of SPECIALIST_ROLES) {
    roles[r] = buildDefaultRoleTemplate(r, false);
  }
  // DeepAgents uses same pack; deep_tools block is merged at render when runner is deep
  return { version: 1, roles, updatedAt: new Date().toISOString() };
}

export const DEFAULT_PROMPT_PACK: OrgPromptPack = createDefaultPromptPack();

/** Component catalog for the UI (locked vs editable). */
export function listComponentCatalog(): Array<{
  id: PromptComponentId;
  label: string;
  kind: PromptComponentKind;
  description: string;
  maxChars: number;
}> {
  const rows: Array<{
    id: PromptComponentId;
    label: string;
    kind: PromptComponentKind;
    description: string;
  }> = [
    {
      id: "persona",
      label: "Role persona",
      kind: "editable",
      description: "Specialist identity and focus.",
    },
    {
      id: "grounding",
      label: "Code grounding",
      kind: "editable",
      description: "Source-first vs graph guidance (simple runner).",
    },
    {
      id: "deep_tools",
      label: "Tools & code-first rules",
      kind: "editable",
      description: "DeepAgents tools + sandbox read guidance.",
    },
    {
      id: "output_format",
      label: "Output format",
      kind: "system",
      description: "Locked product contract — required for finding extraction.",
    },
    {
      id: "severity",
      label: "Severity bar",
      kind: "editable",
      description: "Uses {{severity_floor}} from policy.",
    },
    {
      id: "path_rules",
      label: "Path rules",
      kind: "runtime",
      description: "Policy path rules injected at runtime.",
    },
    {
      id: "org_learning",
      label: "Org learning",
      kind: "learning",
      description: "User feedback / memories — locked in editor, injected live.",
    },
    {
      id: "user_header",
      label: "User header",
      kind: "editable",
      description: "Session/unit/paths framing.",
    },
    {
      id: "user_context",
      label: "Source context",
      kind: "runtime",
      description: "Packed code/diff at runtime.",
    },
    {
      id: "user_graph",
      label: "Graph context",
      kind: "runtime",
      description: "Graph hits at runtime.",
    },
  ];
  return rows.map((r) => ({ ...r, maxChars: getComponentMaxChars(r.id) }));
}

/** Limits exposed to UI / API consumers. */
export function getPromptLimitPolicy() {
  return {
    components: { ...PROMPT_COMPONENT_MAX_CHARS },
    roleEditableSystemMax: PROMPT_ROLE_EDITABLE_SYSTEM_MAX,
    roleEditableUserMax: PROMPT_ROLE_EDITABLE_USER_MAX,
  };
}

export function renderTemplate(template: string, vars: PromptRenderVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? "" : v;
  });
}

function shouldOmit(c: PromptComponent, vars: PromptRenderVars): boolean {
  if (!c.omitIfEmptyVars?.length) return false;
  return c.omitIfEmptyVars.every((k) => !vars[k]?.trim());
}

export function resolveRoleTemplate(
  pack: OrgPromptPack | null | undefined,
  role: string,
): RolePromptTemplate {
  const fromPack = pack?.roles?.[role];
  if (fromPack?.system?.length) return fromPack;
  return buildDefaultRoleTemplate(role, false);
}

/**
 * Merge deep-tools into system components when DeepAgents runner is active
 * (if pack doesn't already include deep_tools).
 */
export function ensureDeepTools(system: PromptComponent[]): PromptComponent[] {
  if (system.some((c) => c.id === "deep_tools")) return system;
  const groundingIdx = system.findIndex((c) => c.id === "grounding");
  const deep = comp("deep_tools", "Tools & code-first rules", "editable", DEEP_TOOLS_DEFAULT);
  if (groundingIdx >= 0) {
    const next = [...system];
    next.splice(groundingIdx + 1, 0, deep);
    return next;
  }
  return [system[0]!, deep, ...system.slice(1)];
}

export function renderComponents(
  components: PromptComponent[],
  vars: PromptRenderVars,
): string {
  const parts: string[] = [];
  for (const c of components) {
    if (shouldOmit(c, vars)) continue;
    const rendered = renderTemplate(c.body, vars).trim();
    if (!rendered) continue;
    parts.push(rendered);
  }
  return parts.join("\n\n");
}

export function renderSpecialistSystem(
  pack: OrgPromptPack | null | undefined,
  role: string,
  vars: PromptRenderVars,
  opts?: { deep?: boolean },
): string {
  let tpl = resolveRoleTemplate(pack, role);
  let system = tpl.system;
  if (opts?.deep) system = ensureDeepTools(system);
  return renderComponents(system, vars);
}

export function renderSpecialistUser(
  pack: OrgPromptPack | null | undefined,
  role: string,
  vars: PromptRenderVars,
): string {
  const tpl = resolveRoleTemplate(pack, role);
  const user = tpl.user?.length ? tpl.user : defaultUserForRole();
  // If context empty, still warn
  const v = { ...vars };
  if (!v.context_text?.trim()) {
    v.context_text =
      "WARNING: No source/diff context was packed for this unit — only emit findings you can prove from graph evidence, and mark confidence low.";
  }
  // Force user_context to show when we injected the warning
  const components = user.map((c) =>
    c.id === "user_context" ? { ...c, omitIfEmptyVars: undefined } : c,
  );
  return renderComponents(components, v);
}

/** Preview for UI: show structure with learning as a visible locked block. */
export function previewRolePrompt(
  pack: OrgPromptPack | null | undefined,
  role: string,
  sample?: Partial<PromptRenderVars>,
): {
  system: string;
  user: string;
  components: Array<PromptComponent & { rendered: string; locked: boolean }>;
} {
  const vars: PromptRenderVars = {
    severity_floor: sample?.severity_floor ?? "medium",
    path_rules: sample?.path_rules ?? "- [example] src/**: sample path rule",
    org_learning:
      sample?.org_learning ??
      "[preview] Org learning will be injected here from feedback (not editable).",
    session_id: sample?.session_id ?? "ses_preview",
    unit_label: sample?.unit_label ?? "unit-preview",
    paths: sample?.paths ?? "- src/example.ts",
    context_text: sample?.context_text ?? "### FILE: src/example.ts\n// …",
    graph_context: sample?.graph_context ?? "lexical=0 referential=0",
  };
  const tpl = resolveRoleTemplate(pack, role);
  const components = [
    ...tpl.system.map((c) => ({
      ...c,
      rendered: renderTemplate(c.body, vars),
      locked: c.kind !== "editable",
    })),
    ...(tpl.user ?? defaultUserForRole()).map((c) => ({
      ...c,
      rendered: renderTemplate(c.body, vars),
      locked: c.kind !== "editable",
    })),
  ];
  return {
    system: renderSpecialistSystem(pack, role, vars),
    user: renderSpecialistUser(pack, role, vars),
    components,
  };
}

/**
 * Merge partial pack over defaults (role-level deep merge of components by id).
 */
export function mergePromptPack(
  base: OrgPromptPack,
  override: Partial<OrgPromptPack> | null | undefined,
): OrgPromptPack {
  if (!override?.roles) {
    return { ...base, updatedAt: override?.updatedAt ?? base.updatedAt };
  }
  const roles: Record<string, RolePromptTemplate> = { ...base.roles };
  for (const [role, tpl] of Object.entries(override.roles)) {
    if (!tpl) continue;
    const def = roles[role] ?? buildDefaultRoleTemplate(role);
    roles[role] = {
      role,
      system: mergeComponents(def.system, tpl.system),
      user: mergeComponents(def.user, tpl.user),
    };
  }
  return {
    version: 1,
    roles,
    updatedAt: override.updatedAt ?? new Date().toISOString(),
  };
}

function mergeComponents(
  base: PromptComponent[],
  override?: PromptComponent[],
): PromptComponent[] {
  if (!override?.length) return base;
  const byId = new Map(base.map((c) => [c.id, c]));
  for (const o of override) {
    const prev = byId.get(o.id);
    if (!prev) {
      byId.set(o.id, o);
      continue;
    }
    // Never allow client to rewrite locked system/learning/runtime contracts
    if (prev.kind === "learning" || prev.kind === "runtime" || prev.kind === "system") {
      byId.set(o.id, {
        ...prev,
        label: o.label ?? prev.label,
        description: o.description ?? prev.description,
      });
    } else {
      byId.set(o.id, {
        ...prev,
        ...o,
        kind: "editable",
        id: prev.id,
      });
    }
  }
  // Preserve default order, append unknown
  const order = base.map((c) => c.id);
  const seen = new Set<string>();
  const out: PromptComponent[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c) {
      out.push(c);
      seen.add(id);
    }
  }
  for (const [id, c] of byId) {
    if (!seen.has(id)) out.push(c);
  }
  return out;
}

/** Sanitize PUT body from UI — strip attempts to edit learning/runtime bodies + clamp lengths. */
export function sanitizePromptPackInput(
  incoming: OrgPromptPack,
  defaults: OrgPromptPack = DEFAULT_PROMPT_PACK,
): OrgPromptPack {
  const cleaned: OrgPromptPack = { version: 1, roles: {}, updatedAt: new Date().toISOString() };
  for (const [role, tpl] of Object.entries(incoming.roles ?? {})) {
    const def = defaults.roles[role] ?? buildDefaultRoleTemplate(role);
    cleaned.roles[role] = {
      role,
      system: (tpl.system ?? []).map((c) => sanitizeComponent(c, def.system)),
      user: (tpl.user ?? []).map((c) => sanitizeComponent(c, def.user)),
    };
  }
  // Clamp again after merge order; enforce role totals by truncating longest editable bodies if needed
  return enforceRoleTotals(mergePromptPack(defaults, cleaned));
}

/** If role editable totals exceed caps, trim longest editable bodies until under budget. */
function enforceRoleTotals(pack: OrgPromptPack): OrgPromptPack {
  const roles: Record<string, RolePromptTemplate> = {};
  for (const [role, tpl] of Object.entries(pack.roles ?? {})) {
    roles[role] = {
      role,
      system: trimEditableSection(tpl.system ?? [], PROMPT_ROLE_EDITABLE_SYSTEM_MAX),
      user: trimEditableSection(tpl.user ?? [], PROMPT_ROLE_EDITABLE_USER_MAX),
    };
  }
  return { ...pack, roles };
}

function trimEditableSection(components: PromptComponent[], maxTotal: number): PromptComponent[] {
  const next = components.map((c) =>
    c.kind === "editable" ? { ...c, body: clampPromptBody(c.id, c.body ?? "") } : { ...c },
  );
  const total = () =>
    next.reduce((s, c) => s + (c.kind === "editable" ? (c.body?.length ?? 0) : 0), 0);
  while (total() > maxTotal) {
    // Prefer trimming the longest editable body
    let longestIdx = -1;
    let longestLen = 0;
    for (let i = 0; i < next.length; i++) {
      const c = next[i]!;
      if (c.kind !== "editable") continue;
      const len = c.body?.length ?? 0;
      if (len > longestLen) {
        longestLen = len;
        longestIdx = i;
      }
    }
    if (longestIdx < 0 || longestLen <= 0) break;
    const over = total() - maxTotal;
    const c = next[longestIdx]!;
    const cut = Math.max(0, (c.body?.length ?? 0) - over);
    next[longestIdx] = { ...c, body: (c.body ?? "").slice(0, cut) };
    if (cut === (c.body?.length ?? 0)) break;
  }
  return next;
}

function sanitizeComponent(
  c: PromptComponent,
  defaults: PromptComponent[],
): PromptComponent {
  const def = defaults.find((d) => d.id === c.id);
  // Locked contracts — always product defaults (org cannot break the pipeline)
  if (def && (def.kind === "learning" || def.kind === "runtime" || def.kind === "system")) {
    return { ...def };
  }
  // Unknown ids that claim to be system/learning/runtime: drop body edits
  if (c.kind === "learning" || c.kind === "runtime" || c.kind === "system") {
    return def ? { ...def } : { ...c, kind: c.kind };
  }
  const rawBody = typeof c.body === "string" ? c.body : def?.body ?? "";
  return {
    id: c.id,
    label: c.label || def?.label || c.id,
    description: c.description ?? def?.description,
    kind: "editable",
    body: clampPromptBody(c.id, rawBody),
    vars: c.vars ?? def?.vars,
    omitIfEmptyVars: c.omitIfEmptyVars ?? def?.omitIfEmptyVars,
  };
}

/** True if this component may be edited in the org UI. */
export function isPromptComponentEditable(kind: PromptComponentKind): boolean {
  return kind === "editable";
}

/**
 * Character caps for org-editable component bodies (UTF-16 length = JS string length).
 * Locked system/runtime/learning bodies use product defaults and are not limited via editor.
 */
export const PROMPT_COMPONENT_MAX_CHARS: Record<PromptComponentId, number> = {
  persona: 2_000,
  grounding: 3_000,
  deep_tools: 3_000,
  output_format: 1_200, // locked; cap if ever unlocked
  severity: 800,
  path_rules: 4_000, // runtime content at review time is separate
  org_learning: 6_000, // injected learning has its own budget in buildOrgLearningPrompt
  user_header: 1_500,
  user_context: 16_000, // runtime packed code — not org-edited
  user_graph: 6_000, // runtime
};

/** Soft ceiling for sum of editable system components per role. */
export const PROMPT_ROLE_EDITABLE_SYSTEM_MAX = 8_000;
/** Soft ceiling for sum of editable user components per role. */
export const PROMPT_ROLE_EDITABLE_USER_MAX = 2_500;

export function getComponentMaxChars(id: string): number {
  if (id in PROMPT_COMPONENT_MAX_CHARS) {
    return PROMPT_COMPONENT_MAX_CHARS[id as PromptComponentId];
  }
  return 2_000;
}

export function clampPromptBody(id: string, body: string): string {
  const max = getComponentMaxChars(id);
  if (body.length <= max) return body;
  return body.slice(0, max);
}

export type PromptLimitViolation = {
  role: string;
  section: "system" | "user";
  componentId: string;
  length: number;
  max: number;
  message: string;
};

/** Validate editable bodies against per-component and per-role caps. */
export function validatePromptPackLimits(pack: OrgPromptPack): PromptLimitViolation[] {
  const violations: PromptLimitViolation[] = [];
  for (const [role, tpl] of Object.entries(pack.roles ?? {})) {
    let systemEditable = 0;
    let userEditable = 0;
    for (const c of tpl.system ?? []) {
      if (c.kind !== "editable") continue;
      const max = getComponentMaxChars(c.id);
      const len = c.body?.length ?? 0;
      systemEditable += len;
      if (len > max) {
        violations.push({
          role,
          section: "system",
          componentId: c.id,
          length: len,
          max,
          message: `${role}/system/${c.id}: ${len} chars exceeds max ${max}`,
        });
      }
    }
    for (const c of tpl.user ?? []) {
      if (c.kind !== "editable") continue;
      const max = getComponentMaxChars(c.id);
      const len = c.body?.length ?? 0;
      userEditable += len;
      if (len > max) {
        violations.push({
          role,
          section: "user",
          componentId: c.id,
          length: len,
          max,
          message: `${role}/user/${c.id}: ${len} chars exceeds max ${max}`,
        });
      }
    }
    if (systemEditable > PROMPT_ROLE_EDITABLE_SYSTEM_MAX) {
      violations.push({
        role,
        section: "system",
        componentId: "*",
        length: systemEditable,
        max: PROMPT_ROLE_EDITABLE_SYSTEM_MAX,
        message: `${role}: editable system total ${systemEditable} exceeds max ${PROMPT_ROLE_EDITABLE_SYSTEM_MAX}`,
      });
    }
    if (userEditable > PROMPT_ROLE_EDITABLE_USER_MAX) {
      violations.push({
        role,
        section: "user",
        componentId: "*",
        length: userEditable,
        max: PROMPT_ROLE_EDITABLE_USER_MAX,
        message: `${role}: editable user total ${userEditable} exceeds max ${PROMPT_ROLE_EDITABLE_USER_MAX}`,
      });
    }
  }
  return violations;
}

export function clampPromptPackBodies(pack: OrgPromptPack): OrgPromptPack {
  const roles: Record<string, RolePromptTemplate> = {};
  for (const [role, tpl] of Object.entries(pack.roles ?? {})) {
    roles[role] = {
      role,
      system: (tpl.system ?? []).map((c) =>
        c.kind === "editable" ? { ...c, body: clampPromptBody(c.id, c.body ?? "") } : c,
      ),
      user: (tpl.user ?? []).map((c) =>
        c.kind === "editable" ? { ...c, body: clampPromptBody(c.id, c.body ?? "") } : c,
      ),
    };
  }
  return { ...pack, roles };
}
