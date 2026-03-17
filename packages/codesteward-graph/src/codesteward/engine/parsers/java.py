"""Java parser (tree-sitter AST). Requires ``tree-sitter-java`` (install with ``uv pip install -e '.[graph]'``).
"""


from typing import Any

import structlog

from ._ast_utils import (
    TreeSitterBase,
    _import_edge,
    _walk,
)
from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult

log = structlog.get_logger()


# ===========================================================================
# AST-based Java parser (tree-sitter)
# ===========================================================================


class JavaParser(TreeSitterBase, LanguageParser):
    """Tree-sitter-based Java parser.

    All Java-specific extraction methods are concentrated here. Shared methods
    (_extract_call_edges, _extract_callee_name) are inherited from TreeSitterBase.
    """

    def parse(
        self,
        file_path: str,
        content: str,
        tenant_id: str,
        repo_id: str,
        language: str = "java",
    ) -> ParseResult:
        """Parse a Java file via tree-sitter.

        Args:
            file_path: Repo-relative path to the file.
            content: Full file content as a string.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always "java".

        Returns:
            ParseResult with the file node, symbol nodes, and edges.
        """
        parser = self._get_ts_parser("java")
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
            self._extract_java_nodes(root, file_path, tenant_id, repo_id, language)
        )
        result.edges.extend(
            self._extract_java_imports(root, file_node.node_id, file_path, tenant_id, repo_id)
        )

        # CALLS edges
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        result.edges.extend(
            self._extract_call_edges(root, fn_nodes, file_path, tenant_id, repo_id, language)
        )

        # EXTENDS edges
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        result.edges.extend(
            self._extract_java_extends(root, class_nodes, file_path, tenant_id, repo_id)
        )

        # GUARDED_BY edges
        result.edges.extend(
            self._extract_java_guarded_by(root, fn_nodes, result.nodes, file_path, tenant_id, repo_id)
        )

        # Parameter extraction (enriches function node metadata in-place)
        self._extract_java_parameters(root, fn_nodes, language)

        return result

    # ------------------------------------------------------------------
    # Java node extraction
    # ------------------------------------------------------------------

    def _extract_java_nodes(
        self,
        root: Any,
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[LexicalNode]:
        """Extract lexical nodes from a Java AST.

        Processes class declarations and method declarations.

        Args:
            root: AST root node (program).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Always ``"java"``.

        Returns:
            List of ``LexicalNode`` objects.
        """
        nodes: list[LexicalNode] = []
        for node in _walk(root):
            if node.type == "class_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    cls_node = LexicalNode(
                        node_id=LexicalNode.make_id(
                            tenant_id, repo_id, file_path, name_node.text.decode(), "class"
                        ),
                        node_type="class",
                        name=name_node.text.decode(),
                        file=file_path,
                        line_start=node.start_point[0] + 1,
                        line_end=node.end_point[0] + 1,
                        language=language,
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    )
                    nodes.append(cls_node)

            elif node.type == "method_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    method_node = LexicalNode(
                        node_id=LexicalNode.make_id(
                            tenant_id, repo_id, file_path, name_node.text.decode(), "function"
                        ),
                        node_type="function",
                        name=name_node.text.decode(),
                        file=file_path,
                        line_start=node.start_point[0] + 1,
                        line_end=node.end_point[0] + 1,
                        language=language,
                        tenant_id=tenant_id,
                        repo_id=repo_id,
                    )
                    nodes.append(method_node)

        return nodes

    # ------------------------------------------------------------------
    # EXTENDS edge extraction
    # ------------------------------------------------------------------

    def _extract_java_extends(
        self,
        root: Any,
        class_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Emit EXTENDS edges for Java class inheritance and interface implementation.

        Handles:
        - ``class Foo extends Bar`` → ``superclass`` field → ``type_identifier``
        - ``class Foo implements Bar, Baz`` → ``interfaces`` field →
          ``super_interfaces`` → ``interface_type_list`` → ``type_identifier``
        - ``interface Foo extends Bar`` → ``extends_interfaces`` field →
          ``interface_type_list`` → ``type_identifier``

        Args:
            root: AST root node.
            class_nodes: Class LexicalNodes extracted from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``extends`` ``GraphEdge`` objects.
        """
        name_to_node = {n.name: n for n in class_nodes}
        edges: list[GraphEdge] = []
        seen: set[str] = set()

        def _emit(src: LexicalNode, base: str, line: int) -> None:
            key = f"{src.node_id}:{base}"
            if key in seen:
                return
            seen.add(key)
            edges.append(GraphEdge(
                edge_id=GraphEdge.make_id(src.node_id, "extends", base),
                edge_type="extends",
                source_id=src.node_id,
                target_id=base,
                target_name=base,
                file=file_path,
                line=line,
                tenant_id=tenant_id,
                repo_id=repo_id,
            ))

        for node in _walk(root):
            if node.type == "class_declaration":
                name_node = node.child_by_field_name("name")
                if not name_node:
                    continue
                src = name_to_node.get(name_node.text.decode())
                if not src:
                    continue
                line = node.start_point[0] + 1

                # extends (single superclass)
                superclass = node.child_by_field_name("superclass")
                if superclass:
                    for child in _walk(superclass):
                        if child.type == "type_identifier":
                            _emit(src, child.text.decode(), line)

                # implements (multiple interfaces)
                interfaces = node.child_by_field_name("interfaces")
                if interfaces:
                    for child in _walk(interfaces):
                        if child.type == "type_identifier":
                            _emit(src, child.text.decode(), line)

            elif node.type == "interface_declaration":
                name_node = node.child_by_field_name("name")
                if not name_node:
                    continue
                src = name_to_node.get(name_node.text.decode())
                if not src:
                    continue
                line = node.start_point[0] + 1

                # extends (interfaces can extend multiple interfaces)
                ext_ifaces = node.child_by_field_name("extends_interfaces")
                if ext_ifaces:
                    for child in _walk(ext_ifaces):
                        if child.type == "type_identifier":
                            _emit(src, child.text.decode(), line)

        return edges

    # ------------------------------------------------------------------
    # Java import edge extraction
    # ------------------------------------------------------------------

    def _extract_java_imports(
        self,
        root: Any,
        file_node_id: str,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract import edges from a Java AST.

        Handles ``import`` declarations.

        Args:
            root: AST root node (program).
            file_node_id: ID of the file ``LexicalNode`` (edge source).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``GraphEdge`` objects with ``edge_type="imports"``.
        """
        edges: list[GraphEdge] = []
        for node in _walk(root):
            if node.type == "import_declaration":
                # Grab the module path text (strip trailing semicolon/wildcard)
                module = node.text.decode().strip()
                # Remove "import " prefix and trailing ";"
                if module.startswith("import "):
                    module = module[7:].rstrip(";").strip()
                if module.startswith("static "):
                    module = module[7:].strip()
                if module:
                    edges.append(
                        _import_edge(file_node_id, module, file_path, node, tenant_id, repo_id)
                    )

        return edges

    # ------------------------------------------------------------------
    # GUARDED_BY edge extraction
    # ------------------------------------------------------------------

    def _extract_java_guarded_by(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        result_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract GUARDED_BY edges for Java annotation nodes on methods and classes.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes from this file.
            result_nodes: All LexicalNodes from this file (unused directly).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``guarded_by`` ``GraphEdge`` objects.
        """
        edges: list[GraphEdge] = []
        seen: set[str] = set()

        def _emit(source_id: str, guard_name: str, line: int) -> None:
            key = f"{source_id}:{guard_name}"
            if key in seen:
                return
            seen.add(key)
            edges.append(
                GraphEdge(
                    edge_id=GraphEdge.make_id(source_id, "guarded_by", guard_name),
                    edge_type="guarded_by",
                    source_id=source_id,
                    target_id=guard_name,
                    target_name=guard_name,
                    file=file_path,
                    line=line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
            )

        for node in _walk(root):
            if node.type not in (
                "method_declaration",
                "constructor_declaration",
                "class_declaration",
            ):
                continue
            name_node = node.child_by_field_name("name")
            if not name_node:
                continue
            node_type = "class" if node.type == "class_declaration" else "function"
            source_id = LexicalNode.make_id(
                tenant_id, repo_id, file_path, name_node.text.decode(), node_type
            )
            for child in node.children:
                if child.type != "modifiers":
                    continue
                for modifier in child.children:
                    if modifier.type in ("annotation", "marker_annotation"):
                        guard_name = self._java_annotation_name(modifier)
                        if guard_name:
                            _emit(source_id, guard_name, modifier.start_point[0] + 1)

        return edges

    def _java_annotation_name(self, annotation_node: Any) -> str | None:
        """Extract the annotation name from a Java ``annotation`` AST node.

        Handles simple annotations (``@RestController``) and scoped annotations
        (``@org.springframework.web.bind.annotation.GetMapping``).

        Args:
            annotation_node: A tree-sitter Java ``annotation`` node.

        Returns:
            Annotation name string, or ``None`` if unresolvable.
        """
        for child in annotation_node.children:
            if child.type == "identifier":
                return str(child.text.decode())
            if child.type == "scoped_identifier":
                name_part = child.child_by_field_name("name")
                return str(name_part.text.decode()) if name_part else str(child.text.decode())
        return None

    # ------------------------------------------------------------------
    # Parameter extraction (enriches function node metadata in-place)
    # ------------------------------------------------------------------

    def _extract_java_parameters(
        self, root: Any, fn_nodes: list[LexicalNode], language: str
    ) -> None:
        """Populate ``metadata['parameters']`` for Java method nodes.

        Args:
            root: AST root node.
            fn_nodes: Function LexicalNodes to enrich (modified in-place).
            language: Always "java".
        """
        fn_by_line: dict[int, LexicalNode] = {n.line_start: n for n in fn_nodes}

        for node in _walk(root):
            if node.type not in ("method_declaration", "constructor_declaration"):
                continue
            fn_line = node.start_point[0] + 1
            # Java method name is on same line as signature but node may start on annotation line.
            # Try fn_line and the line of the method name child.
            name_node = node.child_by_field_name("name")
            if name_node:
                fn_line = name_node.start_point[0] + 1
            fn_node = fn_by_line.get(fn_line)
            if fn_node is None:
                continue
            params_node = node.child_by_field_name("parameters")
            if not params_node:
                continue
            params: list[dict[str, Any]] = []
            for param in params_node.children:
                if param.type != "formal_parameter":
                    continue
                p = self._java_param_info(param)
                if p:
                    params.append(p)
            if params:
                fn_node.metadata["parameters"] = params

    def _java_param_info(self, param_node: Any) -> dict[str, Any] | None:
        """Extract name and type from a Java ``formal_parameter`` AST node.

        Args:
            param_node: A tree-sitter ``formal_parameter`` node.

        Returns:
            Dict with ``name`` and ``type`` keys, or ``None``.
        """
        type_node = param_node.child_by_field_name("type")
        name_node = param_node.child_by_field_name("name")
        if not name_node:
            return None
        type_text = type_node.text.decode() if type_node else None
        return {"name": name_node.text.decode(), "type": type_text}
