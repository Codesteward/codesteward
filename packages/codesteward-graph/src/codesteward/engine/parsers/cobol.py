"""COBOL parser for the Codesteward codebase graph.

COBOL source is column-based and case-insensitive. This parser treats:
- PROGRAM-ID as the file-level identifier (becomes a "class" node as program unit)
- SECTIONs as function-like groupings
- PARAGRAPHs as function-like procedures
- COPY statements as import edges
- PERFORM statements as call edges
"""

import re

import structlog

from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()


class CobolParser(LanguageParser):
    """Regex-based COBOL parser supporting fixed and free-format source."""

    # PROGRAM-ID. ProgramName.
    _PROGRAM_ID_PATTERN = re.compile(
        r"^\s*PROGRAM-ID\s*\.\s*(?P<name>[\w-]+)", re.IGNORECASE
    )

    # section-name SECTION.
    _SECTION_PATTERN = re.compile(
        r"^\s*(?P<name>[\w-]+)\s+SECTION\s*\.", re.IGNORECASE
    )

    # paragraph-name. (line starts with identifier in area A, followed by period)
    # In fixed format, area A starts at column 8 (7 leading spaces).
    # Match 4-7 spaces OR a tab, then a COBOL identifier ending with a period.
    _PARA_PATTERN = re.compile(
        r"^(?:[ ]{4,7}|\t)(?P<name>[A-Z][A-Z0-9-]*)\.(?:\s|$)", re.IGNORECASE
    )

    # COPY copybook-name [OF/IN library]
    _COPY_PATTERN = re.compile(
        r"^\s*COPY\s+(?P<name>[\w-]+)", re.IGNORECASE
    )

    # PERFORM paragraph-name [THROUGH/THRU paragraph-name] [n TIMES] [UNTIL ...]
    _PERFORM_PATTERN = re.compile(
        r"^\s*PERFORM\s+(?P<name>[\w-]+)", re.IGNORECASE
    )

    # Division headers (not extracted as nodes, used for context)
    _DIVISION_PATTERN = re.compile(
        r"^\s*(?P<name>\w[\w\s-]*)\s+DIVISION\s*\.", re.IGNORECASE
    )

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "cobol",
    ) -> ParseResult:
        """Extract nodes and edges from a COBOL source file.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always "cobol".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        lines = content.splitlines()
        file_node = LexicalNode(
            node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, file_path, "file"),
            node_type="file",
            name=file_path,
            file=file_path,
            line_start=1,
            line_end=len(lines),
            language=language,
            tenant_id=tenant_id,
            repo_id=repo_id,
        )
        result = ParseResult(file_node=file_node)

        current_section_id: str | None = None

        for i, raw_line in enumerate(lines, start=1):
            # Skip sequence numbers (columns 1-6) and indicators (column 7)
            # In fixed format: columns 1-6 are sequence, 7 is indicator (* = comment)
            if len(raw_line) > 6 and raw_line[6] in ("*", "/"):
                continue
            # Free format comment
            stripped = raw_line.strip()
            if not stripped or stripped.startswith("*>"):
                continue

            # PROGRAM-ID — treat as a "class" node for the program unit
            m = self._PROGRAM_ID_PATTERN.match(stripped)
            if m:
                name = m.group("name").upper()
                node = LexicalNode(
                    node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "class"),
                    node_type="class",
                    name=name,
                    file=file_path,
                    line_start=i,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                result.nodes.append(node)
                continue

            # COPY — import edge
            m = self._COPY_PATTERN.match(stripped)
            if m:
                name = m.group("name").upper()
                result.edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(file_node.node_id, "imports", name),
                    edge_type="imports",
                    source_id=file_node.node_id,
                    target_id=name,
                    target_name=name,
                    file=file_path,
                    line=i,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))
                continue

            # SECTION — function-like grouping
            m = self._SECTION_PATTERN.match(stripped)
            if m:
                name = m.group("name").upper()
                # skip COBOL division keywords like IDENTIFICATION, DATA, PROCEDURE
                if name not in ("IDENTIFICATION", "ENVIRONMENT", "DATA", "PROCEDURE",
                                "FILE", "WORKING-STORAGE", "LOCAL-STORAGE",
                                "LINKAGE", "SCREEN", "REPORT"):
                    node = LexicalNode(
                        node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "function"),
                        node_type="function",
                        name=name,
                        file=file_path,
                        line_start=i,
                        language=language,
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    )
                    result.nodes.append(node)
                    current_section_id = node.node_id
                continue

            # PARAGRAPH
            m = self._PARA_PATTERN.match(raw_line)
            if m:
                name = m.group("name").upper()
                node = LexicalNode(
                    node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "function"),
                    node_type="function",
                    name=name,
                    file=file_path,
                    line_start=i,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                result.nodes.append(node)
                continue

            # PERFORM — call edge from current section (if known)
            m = self._PERFORM_PATTERN.match(stripped)
            if m and current_section_id:
                name = m.group("name").upper()
                if name not in ("VARYING", "UNTIL", "WITH", "TEST", "TIMES",
                                "THROUGH", "THRU"):
                    result.edges.append(GraphEdge(
                        edge_id=GraphEdge.make_id(current_section_id, "calls", name),
                        edge_type="calls",
                        source_id=current_section_id,
                        target_id=name,
                        target_name=name,
                        file=file_path,
                        line=i,
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    ))

        return result


from . import register_language  # noqa: E402

register_language(
    "cobol",
    CobolParser,
    frozenset({".cbl", ".cob", ".cobol", ".cpy"}),
)
