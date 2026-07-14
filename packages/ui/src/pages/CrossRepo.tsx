import { useEffect, useMemo, useState } from "react";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, PageHero } from "../components/ui";
import { Select } from "../components/Select";
import { api, type RepoLink, type ScmRepo } from "../lib/api";

function TopologyGraph({ links }: { links: RepoLink[] }) {
  const nodes = useMemo(() => {
    const set = new Set<string>();
    for (const l of links) {
      set.add(l.fromRepoId);
      set.add(l.toRepoId);
    }
    return [...set];
  }, [links]);

  const positions = useMemo(() => {
    const w = 640;
    const h = 260;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.34;
    return nodes.map((id, i) => {
      const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return {
        id,
        x: nodes.length === 1 ? cx : cx + r * Math.cos(angle),
        y: nodes.length === 1 ? cy : cy + r * Math.sin(angle),
      };
    });
  }, [nodes]);

  const pos = Object.fromEntries(positions.map((p) => [p.id, p]));

  if (!links.length) {
    return (
      <div className="topo-svg" style={{ display: "grid", placeItems: "center" }}>
        <span className="muted">Add links to visualize topology</span>
      </div>
    );
  }

  return (
    <svg className="topo-svg" viewBox="0 0 640 280" role="img" aria-label="Cross-repo topology">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="rgba(34,211,238,0.55)" />
        </marker>
      </defs>
      {links.map((l) => {
        const a = pos[l.fromRepoId];
        const b = pos[l.toRepoId];
        if (!a || !b) return null;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2 - 18;
        return (
          <path
            key={l.id}
            className="edge"
            d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
            markerEnd="url(#arrow)"
            opacity={l.enabled ? 1 : 0.35}
          />
        );
      })}
      {positions.map((p) => (
        <g key={p.id}>
          <circle className="node-circle" cx={p.x} cy={p.y} r={22} />
          <text className="node-label" x={p.x} y={p.y + 40}>
            {p.id.length > 18 ? `${p.id.slice(0, 16)}…` : p.id}
          </text>
        </g>
      ))}
    </svg>
  );
}

function RepoSelect({
  label,
  value,
  onChange,
  repos,
  filter,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  repos: ScmRepo[];
  filter: string;
}) {
  const options = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? repos.filter(
          (r) =>
            r.fullName.toLowerCase().includes(q) ||
            r.provider.toLowerCase().includes(q),
        )
      : repos;
    return list.slice(0, 200);
  }, [repos, filter]);

  return (
    <div className="field" style={{ margin: 0 }}>
      <label>{label}</label>
      <input
        list={`${label}-repos`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search or type org/repo"
      />
      <datalist id={`${label}-repos`}>
        {options.map((r) => (
          <option key={`${r.provider}:${r.fullName}`} value={r.fullName}>
            {r.provider} · {r.fullName}
          </option>
        ))}
      </datalist>
      {repos.length === 0 && (
        <div className="muted" style={{ fontSize: "0.75rem", marginTop: 4 }}>
          No SCM repos loaded — free text works as fallback
        </div>
      )}
    </div>
  );
}

export function CrossRepo() {
  const toast = useToast();
  const [links, setLinks] = useState<RepoLink[]>([]);
  const [repos, setRepos] = useState<ScmRepo[]>([]);
  const [repoErrors, setRepoErrors] = useState<string>("");
  const [fromRepoId, setFrom] = useState("");
  const [toRepoId, setTo] = useState("");
  const [edgeType, setEdge] = useState("depends_on_api");
  const [preview, setPreview] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const refresh = () =>
    api
      .links()
      .then((r) => setLinks(r.links))
      .catch(() => setLinks([]))
      .finally(() => setLoading(false));

  useEffect(() => {
    void refresh();
    api
      .listRepos()
      .then((r) => {
        setRepos(r.repos);
        const actionable = (r.errors ?? []).filter(
          (e) =>
            e.error &&
            !/No SCM connector configured/i.test(e.error) &&
            e.error !== "missing_token" &&
            e.error !== "not_configured",
        );
        if (actionable.length) {
          setRepoErrors(actionable.map((e) => `${e.provider}: ${e.error}`).join(" · "));
        } else {
          setRepoErrors("");
        }
      })
      .catch((e) => {
        setRepos([]);
        setRepoErrors(e instanceof Error ? e.message : String(e));
      });
  }, []);

  async function add() {
    if (!fromRepoId.trim() || !toRepoId.trim()) {
      toast.error("From and To repos required");
      return;
    }
    try {
      const fromRepo = repos.find((r) => r.fullName === fromRepoId);
      const toRepo = repos.find((r) => r.fullName === toRepoId);
      await api.putLink({
        fromRepoId: fromRepoId.trim(),
        toRepoId: toRepoId.trim(),
        edgeType,
        enabled: true,
        pathFilters: { from: ["src/**", "packages/**"], to: ["**"] },
        maxDepth: 2,
        fromRepoPath: fromRepo?.url,
        toRepoPath: toRepo?.url,
      });
      toast.success(`Link ${fromRepoId} → ${toRepoId}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteLink(id);
      toast.info("Link removed");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function runPreview() {
    if (!fromRepoId.trim()) {
      toast.error("Select a From repo for fan-out preview");
      return;
    }
    try {
      const data = await api.previewLinks({
        repoId: fromRepoId.trim(),
        paths: ["."],
      });
      setPreview(JSON.stringify(data, null, 2));
      toast.success("Fan-out preview ready");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <PageHero
        kicker="Multi-repo"
        title="Cross-Repo topology"
        subtitle="Org-level links expand gate and stewardship fan-out under token and depth budgets."
      />

      <div className="grid cols-2" style={{ marginBottom: "1rem" }}>
        <div className="card stack">
          <h3>Add link</h3>
          <div className="field">
            <label>Filter repos</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter dropdown options…"
            />
          </div>
          {repoErrors && (
            <div className="banner warn" style={{ margin: 0 }}>
              <span style={{ fontSize: "0.8rem" }}>{repoErrors}</span>
            </div>
          )}
          <div className="grid cols-2">
            <RepoSelect
              label="From repo"
              value={fromRepoId}
              onChange={setFrom}
              repos={repos}
              filter={query}
            />
            <RepoSelect
              label="To repo"
              value={toRepoId}
              onChange={setTo}
              repos={repos}
              filter={query}
            />
          </div>
          <div className="field">
            <label>Edge type</label>
            <select value={edgeType} onChange={(e) => setEdge(e.target.value)}>
              <option value="depends_on_api">depends_on_api</option>
              <option value="publishes_package">publishes_package</option>
              <option value="shares_proto">shares_proto</option>
              <option value="deploys_with">deploys_with</option>
              <option value="imports">imports</option>
              <option value="custom">custom</option>
            </select>
          </div>
          <div className="row">
            <button type="button" className="primary" onClick={() => void add()}>
              Add link
            </button>
            <button type="button" onClick={() => void runPreview()}>
              Preview fan-out
            </button>
            <Badge tone="nit">{repos.length} repos</Badge>
          </div>
          {preview && (
            <pre className="mono" style={{ fontSize: 11, maxHeight: 180, overflow: "auto", margin: 0 }}>
              {preview}
            </pre>
          )}
        </div>
        <div className="card">
          <div className="card-header">
            <h3>Visual graph</h3>
            <Badge tone="running">{links.length} edges</Badge>
          </div>
          <TopologyGraph links={links} />
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Link table</h3>
        {loading ? (
          <div className="skeleton block" style={{ height: 120 }} />
        ) : links.length === 0 ? (
          <EmptyState
            title="No links configured"
            description="Connect related repositories for multi-repo blast radius."
            icon="⬡"
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Edge</th>
                  <th>Depth</th>
                  <th>Enabled</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{l.fromRepoId}</td>
                    <td className="mono">{l.toRepoId}</td>
                    <td>{l.edgeType}</td>
                    <td className="muted">{l.maxDepth ?? "—"}</td>
                    <td>
                      <Badge tone={l.enabled ? "ok" : "nit"}>{l.enabled ? "yes" : "no"}</Badge>
                    </td>
                    <td>
                      <button type="button" className="sm danger" onClick={() => void remove(l.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
