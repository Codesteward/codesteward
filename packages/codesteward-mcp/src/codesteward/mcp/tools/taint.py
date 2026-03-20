"""MCP tool implementation for taint-flow analysis via the codesteward-taint binary."""


import asyncio

import structlog
import yaml
from codesteward.mcp.config import McpConfig

log = structlog.get_logger()


async def tool_taint_analysis(
    tenant_id: str,
    repo_id: str,
    repo_path: str,
    frameworks: list[str] | None,
    max_hops: int,
    persist_cfg: bool,
    cfg: McpConfig,
    binary: str,
) -> str:
    """Invoke the codesteward-taint binary and return its YAML output.

    Args:
        tenant_id: Tenant namespace for Neo4j isolation.
        repo_id: Repository identifier.
        repo_path: Absolute path to the repository on disk.
        frameworks: Catalog names to activate (e.g. ``["fastapi", "express"]``).
            Pass ``None`` to auto-detect from languages present in the graph.
        max_hops: Maximum CALLS depth for Level 1 graph traversal.
        persist_cfg: When true, write BasicBlock nodes and CFG_EDGE relationships
            to Neo4j to enable path-level Cypher queries.
        cfg: Server configuration (provides Neo4j credentials).
        binary: Absolute path to the codesteward-taint binary.

    Returns:
        YAML string with paths_unsafe, paths_sanitized, findings list, and
        duration_ms. TAINT_FLOW edges are written to Neo4j by the binary so
        subsequent ``codebase_graph_query`` semantic queries return results.
    """
    if not cfg.neo4j_available:
        return yaml.safe_dump({
            "error": "taint_analysis requires Neo4j — set NEO4J_PASSWORD to enable it",
            "neo4j_connected": False,
        })

    args = [
        binary,
        "--neo4j-uri",      cfg.neo4j_uri,
        "--neo4j-user",     cfg.neo4j_user,
        "--neo4j-password", cfg.neo4j_password,
        "--tenant-id",      tenant_id,
        "--repo-id",        repo_id,
        "--repo-path",      repo_path,
        "--max-hops",       str(max_hops),
        "--output",         "yaml",
    ]
    if frameworks:
        args += ["--frameworks", ",".join(frameworks)]
    if persist_cfg:
        args.append("--persist-cfg")

    log.info("taint_analysis_start", binary=binary, tenant_id=tenant_id, repo_id=repo_id)

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
    except TimeoutError:
        return yaml.safe_dump({"error": "taint analysis timed out after 300s"})
    except Exception as exc:
        log.error("taint_analysis_failed", error=str(exc))
        return yaml.safe_dump({"error": str(exc)})

    if proc.returncode != 0:
        log.error("taint_binary_error", returncode=proc.returncode, stderr=stderr.decode())
        return yaml.safe_dump({
            "error": f"codesteward-taint exited with code {proc.returncode}",
            "detail": stderr.decode()[:500],
        })

    log.info("taint_analysis_done", tenant_id=tenant_id, repo_id=repo_id)
    return stdout.decode()
