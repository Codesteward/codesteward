"""Shared tree-sitter utilities and base class for AST-based language parsers.

This module provides:
  - Grammar-loading helpers (_load_grammar, _make_ts_parser)
  - is_available() probe
  - Module-level AST helpers (_walk, _node_has_child_type, _strip_quotes, _import_edge)
  - TreeSitterBase: shared tree-sitter infrastructure inherited by each language's
    _XxxAstParser.  Only methods used by *multiple* language parsers live here;
    language-specific methods stay in their respective modules.
"""


import re
from typing import Any

import structlog

from .base import GraphEdge, LexicalNode

log = structlog.get_logger()

# ---------------------------------------------------------------------------
# SQL keyword detector (for template literal tagging)
# ---------------------------------------------------------------------------

_SQL_RE = re.compile(
    r"\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|INTO|VALUES|CREATE|DROP|ALTER)\b",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Built-in names that are never emitted as CALLS targets
# ---------------------------------------------------------------------------

_BUILTIN_NAMES: frozenset[str] = frozenset(
    {
        "print", "len", "range", "str", "int", "float", "bool", "list", "dict",
        "set", "tuple", "type", "isinstance", "hasattr", "getattr", "setattr",
        "super", "object", "Exception", "ValueError", "TypeError", "KeyError",
        "console", "Math", "JSON", "Object", "Array", "Promise", "Error",
        "parseInt", "parseFloat", "setTimeout", "setInterval", "clearTimeout",
        "require", "module", "exports", "process", "Buffer",
        "System", "String", "Integer", "Long", "Double", "Boolean",
        "List", "Map", "Set", "Optional", "Arrays", "Collections",
    }
)

# ---------------------------------------------------------------------------
# Grammar loader — lazy, per-language
# ---------------------------------------------------------------------------


def _load_grammar(language: str) -> Any:
    """Return the tree-sitter grammar capsule for *language*.

    Imports the appropriate grammar package lazily so the module loads
    cleanly even when tree-sitter is not installed.

    Args:
        language: One of "typescript", "tsx", "javascript", "python", "java".

    Returns:
        Language capsule suitable for ``tree_sitter.Language(capsule)``.

    Raises:
        ImportError: If the grammar package is not installed.
        ValueError: If *language* has no registered grammar.
    """
    if language in ("typescript", "tsx"):
        import tree_sitter_typescript as _ts  # noqa: PLC0415

        return _ts.language_typescript() if language == "typescript" else _ts.language_tsx()

    if language in ("javascript", "jsx"):
        import tree_sitter_javascript as _js  # noqa: PLC0415

        return _js.language()

    if language == "python":
        import tree_sitter_python as _py  # noqa: PLC0415

        return _py.language()

    if language == "java":
        import tree_sitter_java as _java  # noqa: PLC0415

        return _java.language()

    if language == "csharp":
        import tree_sitter_c_sharp as _cs  # noqa: PLC0415

        return _cs.language()

    if language == "kotlin":
        import tree_sitter_kotlin as _kt  # noqa: PLC0415

        return _kt.language()

    if language == "scala":
        import tree_sitter_scala as _sc  # noqa: PLC0415

        return _sc.language()

    if language == "go":
        import tree_sitter_go as _go  # noqa: PLC0415

        return _go.language()

    if language == "c":
        import tree_sitter_c as _c  # noqa: PLC0415

        return _c.language()

    if language == "cpp":
        import tree_sitter_cpp as _cpp  # noqa: PLC0415

        return _cpp.language()

    if language == "rust":
        import tree_sitter_rust as _rust  # noqa: PLC0415

        return _rust.language()

    if language == "php":
        import tree_sitter_php as _php  # noqa: PLC0415

        return _php.language_php_only()

    raise ValueError(f"No tree-sitter grammar registered for language: {language!r}")


def _make_ts_parser(language_capsule: Any) -> Any:
    """Construct a tree-sitter ``Parser`` in a version-agnostic way.

    tree-sitter 0.24+ accepts the ``Language`` in the constructor;
    older versions require ``Parser.set_language()``.

    Args:
        language_capsule: Raw grammar capsule from a language package.

    Returns:
        Configured ``tree_sitter.Parser`` instance.
    """
    from tree_sitter import Language, Parser  # noqa: PLC0415

    lang = Language(language_capsule)
    try:
        return Parser(lang)  # 0.24+
    except TypeError:
        p = Parser()
        p.set_language(lang)  # 0.21–0.23
        return p


# ---------------------------------------------------------------------------
# Public availability probe
# ---------------------------------------------------------------------------


def is_available(language: str = "typescript") -> bool:
    """Return ``True`` if tree-sitter and the grammar for *language* are available.

    Does not raise — safe to call at import time or in ``__init__``.

    Args:
        language: Language to check (default: ``"typescript"``).

    Returns:
        ``True`` if the grammar can be loaded, ``False`` otherwise.
    """
    try:
        _load_grammar(language)
        return True
    except (ImportError, ValueError):
        return False


# ---------------------------------------------------------------------------
# Module-level AST helpers
# ---------------------------------------------------------------------------


def _walk(node: Any):
    """Depth-first generator yielding every node in the AST subtree.

    Args:
        node: Starting tree-sitter ``Node``.

    Yields:
        Every ``Node`` in the subtree (including *node* itself).
    """
    yield node
    for child in node.children:
        yield from _walk(child)


def _node_has_child_type(node: Any, child_type: str) -> bool:
    """Return ``True`` if *node* has a direct child with the given type.

    Args:
        node: Parent ``Node``.
        child_type: Node type string to look for (e.g. ``"async"``).

    Returns:
        ``True`` if any direct child matches *child_type*.
    """
    return any(c.type == child_type for c in node.children)


def _strip_quotes(text: str) -> str:
    """Remove surrounding quote characters from a string literal token.

    Handles single quotes, double quotes, and template backticks.

    Args:
        text: Raw token text including quotes (e.g. ``"'./foo'"``).

    Returns:
        Unquoted string (e.g. ``"./foo"``).
    """
    return text.strip().strip("'\"` ")


def _import_edge(
    file_node_id: str,
    module: str,
    file_path: str,
    node: Any,
    tenant_id: str,
    repo_id: str,
) -> GraphEdge:
    """Build an ``imports`` ``GraphEdge`` for a module reference.

    Args:
        file_node_id: Source node ID.
        module: Imported module path or name.
        file_path: Repo-relative file path.
        node: AST node for line number extraction.
        tenant_id: Tenant namespace.
        repo_id: Repository identifier.

    Returns:
        ``GraphEdge`` with ``edge_type="imports"``.
    """
    return GraphEdge(
        edge_id=GraphEdge.make_id(file_node_id, "imports", module),
        edge_type="imports",
        source_id=file_node_id,
        target_id=module,
        target_name=module,
        file=file_path,
        line=node.start_point[0] + 1,
        tenant_id=tenant_id,
        repo_id=repo_id,
    )


# ---------------------------------------------------------------------------
# TreeSitterBase — shared infrastructure for all AST parsers
# ---------------------------------------------------------------------------


class TreeSitterBase:
    """Shared tree-sitter infrastructure inherited by each language's AST parser.

    Only methods used by *multiple* languages live here.  Language-specific
    extraction logic (node extraction, import extraction, guarded_by) lives in
    the per-language modules (typescript.py, python.py, java.py).
    """

    def __init__(self) -> None:
        """Initialise with an empty grammar cache."""
        self._parsers: dict[str, Any] = {}

    def _get_ts_parser(self, language: str) -> Any:
        """Return a cached tree-sitter Parser for *language*, building it on first call.

        Args:
            language: Source language string.

        Returns:
            Configured tree-sitter Parser instance.
        """
        if language not in self._parsers:
            self._parsers[language] = _make_ts_parser(_load_grammar(language))
        return self._parsers[language]

    def _extract_call_edges(
        self,
        root: Any,
        fn_nodes: list[LexicalNode],
        file_path: str,
        tenant_id: str,
        repo_id: str,
        language: str,
    ) -> list[GraphEdge]:
        """Extract inter-function CALLS edges by attributing call expressions to
        their enclosing function via line-range containment.

        For each call expression in the file, the tightest enclosing function
        (the one with the latest ``line_start`` that still contains the call
        line) is identified as the caller.  A deduplicated ``calls`` edge is
        emitted for each unique (caller, callee) pair per file.

        Args:
            root: AST root node.
            fn_nodes: All function LexicalNodes extracted from this file.
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.
            language: Source language string — determines the call expression
                node type and callee field name.

        Returns:
            List of deduplicated ``calls`` ``GraphEdge`` objects.
        """
        # Only functions with known line ranges can be callers
        scoped_fns = sorted(
            [fn for fn in fn_nodes if fn.line_end is not None],
            key=lambda n: n.line_start,
        )
        if not scoped_fns:
            return []

        # Language-specific call node type
        if language == "java":
            call_node_type = "method_invocation"
        elif language == "python":
            call_node_type = "call"
        elif language == "csharp":
            call_node_type = "invocation_expression"
        elif language == "php":
            return []  # PHP overrides _extract_call_edges() in PhpParser
        else:
            # typescript, tsx, javascript, jsx, kotlin, scala, go, c, cpp, rust
            call_node_type = "call_expression"

        edges: list[GraphEdge] = []
        seen: set[str] = set()

        for ast_node in _walk(root):
            if ast_node.type != call_node_type:
                continue

            call_line = ast_node.start_point[0] + 1

            # Find the tightest (innermost) enclosing function by line range
            caller: LexicalNode | None = None
            for fn in scoped_fns:
                if fn.line_start <= call_line <= (fn.line_end or call_line) and (
                    caller is None or fn.line_start > caller.line_start
                ):
                    caller = fn

            if caller is None:
                continue

            callee_name = self._extract_callee_name(ast_node, language)
            if not callee_name or callee_name == caller.name:
                continue  # skip self-calls and unresolvable calls

            dedup_key = f"{caller.node_id}:{callee_name}"
            if dedup_key in seen:
                continue
            seen.add(dedup_key)

            edges.append(
                GraphEdge(
                    edge_id=GraphEdge.make_id(caller.node_id, "calls", callee_name),
                    edge_type="calls",
                    source_id=caller.node_id,
                    target_id=callee_name,
                    target_name=callee_name,
                    file=file_path,
                    line=call_line,
                    tenant_id=tenant_id,
                    repo_id=repo_id,
                )
            )

        return edges

    def _extract_callee_name(self, call_node: Any, language: str) -> str | None:
        """Extract the callee name from a call expression AST node.

        Returns the immediate function or method name (the last segment of a
        member access chain).  Returns ``None`` for un-nameable calls (e.g.
        immediately-invoked function expressions, subscript calls).

        Args:
            call_node: A call expression AST node.
            language: Source language — determines field names and node types.

        Returns:
            Callee name string, or ``None`` if unresolvable.
        """
        if language == "java":
            # method_invocation: name field holds the method name
            name_node = call_node.child_by_field_name("name")
            return name_node.text.decode() if name_node else None

        if language == "csharp":
            # invocation_expression: function field → identifier or member_access_expression
            fn = call_node.child_by_field_name("function")
            if fn is None:
                return None
            if fn.type == "identifier":
                name = fn.text.decode()
                return None if name in _BUILTIN_NAMES else name
            if fn.type == "member_access_expression":
                name_node = fn.child_by_field_name("name")
                return name_node.text.decode() if name_node else None
            return None

        if language == "kotlin":
            # call_expression: first child is the callee (no "function" field)
            if not call_node.children:
                return None
            callee = call_node.children[0]
            if callee.type == "identifier":
                name = callee.text.decode()
                return None if name in _BUILTIN_NAMES else name
            if callee.type == "navigation_expression":
                # obj.method — last identifier child is the method name
                idents = [c for c in callee.children if c.type == "identifier"]
                return idents[-1].text.decode() if idents else None
            return None

        if language == "scala":
            # call_expression: function field → identifier or field_expression
            fn = call_node.child_by_field_name("function")
            if fn is None:
                return None
            if fn.type == "identifier":
                name = fn.text.decode()
                return None if name in _BUILTIN_NAMES else name
            if fn.type == "field_expression":
                field = fn.child_by_field_name("field")
                return field.text.decode() if field else None
            return None

        if language in ("go", "c", "cpp", "rust"):
            fn = call_node.child_by_field_name("function")
            if fn is None:
                return None
            if fn.type == "identifier":
                name = fn.text.decode()
                return None if name in _BUILTIN_NAMES else name
            # Go: selector_expression (obj.Method) — field named "field"
            # Rust: field_expression (self.db.find) — field named "field"
            # C++: field_expression (obj.method) — field named "field"
            if fn.type in ("selector_expression", "field_expression"):
                field = fn.child_by_field_name("field")
                return field.text.decode() if field else None
            # Rust/C++: scoped identifier (Foo::bar) — name field
            if fn.type in ("scoped_identifier", "qualified_identifier"):
                name_node = fn.child_by_field_name("name")
                return name_node.text.decode() if name_node else None
            return None

        # TypeScript / JavaScript / Python (call or call_expression)
        fn = call_node.child_by_field_name("function")
        if fn is None:
            return None

        if fn.type == "identifier":
            name = fn.text.decode()
            if name in _BUILTIN_NAMES:
                return None
            return name

        if fn.type == "member_expression":
            # JS/TS: obj.method() — take the property (method name)
            prop = fn.child_by_field_name("property")
            return prop.text.decode() if prop else None

        if fn.type == "attribute":
            # Python: obj.method() — take the attribute (method name)
            attr = fn.child_by_field_name("attribute")
            return attr.text.decode() if attr else None

        if fn.type == "await_expression":
            # Python: await some_call() — unwrap and recurse
            inner = fn.named_children[0] if fn.named_children else None
            return self._extract_callee_name(inner, language) if inner else None

        return None

    def _extract_semantic_edges(
        self,
        fn_nodes: list[LexicalNode],
        content_bytes: bytes,
        file_path: str,
        tenant_id: str,
        repo_id: str,
    ) -> list[GraphEdge]:
        """Extract parameter → return data-flow edges for each function.

        For every function node, re-parses its source span to find parameters
        and return statements.  When a return statement text contains a
        parameter name, a ``data_flow`` edge is created.

        Uses tree-sitter line positions directly — no brace-counting or
        text-scanning heuristics needed.

        Args:
            fn_nodes: Function ``LexicalNode`` objects to analyse.
            content_bytes: Full file source as UTF-8 bytes (for line slicing).
            file_path: Repo-relative file path.
            tenant_id: Tenant namespace.
            repo_id: Repository identifier.

        Returns:
            List of ``data_flow`` ``GraphEdge`` objects.
        """
        edges: list[GraphEdge] = []
        lines = content_bytes.decode("utf-8", errors="replace").splitlines()

        for fn_node in fn_nodes:
            if fn_node.line_start is None or fn_node.line_end is None:
                continue

            fn_lines = lines[fn_node.line_start - 1 : fn_node.line_end]
            if not fn_lines:
                continue

            # Extract parameter names from the signature line
            sig_line = fn_lines[0]
            param_match = re.search(r"\(([^)]*)\)", sig_line)
            if not param_match:
                continue
            param_str = param_match.group(1)
            params = [
                p.split(":")[0].strip().lstrip("*").lstrip(".")
                for p in param_str.split(",")
                if p.strip() and p.strip() not in ("", "void", "self", "cls")
            ]
            params = [p for p in params if re.match(r"^\w+$", p)]

            if not params:
                continue

            for rel_i, fn_line in enumerate(fn_lines):
                stripped = fn_line.strip()
                if not stripped.startswith("return "):
                    continue
                for param in params:
                    if re.search(rf"\b{re.escape(param)}\b", stripped):
                        target_label = f"return:{fn_node.name}:{param}"
                        edges.append(
                            GraphEdge(
                                edge_id=GraphEdge.make_id(
                                    fn_node.node_id, "data_flow", target_label
                                ),
                                edge_type="data_flow",
                                source_id=fn_node.node_id,
                                target_id=target_label,
                                target_name=f"param '{param}' → return in {fn_node.name}()",
                                file=file_path,
                                line=fn_node.line_start + rel_i,
                                tenant_id=tenant_id,
                                repo_id=repo_id,
                            )
                        )
                        break

        return edges
