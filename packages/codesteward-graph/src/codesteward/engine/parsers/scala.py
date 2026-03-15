"""Scala parser (tree-sitter AST). Requires ``tree-sitter-scala`` (install with ``uv pip install -e '.[graph-scala]'``).
"""

import structlog

from ._ast_utils import TreeSitterBase, _walk
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()

_KEYWORDS = frozenset({
    "if", "else", "for", "while", "do", "match", "case", "return", "throw",
    "try", "catch", "finally", "new", "this", "super", "null", "true", "false",
    "import", "package", "object", "class", "trait", "extends", "with",
    "def", "val", "var", "type", "lazy", "override", "abstract", "sealed",
    "final", "private", "protected", "implicit", "explicit", "given", "using",
    "yield", "forSome", "macro", "enum", "derives", "opaque",
})


class ScalaParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based Scala parser.

    Extracts IMPORTS, CALLS, EXTENDS (incl. `with` mixins), GUARDED_BY,
    and parameter metadata.
    """

    _CLASS_TYPES = frozenset({
        "class_definition", "trait_definition", "object_definition",
    })

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "scala",
    ) -> "ParseResult":
        parser = self._get_ts_parser("scala")
        content_bytes = content.encode("utf-8")
        tree = parser.parse(content_bytes)
        root = tree.root_node

        file_node = LexicalNode(
            node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, file_path, "file"),
            node_type="file",
            name=file_path,
            file=file_path,
            line_start=1,
            line_end=root.end_point[0] + 1,
            language=language,
            tenant_id=tenant_id,
            repo_id=repo_id,
        )
        result = ParseResult(file_node=file_node)

        result.nodes.extend(
            self._extract_sc_nodes(root, file_path, tenant_id, repo_id, language)
        )
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        result.edges.extend(
            self._extract_sc_extends(root, class_nodes, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_sc_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )
        result.edges.extend(
            self._extract_sc_guarded_by(root, result.nodes, file_path, tenant_id, repo_id)
        )

        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )
        self._extract_sc_parameters(root, fn_nodes)

        return result

    # ------------------------------------------------------------------
    # Node extraction
    # ------------------------------------------------------------------

    def _extract_sc_nodes(
        self,
        root: object,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> "list[LexicalNode]":
        nodes: list[LexicalNode] = []
        for node in _walk(root):
            if node.type in self._CLASS_TYPES:
                name_node = next(
                    (c for c in node.children if c.type == "identifier"), None
                )
                if name_node is None:
                    continue
                name = name_node.text.decode()
                class_node = LexicalNode(
                    node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "class"),
                    node_type="class",
                    name=name,
                    file=file_path,
                    line_start=node.start_point[0] + 1,
                    line_end=node.end_point[0] + 1,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
                nodes.append(class_node)

                # EXTENDS edges extracted separately by _extract_sc_extends()

            elif node.type == "function_definition":
                name_node = next(
                    (c for c in node.children if c.type == "identifier"), None
                )
                if name_node is None:
                    continue
                name = name_node.text.decode()
                if name in _KEYWORDS:
                    continue
                nodes.append(LexicalNode(
                    node_id=LexicalNode.make_id(tenant_id, repo_id, file_path, name, "function"),
                    node_type="function",
                    name=name,
                    file=file_path,
                    line_start=node.start_point[0] + 1,
                    line_end=node.end_point[0] + 1,
                    language=language,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        return nodes

    # ------------------------------------------------------------------
    # EXTENDS extraction
    # ------------------------------------------------------------------

    def _extract_sc_extends(
        self,
        root: object,
        class_nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        """Emit EXTENDS edges from extends_clause (includes `with` mixins)."""
        name_to_node = {n.name: n for n in class_nodes}
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type not in self._CLASS_TYPES:
                continue
            name_node = next(
                (c for c in node.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            name = name_node.text.decode()
            src = name_to_node.get(name)
            if src is None:
                continue
            for child in node.children:
                if child.type == "extends_clause":
                    for type_id in child.children:
                        if type_id.type == "type_identifier":
                            base = type_id.text.decode()
                            if base not in _KEYWORDS:
                                edges.append(GraphEdge(
                                    edge_id=GraphEdge.make_id(
                                        src.node_id, "extends", base
                                    ),
                                    edge_type="extends",
                                    source_id=src.node_id,
                                    target_id=base,
                                    target_name=base,
                                    file=file_path,
                                    line=node.start_point[0] + 1,
                                    tenant_id=tenant_id,
                                    repo_id=repo_id,
                                ))
        return edges

    # ------------------------------------------------------------------
    # Import extraction
    # ------------------------------------------------------------------

    def _extract_sc_imports(
        self,
        root: object,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type != "import_declaration":
                continue
            # Collect path identifiers (field name "path")
            parts: list[str] = []
            for i in range(node.child_count):
                child = node.children[i]
                field = node.field_name_for_child(i)
                if field == "path" and child.type == "identifier":
                    parts.append(child.text.decode())
            if parts:
                module = ".".join(parts)
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(file_node_id, "imports", module),
                    edge_type="imports",
                    source_id=file_node_id,
                    target_id=module,
                    target_name=module,
                    file=file_path,
                    line=node.start_point[0] + 1,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))
        return edges

    # ------------------------------------------------------------------
    # GUARDED_BY extraction (Scala annotations)
    # ------------------------------------------------------------------

    def _extract_sc_guarded_by(
        self,
        root: object,
        nodes: "list[LexicalNode]",
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> "list[GraphEdge]":
        """Emit GUARDED_BY for @annotation on class and function definitions."""
        node_map = {n.name: n for n in nodes if n.node_type in ("function", "class")}
        edges: list[GraphEdge] = []

        for decl in _walk(root):
            if decl.type not in self._CLASS_TYPES | {"function_definition"}:
                continue
            name_node = next(
                (c for c in decl.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            target = node_map.get(name_node.text.decode())
            if target is None:
                continue

            for child in decl.children:
                if child.type != "annotation":
                    continue
                # annotation → name field (type_identifier) or direct type_identifier child
                annot_name_node = child.child_by_field_name("name") or next(
                    (c for c in child.children if c.type == "type_identifier"), None
                )
                if annot_name_node is None:
                    continue
                annot_name = annot_name_node.text.decode()
                edges.append(GraphEdge(
                    edge_id=GraphEdge.make_id(target.node_id, "guarded_by", annot_name),
                    edge_type="guarded_by",
                    source_id=target.node_id,
                    target_id=annot_name,
                    target_name=annot_name,
                    file=file_path,
                    line=decl.start_point[0] + 1,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                ))

        return edges

    # ------------------------------------------------------------------
    # Parameter extraction
    # ------------------------------------------------------------------

    def _extract_sc_parameters(
        self,
        root: object,
        fn_nodes: "list[LexicalNode]",
    ) -> None:
        """Populate ``metadata['parameters']`` on function nodes in-place."""
        fn_map = {n.name: n for n in fn_nodes}
        for node in _walk(root):
            if node.type != "function_definition":
                continue
            name_node = next(
                (c for c in node.children if c.type == "identifier"), None
            )
            if name_node is None:
                continue
            fn = fn_map.get(name_node.text.decode())
            if fn is None:
                continue
            params: list[dict] = []
            for child in node.children:
                if child.type != "parameters":
                    continue
                for p in child.children:
                    if p.type != "parameter":
                        continue
                    pname_node = p.child_by_field_name("name")
                    ptype_node = p.child_by_field_name("type")
                    params.append({
                        "name": pname_node.text.decode() if pname_node else "",
                        "type": ptype_node.text.decode() if ptype_node else None,
                    })
            fn.metadata["parameters"] = params


from . import register_language  # noqa: E402

register_language("scala", ScalaParser, frozenset({".scala"}))
