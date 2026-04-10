"""Codebase graph construction engine.

Parses repositories and builds the multi-layered Neo4j graph used by agents
for compliance enforcement, blast-radius analysis, and migration planning.

Four graph layers (per the architecture SKILL.md):
  Lexical   — files, functions, classes, variables (what exists)
  Referential — imports, exports, calls, inheritance (how things connect)
  Dependency  — package.json / lock-file deps (external dependencies)
  Semantic    — simplified data-flow paths (where data travels)

TypeScript/JavaScript is fully supported. Python and Java are planned.

Neo4j integration:
  - When a Neo4j driver is injected, nodes and edges are written via Cypher MERGE.
  - Without a driver (tests, stubs) the builder returns the in-memory graph
    summary without any database writes.
"""


import json
from pathlib import Path
from typing import Any

import pathspec
import structlog
from codesteward.engine.parsers import (  # noqa: F401
    all_source_extensions,
    get_parser,
    lang_for_ext,
)

# ---------------------------------------------------------------------------
# Backward-compat re-exports: data models and parsers moved to engine/parsers/
# ---------------------------------------------------------------------------
from codesteward.engine.parsers.base import (  # noqa: F401
    GraphEdge,
    LexicalNode,
    ParseResult,
)
from codesteward.engine.parsers.java import JavaParser  # noqa: F401
from codesteward.engine.parsers.python import PythonParser  # noqa: F401
from codesteward.engine.parsers.typescript import TypeScriptParser  # noqa: F401

log = structlog.get_logger()

# ---------------------------------------------------------------------------
# Directories that are never parsed (build artifacts, vendored code, etc.)
# ---------------------------------------------------------------------------

_IGNORED_DIRS = frozenset(
    [
        # JS/TS build outputs and framework caches
        "node_modules", "dist", "build", "out", ".next", ".nuxt", ".output",
        ".svelte-kit", ".solid", ".turbo", ".parcel-cache", ".vitepress",
        ".docusaurus", "storybook-static",
        # Test/coverage artifacts
        "coverage", "htmlcov", ".nyc_output",
        # Python runtime and tool caches
        "__pycache__", ".venv", "venv", "site-packages",
        ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".eggs",
        ".hypothesis",
        # Version control
        ".git", ".hg", ".svn",
        # Compiled output (Rust, Java, .NET)
        "target", "bin", "obj",
        # Vendored dependencies
        "vendor",
        # Misc tool caches
        ".gradle", ".cache", "tmp", ".tmp",
    ]
)

_IGNORED_DIR_SUFFIXES = (".egg-info", ".dist-info")

# Name of the per-project ignore file that users place in their repo root
_CODESTEWARD_IGNORE_FILE = ".codestewardignore"


# ===========================================================================
# Backward-compatibility shim for MultiLanguageParser
# ===========================================================================


class MultiLanguageParser:
    """Backward-compat shim. Use get_parser() directly for new code.

    Delegates to the parsers registry for language dispatch.
    """

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> ParseResult:
        """Parse a source file via the language registry.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        return get_parser(language).parse(file_path, content, tenant_id, repo_id, language)


# ===========================================================================
# Package.json dependency parser
# ===========================================================================


class PackageJsonParser:
    """Extracts dependency edges from package.json and package-lock.json.

    Produces ``depends_on`` edges from the repo's root file node to each
    direct dependency package. Transitive dependencies (from lock file)
    produce additional edges between packages.
    """

    def parse(
        self,
        repo_path: Path,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract dependency edges.

        Args:
            repo_path: Root directory of the repository.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of depends_on GraphEdges.
        """
        edges: list[GraphEdge] = []
        pkg_file = repo_path / "package.json"

        if not pkg_file.exists():
            return edges

        try:
            pkg_data = json.loads(pkg_file.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("package_json_parse_failed", path=str(pkg_file), error=str(exc))
            return edges

        root_id = LexicalNode.make_id(tenant_id, repo_id, "package.json", "package.json", "file")

        # Direct dependencies (both prod and dev)
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            for pkg_name, version in pkg_data.get(section, {}).items():
                edge = GraphEdge(
                    edge_id=GraphEdge.make_id(root_id, "depends_on", pkg_name),
                    edge_type="depends_on",
                    source_id=root_id,
                    target_id=pkg_name,
                    target_name=f"{pkg_name}@{version}",
                    file="package.json",
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                edges.append(edge)

        # Transitive dependencies from package-lock.json
        lock_file = repo_path / "package-lock.json"
        if lock_file.exists():
            edges.extend(self._parse_lock_file(lock_file, root_id, tenant_id, repo_id))

        return edges

    def _parse_lock_file(
        self,
        lock_file: Path,
        root_id: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract transitive dependency edges from package-lock.json (v2/v3 format).

        Args:
            lock_file: Path to package-lock.json.
            root_id: ID of the root package.json node.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of depends_on GraphEdges for transitive packages.
        """
        try:
            lock_data = json.loads(lock_file.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("lock_file_parse_failed", path=str(lock_file), error=str(exc))
            return []

        edges: list[GraphEdge] = []
        # lockfileVersion 2/3: packages section
        packages = lock_data.get("packages", {})
        for pkg_path, pkg_info in packages.items():
            if not pkg_path or pkg_path == "":
                continue  # skip the root entry
            # pkg_path is e.g. "node_modules/lodash"
            pkg_name = pkg_path.replace("node_modules/", "").lstrip("/")
            version = pkg_info.get("version", "unknown")
            edge = GraphEdge(
                edge_id=GraphEdge.make_id(root_id, "depends_on_transitive", pkg_name),
                edge_type="depends_on",
                source_id=root_id,
                target_id=pkg_name,
                target_name=f"{pkg_name}@{version}",
                file="package-lock.json",
                tenant_id=tenant_id,
                repo_id=repo_id,
            )
            edges.append(edge)

        return edges


# ===========================================================================
# Neo4j writer (gracefully degrades when no driver is provided)
# ===========================================================================


class Neo4jWriter:
    """Writes graph nodes and edges to Neo4j via Cypher MERGE operations.

    When ``driver`` is None (tests, local dev without Neo4j), all write
    operations are no-ops and a warning is logged.

    Cypher patterns used:
      - Nodes: ``MERGE (n:LexicalNode {node_id: $id}) SET n += $props``
      - Edges: ``MERGE (a)-[r:IMPORTS]->(b)`` style relationships via MATCH + MERGE
    """

    def __init__(self, driver: Any | None = None) -> None:
        """Initialise the writer.

        Args:
            driver: A ``neo4j.AsyncDriver`` instance, or None for stub mode.
        """
        self._driver = driver
        if driver is None:
            log.warning("neo4j_writer_stub_mode", reason="No Neo4j driver provided")

    def is_connected(self) -> bool:
        """Return True if a Neo4j driver is configured."""
        return self._driver is not None

    async def write_nodes(self, nodes: list[LexicalNode]) -> int:
        """Upsert lexical nodes into Neo4j.

        Args:
            nodes: Nodes to write.

        Returns:
            Number of nodes written (0 in stub mode).
        """
        if not self._driver or not nodes:
            return 0

        cypher = """
        UNWIND $nodes AS n
        MERGE (node:LexicalNode {node_id: n.node_id})
        SET node += n
        """
        props = [
            {
                "node_id": node.node_id,
                "node_type": node.node_type,
                "name": node.name,
                "file": node.file,
                "line_start": node.line_start,
                "line_end": node.line_end,
                "language": node.language,
                "tenant_id": node.tenant_id,
                "repo_id": node.repo_id,
                "exported": node.exported,
                "is_async": node.is_async,
                "metadata": json.dumps(node.metadata) if node.metadata else "{}",
            }
            for node in nodes
        ]
        async with self._driver.session() as session:
            await session.run(cypher, nodes=props)
        return len(nodes)

    async def write_edges(self, edges: list[GraphEdge]) -> int:
        """Upsert graph edges into Neo4j as typed relationships.

        Args:
            edges: Edges to write.

        Returns:
            Number of edges written (0 in stub mode).
        """
        if not self._driver or not edges:
            return 0

        # Group by edge_type so we can use dynamic relationship types
        by_type: dict[str, list[GraphEdge]] = {}
        for edge in edges:
            by_type.setdefault(edge.edge_type.upper(), []).append(edge)

        total = 0
        async with self._driver.session() as session:
            for rel_type, typed_edges in by_type.items():
                cypher = f"""
                UNWIND $edges AS e
                MATCH (src:LexicalNode {{node_id: e.source_id}})
                MERGE (tgt:LexicalNode {{node_id: e.target_id}})
                  ON CREATE SET tgt.name = e.target_name, tgt.node_type = 'external',
                                tgt.tenant_id = e.tenant_id, tgt.repo_id = e.repo_id
                MERGE (src)-[r:{rel_type} {{edge_id: e.edge_id}}]->(tgt)
                SET r.file = e.file, r.line = e.line
                """
                props = [
                    {
                        "source_id": edge.source_id,
                        "target_id": edge.target_id,
                        "target_name": edge.target_name,
                        "tenant_id": edge.tenant_id,
                        "repo_id": edge.repo_id,
                        "edge_id": edge.edge_id,
                        "file": edge.file,
                        "line": edge.line,
                    }
                    for edge in typed_edges
                ]
                await session.run(cypher, edges=props)
                total += len(typed_edges)

        return total

    async def delete_file_nodes(self, tenant_id: str, repo_id: str, file_path: str) -> None:
        """Delete all nodes and edges scoped to a specific file (for incremental updates).

        Args:
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            file_path: Repo-relative path of the file to remove from the graph.
        """
        if not self._driver:
            return
        cypher = """
        MATCH (n:LexicalNode {tenant_id: $tenant_id, repo_id: $repo_id, file: $file})
        DETACH DELETE n
        """
        async with self._driver.session() as session:
            await session.run(cypher, tenant_id=tenant_id, repo_id=repo_id, file=file_path)


# ===========================================================================
# GraphBuilder — public interface
# ===========================================================================


class GraphBuilder:
    """Orchestrates codebase graph construction for a repository.

    Usage::

        builder = GraphBuilder(neo4j_driver=driver)  # driver=None for stub mode

        summary = await builder.build_graph(
            repo_path="/tmp/acme-payments",
            tenant_id="acme",
            repo_id="payments",
            language="typescript",
        )

        # Incremental update after a PR:
        summary = await builder.build_graph(
            repo_path="/tmp/acme-payments",
            tenant_id="acme",
            repo_id="payments",
            language="typescript",
            incremental_files=["src/auth/login.ts", "src/auth/types.ts"],
        )
    """

    def __init__(self, neo4j_driver: Any | None = None) -> None:
        """Initialise with optional Neo4j driver.

        The graph builder uses the parsers registry (``get_parser()``) to
        dispatch to the tree-sitter AST parser for each language.  COBOL is
        the only exception — it uses a regex-based parser because no
        tree-sitter grammar is available for it.

        Args:
            neo4j_driver: A ``neo4j.AsyncDriver`` instance. If None, the
                builder parses the codebase but skips all database writes.
        """
        self._pkg_parser = PackageJsonParser()
        self._writer = Neo4jWriter(neo4j_driver)

    def _parse_source(self, file_path: str, content: str, language: str) -> ParseResult:
        """Parse a source file using the language registry.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            language: Source language string.

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        # NOTE: tenant_id and repo_id are not stored on GraphBuilder; they are
        # passed in per build_graph() call. This method is called from
        # build_graph() where tenant_id/repo_id are available via closure — see
        # build_graph() implementation which calls self._parse_source_with_context()
        # instead of this method directly.
        raise NotImplementedError(
            "Use _parse_source_with_context(file_path, content, tenant_id, repo_id, language)"
        )

    def _parse_source_with_context(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> ParseResult:
        """Parse a source file using the language registry with tenant context.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string.

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        parser = get_parser(language)
        return parser.parse(file_path, content, tenant_id, repo_id, language)

    async def build_graph(
        self,
        repo_path: str,
        tenant_id: str,
        repo_id: str,
        language: str = "typescript",
        incremental_files: list[str] | None = None,
    ) -> dict[str, Any]:
        """Build or incrementally update the codebase graph.

        Full build: Walks the repo, parses every source file, writes all
        nodes and edges to Neo4j.

        Incremental build: Deletes existing nodes for the changed files from
        Neo4j, re-parses only those files, and writes the updated nodes/edges.

        Args:
            repo_path: Absolute path to the locally cloned repository.
            tenant_id: Tenant namespace for Neo4j graph isolation.
            repo_id: Repository identifier.
            language: Primary language to parse ("typescript" or "javascript").
                Both TypeScript (.ts/.tsx) and JavaScript (.js/.jsx) files are
                always parsed — this parameter controls the default language
                label for files with ambiguous extensions.
            incremental_files: Repo-relative paths of files to update.
                If None, a full build is performed.

        Returns:
            Summary dict with node/edge counts and parsing statistics.
        """
        root = Path(repo_path)
        is_incremental = incremental_files is not None

        log.info(
            "graph_builder_started",
            repo_path=repo_path,
            tenant_id=tenant_id,
            repo_id=repo_id,
            language=language,
            incremental=is_incremental,
            incremental_files=len(incremental_files) if incremental_files else None,
        )

        # Determine which files to process
        if is_incremental:
            files_to_parse = [root / f for f in (incremental_files or [])]
            files_to_parse = [f for f in files_to_parse if f.exists()]
        else:
            files_to_parse = self._collect_files(root, language)

        all_nodes: list[LexicalNode] = []
        all_edges: list[GraphEdge] = []
        parse_errors: list[str] = []
        files_parsed = 0

        for file_path in files_to_parse:
            try:
                content = file_path.read_text(encoding="utf-8", errors="replace")
                rel_path = str(file_path.relative_to(root))
                file_lang = self._detect_language(file_path)

                # For incremental: remove old nodes for this file first
                if is_incremental:
                    await self._writer.delete_file_nodes(tenant_id, repo_id, rel_path)

                parse_result = self._parse_source_with_context(
                    file_path=rel_path,
                    content=content,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                    language=file_lang,
                )
                all_nodes.extend(parse_result.all_nodes)
                all_edges.extend(parse_result.edges)
                files_parsed += 1

            except Exception as exc:
                log.error(
                    "graph_builder_file_error",
                    file=str(file_path),
                    error=str(exc),
                )
                parse_errors.append(str(file_path))

        # Dependency edges from package.json
        if not is_incremental:
            dep_edges = self._pkg_parser.parse(root, tenant_id, repo_id)
            all_edges.extend(dep_edges)
        else:
            dep_edges = []

        # Write to Neo4j (no-op if driver is None)
        nodes_written = await self._writer.write_nodes(all_nodes)
        edges_written = await self._writer.write_edges(all_edges)

        # Tally by type
        node_counts = _count_by(all_nodes, "node_type")
        edge_counts = _count_by(all_edges, "edge_type")

        summary = {
            "status": "ok" if not parse_errors else "partial",
            "incremental": is_incremental,
            "tenant_id": tenant_id,
            "repo_id": repo_id,
            "language": language,
            "files_parsed": files_parsed,
            "parse_errors": parse_errors,
            "neo4j_connected": self._writer.is_connected(),
            "nodes": {
                "total": len(all_nodes),
                "written_to_neo4j": nodes_written,
                **node_counts,
            },
            "edges": {
                "total": len(all_edges),
                "written_to_neo4j": edges_written,
                **edge_counts,
            },
        }

        log.info(
            "graph_builder_complete",
            files_parsed=files_parsed,
            nodes_total=len(all_nodes),
            edges_total=len(all_edges),
            neo4j_writes=nodes_written + edges_written,
            errors=len(parse_errors),
        )

        return summary

    def parse_file(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "typescript",
    ) -> ParseResult:
        """Parse a single file without writing to Neo4j.

        Useful for testing and for the policy engine's codebase_graph_query tool.

        Args:
            file_path: Repo-relative path (used as node identifier).
            content: File content.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language.

        Returns:
            ParseResult with nodes and edges.
        """
        return self._parse_source_with_context(
            file_path=file_path,
            content=content,
            tenant_id=tenant_id,
            repo_id=repo_id,
            language=language,
        )

    # -- Private helpers -----------------------------------------------------

    def _load_ignore_spec(self, root: Path) -> pathspec.PathSpec:
        """Load ignore patterns from .codestewardignore in the project root.

        Reads the .codestewardignore file (if present) from the root of the
        repository being analyzed and returns a compiled PathSpec using
        gitignore-style pattern matching.

        Args:
            root: Root directory of the repository being analyzed.

        Returns:
            A PathSpec that matches repo-relative paths to be excluded.
            Returns an empty (no-op) PathSpec if the file does not exist.
        """
        ignore_file = root / _CODESTEWARD_IGNORE_FILE
        if not ignore_file.is_file():
            return pathspec.PathSpec.from_lines("gitignore", [])
        try:
            lines = ignore_file.read_text(encoding="utf-8").splitlines()
            log.debug("codestewardignore_loaded", path=str(ignore_file), patterns=len(lines))
            return pathspec.PathSpec.from_lines("gitignore", lines)
        except OSError as exc:
            log.warning("codestewardignore_read_failed", path=str(ignore_file), error=str(exc))
            return pathspec.PathSpec.from_lines("gitignore", [])

    def _collect_files(self, root: Path, language: str) -> list[Path]:
        """Walk the repository and collect all parseable source files.

        Args:
            root: Repository root directory.
            language: Primary language (determines which extensions to include).

        Returns:
            Sorted list of Path objects for parseable files.
        """
        all_exts = all_source_extensions()
        ignore_spec = self._load_ignore_spec(root)
        files: list[Path] = []
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            # Skip hardcoded ignored directories
            if any(
                part in _IGNORED_DIRS or part.endswith(_IGNORED_DIR_SUFFIXES)
                for part in path.parts
            ):
                continue
            # Skip files matched by .codestewardignore
            rel = path.relative_to(root)
            if ignore_spec.match_file(str(rel)):
                continue
            if path.suffix in all_exts:
                files.append(path)
        return sorted(files)

    def _detect_language(self, file_path: Path) -> str:
        """Map file extension to language string.

        Args:
            file_path: Path to the source file.

        Returns:
            Language string: "typescript", "tsx", "javascript", "python", or "java".
        """
        detected = lang_for_ext(file_path.suffix)
        return detected if detected is not None else "javascript"


# ===========================================================================
# Module-level convenience function (backward-compatible with stub signature)
# ===========================================================================


async def build_graph(
    repo_path: str,
    tenant_id: str,
    repo_id: str,
    language: str = "typescript",
    incremental_files: list[str] | None = None,
    neo4j_driver: Any | None = None,
) -> dict[str, Any]:
    """Build or update the codebase graph for a repository.

    Module-level convenience wrapper around :class:`GraphBuilder`.

    Args:
        repo_path: Local path to the cloned repository.
        tenant_id: Tenant namespace for graph isolation in Neo4j.
        repo_id: Repository identifier for graph namespacing.
        language: Primary language to parse ("typescript", "javascript").
        incremental_files: If provided, only update nodes/edges for these files.
        neo4j_driver: Optional Neo4j async driver. Writes are skipped if None.

    Returns:
        Summary dict with node and edge counts.
    """
    builder = GraphBuilder(neo4j_driver=neo4j_driver)
    return await builder.build_graph(
        repo_path=repo_path,
        tenant_id=tenant_id,
        repo_id=repo_id,
        language=language,
        incremental_files=incremental_files,
    )


# ===========================================================================
# Helpers
# ===========================================================================


def _count_by(items: list[Any], attr: str) -> dict[str, int]:
    """Count items by the value of a given attribute.

    Args:
        items: List of objects.
        attr: Attribute name to group by.

    Returns:
        Dict of attribute_value → count.
    """
    counts: dict[str, int] = {}
    for item in items:
        key = getattr(item, attr, "unknown")
        counts[key] = counts.get(key, 0) + 1
    return counts
