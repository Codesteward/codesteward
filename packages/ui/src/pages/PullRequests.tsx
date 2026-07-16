import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, PageHero, SkeletonLines, formatRelative } from "../components/ui";
import { api, type ScmPr, type ScmRepo } from "../lib/api";

export function PullRequests() {
  const toast = useToast();
  const [repos, setRepos] = useState<ScmRepo[]>([]);
  const [repoErrors, setRepoErrors] = useState<Array<{ provider: string; error: string }>>([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [selected, setSelected] = useState<ScmRepo | null>(null);
  const [prs, setPrs] = useState<ScmPr[]>([]);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [providerFilter, setProviderFilter] = useState("github");

  useEffect(() => {
    setLoadingRepos(true);
    api
      .listRepos({ provider: providerFilter })
      .then((r) => {
        setRepos(r.repos);
        setRepoErrors(
          (r.errors ?? []).filter(
            (e) =>
              e.error &&
              !/No SCM connector configured/i.test(e.error) &&
              e.error !== "missing_token" &&
              e.error !== "not_configured",
          ),
        );
        setSelected(null);
        setPrs([]);
      })
      .catch((e: Error) => {
        setRepos([]);
        setRepoErrors([{ provider: providerFilter, error: e.message }]);
        toast.error(e.message);
      })
      .finally(() => setLoadingRepos(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerFilter]);

  async function openRepo(repo: ScmRepo) {
    setSelected(repo);
    setLoadingPrs(true);
    setPrs([]);
    try {
      const [owner, name] = repo.fullName.split("/");
      if (!owner || !name) throw new Error(`Invalid fullName: ${repo.fullName}`);
      const res = await api.listPrs(repo.provider, owner, name);
      setPrs(res.prs);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setPrs([]);
    } finally {
      setLoadingPrs(false);
    }
  }

  function diffHref(repo: ScmRepo, pr: ScmPr): string {
    const [owner, name] = repo.fullName.split("/");
    const q = new URLSearchParams({
      provider: repo.provider,
      owner: owner ?? "",
      repo: name ?? "",
      number: String(pr.number),
    });
    return `/diff?${q.toString()}`;
  }

  function gateHref(repo: ScmRepo, pr: ScmPr): string {
    const q = new URLSearchParams({
      mode: "gate",
      repoId: repo.fullName.replace("/", "-"),
      pr: String(pr.number),
    });
    return `/sessions?${q.toString()}`;
  }

  return (
    <div>
      <PageHero
        kicker="Review"
        title="Pull requests"
        subtitle="Browse connected SCM repos and open PRs — jump to diff review or start a gate."
        actions={
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            style={{ width: "auto" }}
            aria-label="SCM provider"
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="bitbucket">Bitbucket</option>
            <option value="azure-devops">Azure DevOps</option>
            <option value="gitea">Gitea</option>
          </select>
        }
      />

      {repoErrors.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem", borderColor: "rgba(251,191,36,0.35)" }}>
          {repoErrors.map((e) => (
            <div key={e.provider} className="muted" style={{ fontSize: "0.85rem" }}>
              <Badge tone="warn">{e.provider}</Badge>{" "}
              <span style={{ marginLeft: 6 }}>{e.error}</span>
            </div>
          ))}
          <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
            Configure connectors or install the GitHub App under{" "}
            <Link to="/connectors">Connectors</Link>.
          </p>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-header">
            <h3>Repositories</h3>
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {repos.length} listed
            </span>
          </div>
          {loadingRepos ? (
            <SkeletonLines lines={6} />
          ) : repos.length === 0 ? (
            <EmptyState
              title="No repositories"
              description="Install the GitHub App or configure an SCM connector, then refresh."
              icon="⬡"
              action={
                <Link to="/connectors">
                  <button type="button" className="primary sm">
                    Open connectors
                  </button>
                </Link>
              }
            />
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {repos.map((r) => {
                const active = selected?.fullName === r.fullName && selected.provider === r.provider;
                return (
                  <button
                    key={`${r.provider}:${r.fullName}`}
                    type="button"
                    className={active ? "primary" : "ghost"}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      alignItems: "center",
                    }}
                    onClick={() => void openRepo(r)}
                  >
                    <span>
                      <span style={{ fontWeight: 600 }}>{r.fullName}</span>
                      <span className="muted mono" style={{ marginLeft: 8, fontSize: "0.72rem" }}>
                        {r.defaultBranch}
                      </span>
                    </span>
                    <Badge tone={r.private ? "warn" : "ok"}>{r.private ? "private" : "public"}</Badge>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Open PRs</h3>
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              {selected ? selected.fullName : "Select a repo"}
            </span>
          </div>
          {!selected ? (
            <EmptyState title="Pick a repository" description="PRs load after you select a repo on the left." icon="⇄" />
          ) : loadingPrs ? (
            <SkeletonLines lines={5} />
          ) : prs.length === 0 ? (
            <EmptyState title="No open PRs" description="This repository has no open pull requests." icon="◎" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Title</th>
                    <th>Branches</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {prs.map((pr) => (
                    <tr key={pr.number}>
                      <td className="mono">{pr.number}</td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{pr.title}</div>
                        <div className="muted" style={{ fontSize: "0.72rem" }}>
                          {pr.author ? `@${pr.author}` : pr.state}
                          {pr.url ? (
                            <>
                              {" · "}
                              <a href={pr.url} target="_blank" rel="noreferrer">
                                source
                              </a>
                            </>
                          ) : null}
                        </div>
                      </td>
                      <td className="mono muted" style={{ fontSize: "0.72rem" }}>
                        {pr.headBranch} → {pr.baseBranch}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                          <Link to={diffHref(selected, pr)}>
                            <button type="button" className="sm">
                              Diff
                            </button>
                          </Link>
                          <Link to={gateHref(selected, pr)}>
                            <button type="button" className="primary sm">
                              Gate
                            </button>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selected && prs.length > 0 && (
            <p className="muted" style={{ margin: "0.75rem 0 0", fontSize: "0.75rem" }}>
              Last refreshed {formatRelative(new Date().toISOString())}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
