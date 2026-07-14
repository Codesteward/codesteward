import type { FindingStatus } from "@codesteward/core";

const ALLOWED: Record<FindingStatus, FindingStatus[]> = {
  open: ["acknowledged", "fixed", "dismissed", "wontfix", "false_positive", "suppressed"],
  acknowledged: ["fixed", "dismissed", "wontfix", "false_positive", "open", "reopened"],
  fixed: ["reopened", "open"],
  dismissed: ["reopened", "open"],
  wontfix: ["reopened", "open"],
  false_positive: ["reopened", "open"],
  reopened: ["acknowledged", "fixed", "dismissed", "wontfix", "false_positive", "open"],
  suppressed: ["open", "reopened"],
};

export function canTransition(from: FindingStatus, to: FindingStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertTransition(from: FindingStatus, to: FindingStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid finding status transition: ${from} → ${to}`);
  }
}
