/**
 * First-login product tour — Models → Connectors → Gate → Findings.
 * Library: driver.js (MIT).
 *
 * Status is dual-written:
 * 1) PATCH /v1/auth/me/preferences (server — survives devices when DB/file works)
 * 2) localStorage keyed by user id (survives hard refresh even if API fails)
 *
 * Closing mid-tour (X / overlay) marks "skipped" and toasts how to replay.
 */
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { driver, type DriveStep, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { api, type AuthUser } from "../lib/api";
import { useToast } from "./Toast";

export const TOUR_PREF_KEY = "productTour";
export type FirstReviewTourStatus = "completed" | "skipped";

type TourPrefs = { firstReviewStatus?: FirstReviewTourStatus };

/** Survives Layout remounts so the tour does not restart at step 0. */
let sharedDriver: Driver | null = null;
let tourRunning = false;
let autoStartResolved = false;
let finishInFlight = false;
/** Latest navigate / toast from the mounted host component. */
let navigateFn: ((path: string) => void) | null = null;
let toastFn: ((message: string) => void) | null = null;
/** User id for localStorage keys while tour is active. */
let activeUserId: string | null = null;

function localTourKey(userId: string): string {
  return `cs.${TOUR_PREF_KEY}.${userId}`;
}

function readLocalTourStatus(userId: string | undefined | null): FirstReviewTourStatus | undefined {
  if (!userId || typeof localStorage === "undefined") return undefined;
  try {
    const v = localStorage.getItem(localTourKey(userId));
    if (v === "completed" || v === "skipped") return v;
  } catch {
    /* private mode */
  }
  return undefined;
}

function writeLocalTourStatus(userId: string | undefined | null, status: FirstReviewTourStatus): void {
  if (!userId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(localTourKey(userId), status);
  } catch {
    /* private mode */
  }
}

/** Clear local status so a forced replay can auto-start again after skip/complete. */
export function clearLocalTourStatus(userId: string | undefined | null): void {
  if (!userId || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(localTourKey(userId));
  } catch {
    /* ignore */
  }
}

function readServerTourStatus(user: AuthUser | null | undefined): FirstReviewTourStatus | undefined {
  const p = user?.preferences?.[TOUR_PREF_KEY];
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  const s = (p as TourPrefs).firstReviewStatus;
  if (s === "completed" || s === "skipped") return s;
  return undefined;
}

/** Prefer server, fall back to localStorage (hard-refresh safety). */
function resolveTourStatus(user: AuthUser | null | undefined): FirstReviewTourStatus | undefined {
  return readServerTourStatus(user) ?? readLocalTourStatus(user?.id);
}

export async function persistTourStatus(
  status: FirstReviewTourStatus,
  userId?: string | null,
): Promise<void> {
  const id = userId ?? activeUserId;
  // Write local first so a hard refresh immediately after close never re-opens the tour
  writeLocalTourStatus(id, status);
  await api.updatePreferences({
    [TOUR_PREF_KEY]: { firstReviewStatus: status },
  });
}

/**
 * Scroll a tour target into view.
 * Sidebar nav items live in [data-tour=nav-scroll] — window/main scroll alone
 * will not reveal them.
 */
function scrollTourTargetIntoView(el: Element | undefined, d: Driver | null) {
  if (!el || !(el instanceof HTMLElement)) return;
  if (el.id === "driver-dummy-element") return;

  const navScroll = document.querySelector<HTMLElement>("[data-tour='nav-scroll']");
  if (navScroll?.contains(el)) {
    const parentRect = navScroll.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta =
      elRect.top - parentRect.top - parentRect.height / 2 + elRect.height / 2;
    navScroll.scrollTop += delta;
  } else {
    el.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
    let parent: HTMLElement | null = el.parentElement;
    while (parent && parent !== document.body) {
      const style = window.getComputedStyle(parent);
      const oy = style.overflowY;
      if (
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        parent.scrollHeight > parent.clientHeight + 1
      ) {
        const parentRect = parent.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        if (elRect.top < parentRect.top || elRect.bottom > parentRect.bottom) {
          const delta = elRect.top - parentRect.top - 16;
          parent.scrollTop += delta;
        }
        break;
      }
      parent = parent.parentElement;
    }
  }

  requestAnimationFrame(() => d?.refresh());
  window.setTimeout(() => d?.refresh(), 120);
  window.setTimeout(() => d?.refresh(), 320);
}

function waitForSelector(selector: string, attempts = 40): Promise<Element | null> {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) {
        resolve(el);
        return;
      }
      n += 1;
      if (n >= attempts) {
        resolve(null);
        return;
      }
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

function buildSteps(): DriveStep[] {
  const go = (path: string, nextSelector: string, nextIndex: number) => {
    navigateFn?.(path);
    void (async () => {
      const d = sharedDriver;
      if (!d || !d.isActive()) return;
      const el = await waitForSelector(nextSelector);
      if (el) scrollTourTargetIntoView(el, d);
      const current = d.getActiveIndex();
      if (current !== nextIndex) {
        d.moveTo(nextIndex);
      } else {
        d.refresh();
      }
      window.setTimeout(() => d.refresh(), 80);
      window.setTimeout(() => d.refresh(), 250);
    })();
  };

  const onHighlight: DriveStep["onHighlighted"] = (element, _step, { driver: d }) => {
    scrollTourTargetIntoView(element, d);
  };

  return [
    {
      popover: {
        title: "Welcome to Codesteward",
        description:
          "This short guide covers what you need for your <strong>first review</strong>: a model, a code host, then starting a gate. Skip anytime — re-open from <strong>Account → Replay product tour</strong>.",
        align: "center",
      },
    },
    {
      element: "[data-tour='nav-models']",
      onHighlighted: onHighlight,
      popover: {
        title: "1 · Models (required)",
        description:
          "Add at least one LLM provider and API key. Reviews cannot run without a configured model.",
        side: "right",
        align: "start",
        onNextClick: () => go("/models", "[data-tour='models-providers']", 2),
      },
    },
    {
      element: "[data-tour='models-providers']",
      onHighlighted: onHighlight,
      popover: {
        title: "Configure a provider",
        description:
          "Open a provider, paste your API key, and save. You can split cheap vs thorough models later in stage settings.",
        side: "left",
        align: "start",
      },
    },
    {
      element: "[data-tour='nav-connectors']",
      onHighlighted: onHighlight,
      popover: {
        title: "2 · Connectors (SCM)",
        description:
          "Connect GitHub (or GitLab / Bitbucket / …) so Codesteward can list PRs, clone, and publish comments.",
        side: "right",
        align: "start",
        onNextClick: () => go("/connectors", "[data-tour='page-connectors']", 4),
      },
    },
    {
      element: "[data-tour='page-connectors']",
      onHighlighted: onHighlight,
      popover: {
        title: "Link your repository host",
        description:
          "Install a GitHub App or token for the org. Live webhooks need a public API URL; you can still run a UI or CLI gate with repo access alone.",
        side: "left",
        align: "start",
      },
    },
    {
      element: "[data-tour='nav-gate']",
      onHighlighted: onHighlight,
      popover: {
        title: "3 · Gate a PR",
        description:
          "<strong>Gate</strong> is the PR merge check. <strong>Steward</strong> is for long-lived branches. Start with Gate for your first review.",
        side: "right",
        align: "start",
        onNextClick: () => go("/sessions?mode=gate", "[data-tour='page-sessions']", 6),
      },
    },
    {
      element: "[data-tour='page-sessions']",
      onHighlighted: onHighlight,
      popover: {
        title: "Start your first review",
        description:
          "Pick a repository and PR (or path), then start. Watch the stage pipeline in the session detail while specialists run.",
        side: "top",
        align: "center",
      },
    },
    {
      element: "[data-tour='nav-findings']",
      onHighlighted: onHighlight,
      popover: {
        title: "4 · Findings",
        description:
          "Confirmed issues land here. Use reactions and dismissals so the learning loop quiets the next review.",
        side: "right",
        align: "start",
        onNextClick: () => go("/findings", "[data-tour='page-findings']", 8),
      },
    },
    {
      element: "[data-tour='page-findings']",
      onHighlighted: onHighlight,
      popover: {
        title: "You’re ready",
        description:
          "Path: <strong>Models → Connectors → Gate → Findings</strong>. Replay this tour anytime from <strong>Account → Replay product tour</strong>.",
        side: "left",
        align: "start",
      },
    },
  ];
}

async function finishTour(status: FirstReviewTourStatus): Promise<void> {
  if (finishInFlight) return;
  finishInFlight = true;
  tourRunning = false;
  try {
    await persistTourStatus(status, activeUserId);
  } catch (err) {
    // Local write already happened inside persistTourStatus before the API call
    console.warn("[tour] failed to persist status to server (local copy kept)", err);
  } finally {
    finishInFlight = false;
  }
}

function tearDownDriverSilently() {
  const old = sharedDriver;
  sharedDriver = null;
  tourRunning = false;
  if (!old) return;
  try {
    old.destroy();
  } catch {
    /* ignore */
  }
}

function createAndStartTour(userId?: string | null): void {
  if (tourRunning && sharedDriver?.isActive()) {
    return;
  }
  tearDownDriverSilently();
  if (userId) activeUserId = userId;

  tourRunning = true;
  const d = driver({
    showProgress: true,
    animate: true,
    allowClose: true,
    smoothScroll: false,
    allowScroll: true,
    overlayColor: "rgba(15, 23, 42, 0.62)",
    stagePadding: 8,
    stageRadius: 10,
    popoverClass: "cs-driver-popover",
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    progressText: "{{current}} of {{total}}",
    steps: buildSteps(),
    onHighlighted: (element, _step, { driver: inst }) => {
      scrollTourTargetIntoView(element, inst);
    },
    onDestroyStarted: () => {
      const inst = sharedDriver;
      if (!inst) return;
      const completed = inst.isLastStep() || !inst.hasNextStep();
      const status: FirstReviewTourStatus = completed ? "completed" : "skipped";
      void finishTour(status);
      // Mid-tour close (X / overlay / Esc) — tell them how to restart
      if (!completed) {
        toastFn?.(
          "Tour dismissed. You can restart anytime from Account → Replay product tour.",
        );
      }
      sharedDriver = null;
      tourRunning = false;
      inst.destroy();
    },
  });
  sharedDriver = d;
  d.drive(0);
}

export type FirstReviewTourProps = {
  /** Increment to force-replay (Account → Replay), even if already completed. */
  forceToken?: number;
};

function isAuthShellPath(pathname: string): boolean {
  return (
    pathname.startsWith("/onboarding") ||
    pathname === "/login" ||
    pathname === "/" ||
    pathname.startsWith("/auth/")
  );
}

/**
 * Host component: wires navigate + toast + prefs. Auto-starts once when the
 * user has not completed/skipped (server or localStorage).
 */
export function FirstReviewTour({ forceToken = 0 }: FirstReviewTourProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const lastForceRef = useRef(0);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    navigateFn = navigate;
    toastFn = (message: string) => toast.info(message);
    return () => {
      if (navigateFn === navigate) navigateFn = null;
      toastFn = null;
    };
  }, [navigate, toast]);

  const startTour = useCallback(() => {
    createAndStartTour(userIdRef.current);
  }, []);

  // Auto-start once per page load (module flag + localStorage survive hard refresh)
  useEffect(() => {
    if (autoStartResolved || tourRunning) return;
    if (isAuthShellPath(location.pathname)) return;

    let cancelled = false;
    let timer: number | undefined;

    (async () => {
      try {
        const me = await api.authMe();
        if (cancelled || autoStartResolved) return;
        if (me.needsOrg) return;
        if (!me.user || me.user.id === "api_key" || me.user.id === "dev") {
          autoStartResolved = true;
          return;
        }
        userIdRef.current = me.user.id;
        activeUserId = me.user.id;

        const status = resolveTourStatus(me.user);
        if (status === "completed" || status === "skipped") {
          // Re-sync local → server if only local had it (API may have failed earlier)
          if (!readServerTourStatus(me.user) && readLocalTourStatus(me.user.id)) {
            void persistTourStatus(status, me.user.id).catch(() => undefined);
          }
          autoStartResolved = true;
          return;
        }
        autoStartResolved = true;
        timer = window.setTimeout(() => {
          if (!cancelled && !tourRunning) startTour();
        }, 700);
      } catch {
        /* ignore — retry on later eligible navigation if still unresolved */
      }
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [location.pathname, startTour]);

  // Account settings: replay tour
  useEffect(() => {
    if (forceToken <= 0 || forceToken === lastForceRef.current) return;
    lastForceRef.current = forceToken;
    // Allow replay even after completed/skipped — do not clear local status so
    // a mid-replay refresh still won't auto-start unless they never finish again.
    // Starting explicitly is fine regardless of stored status.
    window.setTimeout(() => startTour(), 250);
  }, [forceToken, startTour]);

  // On full page unload while tour is open, mark skipped + local so refresh
  // does not force the tour again mid-flow.
  useEffect(() => {
    const onPageHide = () => {
      if (tourRunning && sharedDriver?.isActive()) {
        writeLocalTourStatus(activeUserId, "skipped");
        // Best-effort beacon; may not complete on hard kill
        void persistTourStatus("skipped", activeUserId).catch(() => undefined);
      }
      tearDownDriverSilently();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}
