import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ScmRepo } from "../lib/api";

export interface RepoPick {
  repoId: string;
  fullName: string;
  provider: string;
  owner: string;
  name: string;
  defaultBranch?: string;
}

/**
 * Repository picker: searchable select when SCM is connected; optional manual fallback.
 * Avoids the old dual-input “hectic” mode (filter + free-text fighting each other).
 */
export function RepoPicker({
  value,
  onChange,
  allowManual = true,
  provider,
}: {
  value: string;
  onChange: (pick: RepoPick | { repoId: string }) => void;
  allowManual?: boolean;
  /** Optional SCM provider filter (e.g. github) */
  provider?: string;
}) {
  const [repos, setRepos] = useState<ScmRepo[]>([]);
  const [errors, setErrors] = useState<Array<{ provider: string; error: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"pick" | "manual">("pick");
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listRepos(provider ? { provider } : undefined)
      .then((r) => {
        if (cancelled) return;
        const list = r.repos ?? [];
        setRepos(list);
        setErrors(r.errors ?? []);
        // Stay in pick mode if we got any repos; otherwise offer manual
        if (list.length === 0) setMode(allowManual ? "manual" : "pick");
        else setMode("pick");
      })
      .catch((e) => {
        if (cancelled) return;
        setRepos([]);
        setErrors([{ provider: provider ?? "scm", error: e instanceof Error ? e.message : String(e) }]);
        if (allowManual) setMode("manual");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, allowManual]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(needle) ||
        (r.provider ?? "").toLowerCase().includes(needle),
    );
  }, [repos, q]);

  function selectFullName(full: string) {
    const r = repos.find((x) => x.fullName === full || `${x.provider}:${x.fullName}` === full);
    if (r) {
      const parts = r.fullName.split("/");
      const owner = parts[0] ?? "";
      const name = parts.slice(1).join("/") || r.fullName;
      onChange({
        repoId: r.fullName,
        fullName: r.fullName,
        provider: r.provider ?? "github",
        owner,
        name,
        defaultBranch: r.defaultBranch,
      });
    } else if (full) {
      onChange({ repoId: full });
    }
  }

  if (loading) {
    return (
      <div className="stack" style={{ gap: 6 }}>
        <div className="skeleton" style={{ height: 38, borderRadius: 8 }} />
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          Loading repositories…
        </span>
      </div>
    );
  }

  // Only show real failures — ignore "not configured" noise from multi-provider probes
  const actionableErrors = errors.filter(
    (e) =>
      e.error &&
      !/No SCM connector configured/i.test(e.error) &&
      e.error !== "missing_token" &&
      e.error !== "not_configured",
  );
  const scmHint =
    actionableErrors.length > 0
      ? actionableErrors.map((e) => `${e.provider}: ${e.error}`).join(" · ")
      : null;

  if (mode === "manual") {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <input
          value={value}
          onChange={(e) => onChange({ repoId: e.target.value.trim() })}
          placeholder="owner/repo"
          aria-label="Repository ID"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {repos.length > 0 && (
            <button type="button" className="ghost sm" onClick={() => setMode("pick")}>
              Choose from {repos.length} connected repo{repos.length === 1 ? "" : "s"}
            </button>
          )}
          <Link to="/connectors" className="muted" style={{ fontSize: "0.8rem" }}>
            Configure SCM →
          </Link>
        </div>
        {scmHint && (
          <span className="muted" style={{ fontSize: "0.75rem", lineHeight: 1.4 }}>
            {scmHint}
          </span>
        )}
        {repos.length === 0 && !scmHint && (
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            No repos from SCM yet. Connect a GitHub App or PAT under Connectors.
          </span>
        )}
      </div>
    );
  }

  // Combined pick mode: one search field + one select (not two competing text fields)
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Filter ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}…`}
          aria-label="Filter repositories"
          style={{ flex: "1 1 140px", minWidth: 120 }}
          autoComplete="off"
        />
        <select
          value={value}
          onChange={(e) => selectFullName(e.target.value)}
          aria-label="Repository"
          style={{ flex: "2 1 200px", minWidth: 160 }}
        >
          <option value="">Select repository…</option>
          {filtered.map((r) => (
            <option key={`${r.provider}:${r.fullName}`} value={r.fullName}>
              {r.fullName}
              {r.provider ? ` · ${r.provider}` : ""}
            </option>
          ))}
        </select>
      </div>
      {filtered.length === 0 && q && (
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          No match for “{q}”. Clear the filter or enter a repo manually.
        </span>
      )}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {allowManual && (
          <button type="button" className="ghost sm" onClick={() => setMode("manual")}>
            Type owner/repo manually
          </button>
        )}
        <button
          type="button"
          className="ghost sm"
          onClick={() => {
            setLoading(true);
            api
              .listRepos(provider ? { provider } : undefined)
              .then((r) => {
                setRepos(r.repos ?? []);
                setErrors(r.errors ?? []);
              })
              .finally(() => setLoading(false));
          }}
        >
          Refresh list
        </button>
      </div>
      {scmHint && (
        <span className="muted" style={{ fontSize: "0.75rem", lineHeight: 1.4 }}>
          {scmHint}
        </span>
      )}
    </div>
  );
}
