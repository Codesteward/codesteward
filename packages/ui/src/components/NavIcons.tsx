import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookOpenCheck,
  Brain,
  BrainCircuit,
  Building2,
  FileDiff,
  GitBranchPlus,
  GitFork,
  GitPullRequest,
  LayoutDashboard,
  FileText,
  ListChecks,
  MessageSquareText,
  Plug,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";

/**
 * Product-fitted Lucide map for sidebar / chrome.
 * Chosen for shape uniqueness at ~22px and domain fit (gate, SCM, models, policy).
 */
const MAP: Record<string, LucideIcon> = {
  /** Home overview */
  dashboard: LayoutDashboard,
  /** Address-rate / metrics */
  analytics: BarChart3,
  /** PR merge gate — pass/fail shield */
  gate: ShieldCheck,
  /** Branch stewardship mode */
  steward: GitBranchPlus,
  /** Review findings / issues */
  findings: ListChecks,
  /** Human-readable session reports */
  reports: FileText,
  /** Pull requests */
  prs: GitPullRequest,
  /** Cross-repo fan-out links */
  crossRepo: GitFork,
  /** Org memories / 👍👎 learning */
  learnings: Brain,
  /** SCM & integrations */
  connectors: Plug,
  /** Team / RBAC */
  members: Users,
  /** Per-stage LLM matrix */
  models: BrainCircuit,
  /** Specialist prompt pack editor */
  prompts: MessageSquareText,
  /** STEWARD.md / org policy */
  policy: ScrollText,
  settings: Settings,
  org: Building2,
  account: UserRound,
  platform: Server,
  /** Diff viewer */
  diff: FileDiff,
  /** Onboarding / docs-style surfaces */
  guide: BookOpenCheck,
};

/** Sidebar / nav icons — sized for legibility at a glance. */
export function NavIcon({
  name,
  size = 22,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const Icon = MAP[name] ?? LayoutDashboard;
  return (
    <Icon
      size={size}
      strokeWidth={2.25}
      absoluteStrokeWidth
      className={className}
      aria-hidden
    />
  );
}
