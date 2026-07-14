import { useEffect, useState } from "react";
import { useToast } from "../components/Toast";
import { Badge, PageHero } from "../components/ui";
import { api } from "../lib/api";

const DEFAULT_STEWARD = `# STEWARD.md

## Severity
- floor: low
- max findings: 50

## Noise
- nit cap: 5

## Skip
- **/dist/**
- **/node_modules/**
- **/*.generated.*

## Verification
- bar: full
- prove on: high

## Focus
- security
- correctness
- auth coverage

## Graph
- require: true

## Notes
Loaded from the **base branch only** so PR authors cannot relax gates.
Path-scoped rules live in \`.codesteward/rules/**/*.md\`.
`;

const STORAGE_KEY = "cs-steward-md";

export function Policy() {
  const toast = useToast();
  const [text, setText] = useState(DEFAULT_STEWARD);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [source, setSource] = useState<string>("local");
  const [orgId, setOrgIdLabel] = useState<string>("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.getPolicy();
        if (!alive) return;
        setOrgIdLabel(res.orgId);
        setSource(res.source);
        if (res.content?.trim()) {
          setText(res.content);
          try {
            localStorage.setItem(STORAGE_KEY, res.content);
          } catch {
            /* ignore */
          }
        } else {
          const local = localStorage.getItem(STORAGE_KEY);
          if (local) {
            setText(local);
            setSource("localStorage");
          } else {
            setText(DEFAULT_STEWARD);
            setSource(res.source === "empty" ? "defaults" : res.source);
          }
        }
      } catch {
        const local = localStorage.getItem(STORAGE_KEY);
        if (alive) {
          if (local) {
            setText(local);
            setSource("localStorage");
          }
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    try {
      try {
        localStorage.setItem(STORAGE_KEY, text);
      } catch {
        /* ignore */
      }
      const res = await api.putPolicy({ content: text });
      setSource("org_store");
      setOrgIdLabel(res.orgId);
      toast.success(`Policy saved to org store (${res.bytes} bytes)`);
      setDirty(false);
    } catch (err) {
      // Fallback local only if API fails
      try {
        localStorage.setItem(STORAGE_KEY, text);
        setSource("localStorage");
        toast.success("Policy saved locally (API unavailable)");
        setDirty(false);
      } catch {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHero
        kicker="Governance"
        title="Policy"
        subtitle="Org policy store + STEWARD.md on the base branch — PR authors cannot relax gates."
        actions={
          <button type="button" className="primary" disabled={saving || !dirty || loading} onClick={() => void save()}>
            {saving ? "Saving…" : dirty ? "Save policy" : "Saved"}
          </button>
        }
      />

      <div className="grid cols-2">
        <div className="card stack">
          <div className="card-header">
            <h3>STEWARD.md editor</h3>
            <div className="row" style={{ gap: 6 }}>
              {dirty && <span className="badge running">unsaved</span>}
              <Badge tone="configured">{source}</Badge>
              {orgId && (
                <span className="mono muted" style={{ fontSize: "0.72rem" }}>
                  {orgId}
                </span>
              )}
            </div>
          </div>
          {loading ? (
            <div className="skeleton block" style={{ height: 280 }} />
          ) : (
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(true);
              }}
              rows={22}
              spellCheck={false}
              aria-label="STEWARD.md content"
            />
          )}
          <div className="row">
            <button type="button" className="primary" disabled={saving || !dirty || loading} onClick={() => void save()}>
              Save to API
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setText(DEFAULT_STEWARD);
                setDirty(true);
              }}
            >
              Reset defaults
            </button>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h3>Effective defaults</h3>
            <table className="table">
              <tbody>
                <tr>
                  <td>Severity floor</td>
                  <td className="mono">low</td>
                </tr>
                <tr>
                  <td>Nit cap</td>
                  <td className="mono">5</td>
                </tr>
                <tr>
                  <td>Max findings</td>
                  <td className="mono">50</td>
                </tr>
                <tr>
                  <td>Verification bar</td>
                  <td className="mono">full</td>
                </tr>
                <tr>
                  <td>Prove on severity</td>
                  <td className="mono">high</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>Sources</h3>
            <ul className="muted" style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem", lineHeight: 1.7 }}>
              <li>
                <span className="mono">GET/PUT /v1/org/policy</span> — durable org store
              </li>
              <li>
                <span className="mono">STEWARD.md</span> — severity, noise, skip globs, verification
              </li>
              <li>
                <span className="mono">.codesteward/rules/**/*.md</span> — path-scoped guidance
              </li>
            </ul>
            <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
              CLI: <span className="mono">stew rules list</span> · MCP:{" "}
              <span className="mono">stew_effective_policy</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
