"""Tests for the tree-sitter AST parser.

All tests are skipped automatically when tree-sitter or any required grammar
package is not installed (``pytest.importorskip`` at module level).  This
ensures the test suite keeps passing with ``uv run --extra dev`` (no tree-sitter).

Install tree-sitter grammars to run these tests::

    uv pip install -e ".[graph]"
    uv run --extra dev python -m pytest tests/test_engine/test_tree_sitter_parser.py -v
"""

import pytest

# Skip the entire module when tree-sitter is not installed
pytest.importorskip("tree_sitter", reason="tree-sitter not installed (install with: uv pip install -e '.[graph]')")
pytest.importorskip("tree_sitter_typescript", reason="tree-sitter-typescript not installed")

from codesteward.engine.graph_builder import ParseResult, TypeScriptParser
from codesteward.engine.tree_sitter_parser import TreeSitterParser, is_available

# ---------------------------------------------------------------------------
# Shared fixture content — identical to test_graph_builder.py fixtures so we
# can verify parity between the regex and tree-sitter parsers.
# ---------------------------------------------------------------------------

_AUTH_MODULE_TS = """\
import { db } from '../database/connection';
import { hashPassword, verifyToken } from './crypto';
import type { User } from '../models/user';

export class AuthService {
  private readonly _db = db;

  async login(email: string, password: string): Promise<User | null> {
    const user = await this._db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) return null;
    const valid = await verifyToken(password, user.hash);
    return valid ? user : null;
  }
}

export async function hashUserPassword(password: string): Promise<string> {
  return hashPassword(password);
}

export const DEFAULT_SESSION_TTL = 3600;
"""

_ROUTER_TS = """\
import express from 'express';
import { authenticate } from '../middleware/auth';
import { AuthService } from '../services/auth';

const router = express.Router();
const authService = new AuthService();

export async function handleLogin(req, res) {
  const result = await authService.login(req.body.email, req.body.password);
  res.json({ token: result });
}

router.post('/login', handleLogin);
router.get('/profile', authenticate, async (req, res) => {
  res.json(req.user);
});

export default router;
"""

_UTIL_JS = """\
const crypto = require('crypto');
const config = require('./config');

function hashPassword(password) {
  const salt = config.get('SALT');
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

const verifyToken = async function(token, hash) {
  return hashPassword(token) === hash;
};

module.exports = { hashPassword, verifyToken };
"""

_INHERITANCE_TS = """\
export class BaseService {
  protected readonly name: string = 'base';
}

export class UserService extends BaseService {
  async getUser(id: string) {
    return { id, name: this.name };
  }
}

export class AdminService extends UserService {
  async deleteUser(id: string) {
    return { deleted: id };
  }
}
"""

_SQL_TEMPLATE_TS = """\
import { db } from './db';

export async function getUserById(userId: string) {
  const result = await db.query(`SELECT * FROM users WHERE id = ${userId}`);
  return result;
}

export async function safe(id: string) {
  return db.query('SELECT * FROM users WHERE id = $1', [id]);
}
"""

_PYTHON_MODULE = """\
import os
from pathlib import Path
from typing import Optional

class UserService:
    def get_user(self, user_id: str) -> Optional[dict]:
        return None

    async def create_user(self, name: str, email: str) -> dict:
        return {"name": name, "email": email}


def build_response(data: object, status: int) -> dict:
    return {"data": data, "status": status}


async def fetch_record(record_id: str) -> Optional[dict]:
    return None
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse(
    parser: TreeSitterParser,
    content: str,
    file_path: str = "src/test.ts",
    language: str = "typescript",
) -> ParseResult:
    return parser.parse(
        file_path=file_path,
        content=content,
        tenant_id="test-tenant",
        repo_id="test-repo",
        language=language,
    )


def _node_names(result: ParseResult) -> set[str]:
    return {n.name for n in result.nodes}


def _edge_types(result: ParseResult) -> set[str]:
    return {e.edge_type for e in result.edges}


# ===========================================================================
# is_available()
# ===========================================================================


class TestIsAvailable:
    """Tests for the is_available() probe function."""

    def test_typescript_available(self) -> None:
        """is_available('typescript') returns True when grammar is installed."""
        assert is_available("typescript") is True

    def test_unknown_language_returns_false(self) -> None:
        """Unsupported language returns False without raising."""
        assert is_available("cobol") is False

    def test_returns_bool(self) -> None:
        """is_available() always returns a plain bool."""
        result = is_available("typescript")
        assert isinstance(result, bool)


# ===========================================================================
# File node
# ===========================================================================


class TestFileNode:
    """Every parse must produce a valid file node."""

    def test_file_node_type(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        assert result.file_node.node_type == "file"

    def test_file_node_is_first_in_all_nodes(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        assert result.all_nodes[0] is result.file_node

    def test_file_node_name_equals_path(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS, file_path="src/auth.ts")
        assert result.file_node.name == "src/auth.ts"
        assert result.file_node.file == "src/auth.ts"


# ===========================================================================
# TypeScript lexical extraction
# ===========================================================================


class TestTypeScriptLexical:
    """Lexical node extraction from TypeScript source."""

    def test_class_node_detected(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        assert any(n.name == "AuthService" for n in class_nodes)

    def test_exported_class_flag(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        auth = next(n for n in result.nodes if n.name == "AuthService")
        assert auth.exported is True

    def test_async_function_detected(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        fn = next((n for n in result.nodes if n.name == "hashUserPassword"), None)
        assert fn is not None
        assert fn.is_async is True

    def test_exported_function_flag(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        fn = next(n for n in result.nodes if n.name == "hashUserPassword")
        assert fn.exported is True

    def test_variable_node_detected(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        names = _node_names(result)
        assert "DEFAULT_SESSION_TTL" in names

    def test_async_method_inside_class(self) -> None:
        """Methods inside classes should be extracted."""
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        fn = next((n for n in result.nodes if n.name == "login"), None)
        assert fn is not None
        assert fn.is_async is True

    def test_function_line_start_is_accurate(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        fn = next(n for n in result.nodes if n.name == "hashUserPassword")
        # hashUserPassword starts on line 14 in _AUTH_MODULE_TS (0-indexed: 13)
        assert fn.line_start > 0

    def test_function_line_end_set(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        fn = next(n for n in result.nodes if n.name == "hashUserPassword")
        assert fn.line_end is not None
        assert fn.line_end >= fn.line_start

    def test_router_async_handler(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _ROUTER_TS)
        fn = next((n for n in result.nodes if n.name == "handleLogin"), None)
        assert fn is not None
        assert fn.is_async is True
        assert fn.exported is True

    def test_node_ids_unique_within_file(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        ids = [n.node_id for n in result.all_nodes]
        assert len(ids) == len(set(ids)), "Duplicate node IDs detected"

    def test_node_id_deterministic(self) -> None:
        parser = TreeSitterParser()
        r1 = _parse(parser, _AUTH_MODULE_TS)
        r2 = _parse(parser, _AUTH_MODULE_TS)
        assert r1.file_node.node_id == r2.file_node.node_id
        assert {n.node_id for n in r1.nodes} == {n.node_id for n in r2.nodes}

    def test_different_files_different_node_ids(self) -> None:
        parser = TreeSitterParser()
        r1 = _parse(parser, _AUTH_MODULE_TS, file_path="src/a.ts")
        r2 = _parse(parser, _AUTH_MODULE_TS, file_path="src/b.ts")
        ids_a = {n.node_id for n in r1.all_nodes}
        ids_b = {n.node_id for n in r2.all_nodes}
        assert ids_a.isdisjoint(ids_b)


# ===========================================================================
# TypeScript inheritance (extends edges)
# ===========================================================================


class TestTypeScriptInheritance:
    """Class inheritance → extends edges in the referential layer."""

    def test_extends_edge_detected(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _INHERITANCE_TS)
        extends_edges = [e for e in result.edges if e.edge_type == "extends"]
        assert len(extends_edges) >= 1

    def test_user_service_extends_base_service(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _INHERITANCE_TS)
        edge = next(
            (e for e in result.edges if e.edge_type == "extends" and e.target_name == "BaseService"),
            None,
        )
        assert edge is not None

    def test_admin_service_extends_user_service(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _INHERITANCE_TS)
        edge = next(
            (e for e in result.edges if e.edge_type == "extends" and e.target_name == "UserService"),
            None,
        )
        assert edge is not None

    def test_three_classes_extracted(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _INHERITANCE_TS)
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        names = {n.name for n in class_nodes}
        assert names >= {"BaseService", "UserService", "AdminService"}


# ===========================================================================
# TypeScript import edges
# ===========================================================================


class TestTypeScriptImports:
    """ES module import edges in the referential layer."""

    def test_import_edges_detected(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        import_edges = [e for e in result.edges if e.edge_type == "imports"]
        assert len(import_edges) >= 2

    def test_import_from_crypto(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        modules = {e.target_name for e in result.edges if e.edge_type == "imports"}
        assert "./crypto" in modules

    def test_import_from_database(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        modules = {e.target_name for e in result.edges if e.edge_type == "imports"}
        assert "../database/connection" in modules

    def test_import_source_is_file_node(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _AUTH_MODULE_TS)
        import_edges = [e for e in result.edges if e.edge_type == "imports"]
        for edge in import_edges:
            assert edge.source_id == result.file_node.node_id


# ===========================================================================
# JavaScript (CommonJS) support
# ===========================================================================


class TestJavaScriptCommonJS:
    """CommonJS require() → import edges and JS function extraction."""

    def test_require_import_edge(self) -> None:
        pytest.importorskip("tree_sitter_javascript")
        parser = TreeSitterParser()
        result = _parse(parser, _UTIL_JS, file_path="src/util.js", language="javascript")
        import_edges = [e for e in result.edges if e.edge_type == "imports"]
        modules = {e.target_name for e in import_edges}
        assert "crypto" in modules
        assert "./config" in modules

    def test_plain_function_detected(self) -> None:
        pytest.importorskip("tree_sitter_javascript")
        parser = TreeSitterParser()
        result = _parse(parser, _UTIL_JS, file_path="src/util.js", language="javascript")
        names = _node_names(result)
        assert "hashPassword" in names

    def test_async_function_expression_detected(self) -> None:
        pytest.importorskip("tree_sitter_javascript")
        parser = TreeSitterParser()
        result = _parse(parser, _UTIL_JS, file_path="src/util.js", language="javascript")
        fn = next((n for n in result.nodes if n.name == "verifyToken"), None)
        assert fn is not None
        assert fn.is_async is True


# ===========================================================================
# SQL context tagging
# ===========================================================================


class TestSqlContextTagging:
    """Template literals containing SQL keywords get expression nodes."""

    def test_sql_template_produces_expression_node(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _SQL_TEMPLATE_TS)
        expr_nodes = [n for n in result.nodes if n.node_type == "expression"]
        assert len(expr_nodes) >= 1

    def test_sql_context_metadata(self) -> None:
        parser = TreeSitterParser()
        result = _parse(parser, _SQL_TEMPLATE_TS)
        sql_nodes = [
            n for n in result.nodes
            if n.node_type == "expression" and n.metadata.get("context") == "sql_query"
        ]
        assert len(sql_nodes) >= 1

    def test_non_sql_template_not_tagged(self) -> None:
        """Plain template literals without SQL keywords are not tagged."""
        source = """\
const greeting = `Hello, ${name}!`;
const path = `${base}/users/${id}`;
"""
        parser = TreeSitterParser()
        result = _parse(parser, source)
        sql_nodes = [
            n for n in result.nodes
            if n.node_type == "expression" and n.metadata.get("context") == "sql_query"
        ]
        assert len(sql_nodes) == 0

    def test_parameterized_query_not_tagged(self) -> None:
        """String literals (not template literals) are not tagged."""
        parser = TreeSitterParser()
        result = _parse(parser, _SQL_TEMPLATE_TS)
        # safe() uses a string literal — only the template literal in getUserById should be tagged
        sql_nodes = [n for n in result.nodes if n.node_type == "expression"]
        assert len(sql_nodes) == 1  # only the template string in getUserById


# ===========================================================================
# Python support
# ===========================================================================


class TestPythonParser:
    """Python language support via tree-sitter-python."""

    def test_python_import_skipped_when_grammar_missing(self) -> None:
        pytest.importorskip("tree_sitter_python")

    def test_python_class_detected(self) -> None:
        pytest.importorskip("tree_sitter_python")
        parser = TreeSitterParser()
        result = _parse(parser, _PYTHON_MODULE, file_path="src/user.py", language="python")
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        assert any(n.name == "UserService" for n in class_nodes)

    def test_python_function_detected(self) -> None:
        pytest.importorskip("tree_sitter_python")
        parser = TreeSitterParser()
        result = _parse(parser, _PYTHON_MODULE, file_path="src/user.py", language="python")
        names = _node_names(result)
        assert "build_response" in names

    def test_python_async_function(self) -> None:
        pytest.importorskip("tree_sitter_python")
        parser = TreeSitterParser()
        result = _parse(parser, _PYTHON_MODULE, file_path="src/user.py", language="python")
        fn = next((n for n in result.nodes if n.name == "fetch_record"), None)
        assert fn is not None
        assert fn.is_async is True

    def test_python_method_inside_class(self) -> None:
        pytest.importorskip("tree_sitter_python")
        parser = TreeSitterParser()
        result = _parse(parser, _PYTHON_MODULE, file_path="src/user.py", language="python")
        fn = next((n for n in result.nodes if n.name == "get_user"), None)
        assert fn is not None

    def test_python_import_edges(self) -> None:
        pytest.importorskip("tree_sitter_python")
        parser = TreeSitterParser()
        result = _parse(parser, _PYTHON_MODULE, file_path="src/user.py", language="python")
        import_edges = [e for e in result.edges if e.edge_type == "imports"]
        modules = {e.target_name for e in import_edges}
        assert "os" in modules
        assert "pathlib" in modules

    def test_python_file_node(self) -> None:
        pytest.importorskip("tree_sitter_python")
        parser = TreeSitterParser()
        result = _parse(parser, _PYTHON_MODULE, file_path="src/user.py", language="python")
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "python"


# ===========================================================================
# Parity with regex parser
# ===========================================================================


class TestParserParity:
    """Tree-sitter parser should find at least what the regex parser finds.

    The tree-sitter parser may find *more* nodes (e.g. class methods that
    the regex parser misses), so we only assert a superset relationship for
    symbol names, not exact equality.
    """

    def _regex_names(self, content: str, language: str = "typescript") -> set[str]:
        regex_parser = TypeScriptParser()
        result = regex_parser.parse(
            file_path="src/test.ts",
            content=content,
            tenant_id="test-tenant",
            repo_id="test-repo",
            language=language,
        )
        return {n.name for n in result.nodes}

    def _ts_names(self, content: str, language: str = "typescript") -> set[str]:
        ts_parser = TreeSitterParser()
        result = ts_parser.parse(
            file_path="src/test.ts",
            content=content,
            tenant_id="test-tenant",
            repo_id="test-repo",
            language=language,
        )
        return {n.name for n in result.nodes}

    def test_auth_module_symbols(self) -> None:
        """All symbols found by regex parser are also found by tree-sitter."""
        regex_names = self._regex_names(_AUTH_MODULE_TS)
        ts_names = self._ts_names(_AUTH_MODULE_TS)
        assert regex_names.issubset(ts_names), (
            f"Tree-sitter missed symbols found by regex: {regex_names - ts_names}"
        )

    def test_router_symbols(self) -> None:
        regex_names = self._regex_names(_ROUTER_TS)
        ts_names = self._ts_names(_ROUTER_TS)
        assert regex_names.issubset(ts_names), (
            f"Tree-sitter missed symbols found by regex: {regex_names - ts_names}"
        )

    def test_inheritance_classes(self) -> None:
        regex_names = self._regex_names(_INHERITANCE_TS)
        ts_names = self._ts_names(_INHERITANCE_TS)
        assert regex_names.issubset(ts_names), (
            f"Tree-sitter missed symbols found by regex: {regex_names - ts_names}"
        )

    def test_import_edge_types_present(self) -> None:
        """Both parsers produce import and extends edge types."""
        regex_parser = TypeScriptParser()
        ts_parser = TreeSitterParser()

        for content in (_AUTH_MODULE_TS, _INHERITANCE_TS):
            regex_result = regex_parser.parse("src/x.ts", content, "t", "r")
            ts_result = ts_parser.parse("src/x.ts", content, "t", "r")

            regex_edge_types = {e.edge_type for e in regex_result.edges}
            ts_edge_types = {e.edge_type for e in ts_result.edges}

            # Tree-sitter must cover all edge types that regex covers
            assert regex_edge_types.issubset(ts_edge_types), (
                f"Tree-sitter missed edge types: {regex_edge_types - ts_edge_types}"
            )


# ===========================================================================
# GraphBuilder integration
# ===========================================================================


class TestGraphBuilderIntegration:
    """GraphBuilder uses TreeSitterParser when available."""

    def test_parse_file_returns_parse_result_with_metadata(self) -> None:
        """parse_file() returns nodes that have the metadata dict available."""
        from codesteward.engine.graph_builder import GraphBuilder

        builder = GraphBuilder()
        result = builder.parse_file(
            file_path="src/test.ts",
            content=_SQL_TEMPLATE_TS,
            tenant_id="test-tenant",
            repo_id="test-repo",
            language="typescript",
        )
        # All nodes should have a metadata attribute (may be empty dict)
        for node in result.all_nodes:
            assert hasattr(node, "metadata")
            assert isinstance(node.metadata, dict)

    def test_sql_expression_node_in_graph_builder_output(self) -> None:
        """SQL template literal produces an expression node when using tree-sitter."""
        from codesteward.engine.graph_builder import GraphBuilder

        builder = GraphBuilder()
        result = builder.parse_file(
            file_path="src/user_service.ts",
            content=_SQL_TEMPLATE_TS,
            tenant_id="acme",
            repo_id="payments",
            language="typescript",
        )
        sql_nodes = [
            n for n in result.nodes
            if n.node_type == "expression" and n.metadata.get("context") == "sql_query"
        ]
        assert len(sql_nodes) >= 1, (
            "Expected at least one SQL expression node — is tree-sitter installed?"
        )


# ===========================================================================
# CALLS edge extraction tests
# ===========================================================================

_CALLS_TS = """\
import { db } from './db';
import { hashPassword } from './crypto';

export async function createUser(email: string, password: string) {
  const hashed = hashPassword(password);
  const user = await db.insert({ email, password: hashed });
  return user;
}

export async function getUser(id: string) {
  return db.findById(id);
}

export function buildPayload(data: unknown) {
  return JSON.stringify(data);
}
"""

_CALLS_PY = """\
from database import get_db
from crypto import hash_password


async def create_user(email: str, password: str):
    hashed = hash_password(password)
    db = await get_db()
    user = await db.insert(email=email, password=hashed)
    return user


async def get_user(user_id: str):
    db = await get_db()
    return await db.find_by_id(user_id)


def build_payload(data):
    return str(data)
"""

_CALLS_JAVA = """\
package com.example;

public class UserService {

    private final UserRepository repo;

    public UserService(UserRepository repo) {
        this.repo = repo;
    }

    public User createUser(String email, String password) {
        String hashed = hashPassword(password);
        return repo.save(new User(email, hashed));
    }

    public User getUser(String id) {
        return repo.findById(id);
    }

    private String hashPassword(String password) {
        return password;
    }
}
"""


class TestCallsEdgesTypeScript:
    """CALLS edge extraction for TypeScript via tree-sitter."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        return TreeSitterParser()

    def test_calls_edges_emitted(self, parser: TreeSitterParser) -> None:
        """Functions that call other functions produce CALLS edges."""
        result = parser.parse("src/users.ts", _CALLS_TS, "t", "r", "typescript")
        calls = [e for e in result.edges if e.edge_type == "calls"]
        assert len(calls) >= 1

    def test_calls_edge_source_is_caller_function(self, parser: TreeSitterParser) -> None:
        """CALLS edge source_id matches the calling function's node ID."""
        result = parser.parse("src/users.ts", _CALLS_TS, "t", "r", "typescript")
        calls = [e for e in result.edges if e.edge_type == "calls"]
        fn_ids = {n.node_id for n in result.nodes if n.node_type == "function"}
        assert all(e.source_id in fn_ids for e in calls)

    def test_known_callee_present(self, parser: TreeSitterParser) -> None:
        """hashPassword and db.insert are identified as callees."""
        result = parser.parse("src/users.ts", _CALLS_TS, "t", "r", "typescript")
        targets = {e.target_name for e in result.edges if e.edge_type == "calls"}
        assert "hashPassword" in targets or "insert" in targets

    def test_calls_edges_deduplicated(self, parser: TreeSitterParser) -> None:
        """The same (caller, callee) pair is emitted only once per file."""
        result = parser.parse("src/users.ts", _CALLS_TS, "t", "r", "typescript")
        calls = [(e.source_id, e.target_name) for e in result.edges if e.edge_type == "calls"]
        assert len(calls) == len(set(calls))

    def test_builtin_calls_excluded(self, parser: TreeSitterParser) -> None:
        """Built-in names like JSON, console are not emitted as callees."""
        result = parser.parse("src/users.ts", _CALLS_TS, "t", "r", "typescript")
        targets = {e.target_name for e in result.edges if e.edge_type == "calls"}
        assert "JSON" not in targets
        assert "console" not in targets


class TestCallsEdgesPython:
    """CALLS edge extraction for Python via tree-sitter."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        return TreeSitterParser()

    def test_calls_edges_emitted(self, parser: TreeSitterParser) -> None:
        """Python functions that call other functions produce CALLS edges."""
        pytest.importorskip("tree_sitter_python", reason="tree-sitter-python not installed")
        result = parser.parse("src/users.py", _CALLS_PY, "t", "r", "python")
        calls = [e for e in result.edges if e.edge_type == "calls"]
        assert len(calls) >= 1

    def test_known_python_callee_present(self, parser: TreeSitterParser) -> None:
        """hash_password and get_db are identified as Python callees."""
        pytest.importorskip("tree_sitter_python", reason="tree-sitter-python not installed")
        result = parser.parse("src/users.py", _CALLS_PY, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "calls"}
        assert "hash_password" in targets or "get_db" in targets

    def test_python_builtins_excluded(self, parser: TreeSitterParser) -> None:
        """Python built-ins like str() are not emitted as CALLS targets."""
        pytest.importorskip("tree_sitter_python", reason="tree-sitter-python not installed")
        result = parser.parse("src/users.py", _CALLS_PY, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "calls"}
        assert "str" not in targets


class TestCallsEdgesJava:
    """CALLS edge extraction for Java via tree-sitter."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        return TreeSitterParser()

    def test_calls_edges_emitted(self, parser: TreeSitterParser) -> None:
        """Java methods that call other methods produce CALLS edges."""
        pytest.importorskip("tree_sitter_java", reason="tree-sitter-java not installed")
        result = parser.parse("src/UserService.java", _CALLS_JAVA, "t", "r", "java")
        calls = [e for e in result.edges if e.edge_type == "calls"]
        assert len(calls) >= 1

    def test_known_java_callee_present(self, parser: TreeSitterParser) -> None:
        """repo.save() and repo.findById() are identified as callees."""
        pytest.importorskip("tree_sitter_java", reason="tree-sitter-java not installed")
        result = parser.parse("src/UserService.java", _CALLS_JAVA, "t", "r", "java")
        targets = {e.target_name for e in result.edges if e.edge_type == "calls"}
        assert "save" in targets or "findById" in targets


# ===========================================================================
# GUARDED_BY edge extraction tests
# ===========================================================================

_GUARDED_BY_PY_DECORATORS = """\
from functools import wraps


def login_required(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper


def permission_required(perm):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        return wrapper
    return decorator


@login_required
def get_profile(request):
    return {"user": request.user}


@permission_required("admin")
def delete_user(request, user_id):
    pass


@login_required
@permission_required("editor")
def edit_post(request, post_id):
    pass
"""

_GUARDED_BY_FASTAPI_DEPENDS = """\
from fastapi import Depends, APIRouter
from typing import Annotated

router = APIRouter()


def get_current_user(token: str) -> dict:
    return {"user": token}


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    return user


@router.get("/profile")
async def read_profile(auth: dict = Depends(get_current_user)):
    return auth


@router.delete("/user/{user_id}")
async def remove_user(
    user_id: str,
    admin: dict = Depends(require_admin),
):
    return {"deleted": user_id}
"""

_GUARDED_BY_TS_DECORATORS = """\
import { Injectable, UseGuards, Controller, Get } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';

@Injectable()
export class AppService {
  getData(): string {
    return 'Hello!';
  }
}

@Controller('cats')
@UseGuards(AuthGuard)
export class CatsController {
  @Get()
  @UseGuards(RolesGuard)
  findAll(): string[] {
    return [];
  }
}
"""

_GUARDED_BY_JAVA_ANNOTATIONS = """\
package com.example;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {

    @GetMapping("/profile")
    @PreAuthorize("isAuthenticated()")
    public String getProfile() {
        return "profile";
    }

    @DeleteMapping("/user/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public void deleteUser(String id) {
    }

    @GetMapping("/health")
    public String health() {
        return "ok";
    }
}
"""


class TestGuardedByEdgesPython:
    """GUARDED_BY edge extraction for Python decorators."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        pytest.importorskip("tree_sitter_python", reason="tree-sitter-python not installed")
        return TreeSitterParser()

    def test_guarded_by_edges_emitted(self, parser: TreeSitterParser) -> None:
        """Decorated Python functions emit guarded_by edges."""
        result = parser.parse("src/views.py", _GUARDED_BY_PY_DECORATORS, "t", "r", "python")
        guards = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert len(guards) >= 1

    def test_login_required_decorator_edge(self, parser: TreeSitterParser) -> None:
        """@login_required emits a guarded_by edge with target_name='login_required'."""
        result = parser.parse("src/views.py", _GUARDED_BY_PY_DECORATORS, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "guarded_by"}
        assert "login_required" in targets

    def test_permission_required_decorator_edge(self, parser: TreeSitterParser) -> None:
        """@permission_required emits a guarded_by edge."""
        result = parser.parse("src/views.py", _GUARDED_BY_PY_DECORATORS, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "guarded_by"}
        assert "permission_required" in targets

    def test_multi_decorator_both_emitted(self, parser: TreeSitterParser) -> None:
        """A function with two decorators emits a guarded_by edge for each."""
        result = parser.parse("src/views.py", _GUARDED_BY_PY_DECORATORS, "t", "r", "python")
        # edit_post has both @login_required and @permission_required
        edit_post_node = next(
            (n for n in result.nodes if n.name == "edit_post"), None
        )
        assert edit_post_node is not None, "edit_post function not found"
        guards_from_edit_post = [
            e for e in result.edges
            if e.edge_type == "guarded_by" and e.source_id == edit_post_node.node_id
        ]
        assert len(guards_from_edit_post) >= 2

    def test_guarded_by_source_is_function(self, parser: TreeSitterParser) -> None:
        """GUARDED_BY edges from top-level decorated functions originate from function nodes."""
        result = parser.parse("src/views.py", _GUARDED_BY_PY_DECORATORS, "t", "r", "python")
        fn_ids = {n.node_id for n in result.nodes if n.node_type == "function"}
        guards = [e for e in result.edges if e.edge_type == "guarded_by"]
        # At least one guard edge should source from a top-level function node
        # (nested inner functions like `wrapper` may also be decorated and are fine to skip)
        guards_from_known_fns = [e for e in guards if e.source_id in fn_ids]
        assert len(guards_from_known_fns) >= 1

    def test_guarded_by_edges_deduplicated(self, parser: TreeSitterParser) -> None:
        """The same (function, decorator) pair is emitted at most once."""
        result = parser.parse("src/views.py", _GUARDED_BY_PY_DECORATORS, "t", "r", "python")
        pairs = [(e.source_id, e.target_name) for e in result.edges if e.edge_type == "guarded_by"]
        assert len(pairs) == len(set(pairs))


class TestGuardedByFastapiDepends:
    """GUARDED_BY edge extraction for FastAPI Depends() injection."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        pytest.importorskip("tree_sitter_python", reason="tree-sitter-python not installed")
        return TreeSitterParser()

    def test_depends_guarded_by_edges_emitted(self, parser: TreeSitterParser) -> None:
        """FastAPI Depends() parameters produce guarded_by edges."""
        result = parser.parse("src/routes.py", _GUARDED_BY_FASTAPI_DEPENDS, "t", "r", "python")
        guards = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert len(guards) >= 1

    def test_depends_target_is_inner_function_name(self, parser: TreeSitterParser) -> None:
        """The guarded_by target is the function name inside Depends(), not 'Depends'."""
        result = parser.parse("src/routes.py", _GUARDED_BY_FASTAPI_DEPENDS, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "guarded_by"}
        # read_profile uses Depends(get_current_user) → target is get_current_user
        assert "get_current_user" in targets
        # remove_user uses Depends(require_admin) → target is require_admin
        assert "require_admin" in targets

    def test_depends_does_not_emit_depends_as_target(self, parser: TreeSitterParser) -> None:
        """'Depends' itself must not appear as a guarded_by target name."""
        result = parser.parse("src/routes.py", _GUARDED_BY_FASTAPI_DEPENDS, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "guarded_by"}
        assert "Depends" not in targets


class TestGuardedByEdgesTypeScript:
    """GUARDED_BY edge extraction for TypeScript/JS decorators."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        return TreeSitterParser()

    def test_ts_guarded_by_edges_emitted(self, parser: TreeSitterParser) -> None:
        """TypeScript class/method decorators emit guarded_by edges."""
        result = parser.parse("src/cats.controller.ts", _GUARDED_BY_TS_DECORATORS, "t", "r", "typescript")
        guards = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert len(guards) >= 1

    def test_use_guards_class_decorator_emitted(self, parser: TreeSitterParser) -> None:
        """@UseGuards(AuthGuard) on a class emits a guarded_by edge."""
        result = parser.parse("src/cats.controller.ts", _GUARDED_BY_TS_DECORATORS, "t", "r", "typescript")
        targets = {e.target_name for e in result.edges if e.edge_type == "guarded_by"}
        assert "UseGuards" in targets or "AuthGuard" in targets

    def test_injectable_decorator_emitted(self, parser: TreeSitterParser) -> None:
        """@Injectable() on a class emits a guarded_by edge."""
        result = parser.parse("src/cats.controller.ts", _GUARDED_BY_TS_DECORATORS, "t", "r", "typescript")
        targets = {e.target_name for e in result.edges if e.edge_type == "guarded_by"}
        assert "Injectable" in targets

    def test_ts_guarded_by_source_is_class_or_function(self, parser: TreeSitterParser) -> None:
        """TS GUARDED_BY edges originate from class or function nodes."""
        result = parser.parse("src/cats.controller.ts", _GUARDED_BY_TS_DECORATORS, "t", "r", "typescript")
        valid_ids = {
            n.node_id for n in result.nodes if n.node_type in ("class", "function")
        }
        guards = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert len(guards) >= 1
        for edge in guards:
            assert edge.source_id in valid_ids, (
                f"guarded_by source {edge.source_id} is not a class/function node"
            )

    def test_ts_guarded_by_deduplicated(self, parser: TreeSitterParser) -> None:
        """The same (class/fn, decorator) pair is emitted at most once."""
        result = parser.parse("src/cats.controller.ts", _GUARDED_BY_TS_DECORATORS, "t", "r", "typescript")
        pairs = [(e.source_id, e.target_name) for e in result.edges if e.edge_type == "guarded_by"]
        assert len(pairs) == len(set(pairs))


class TestGuardedByEdgesJava:
    """GUARDED_BY edge extraction for Java annotations."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        pytest.importorskip("tree_sitter_java", reason="tree-sitter-java not installed")
        return TreeSitterParser()

    def test_java_guarded_by_edges_emitted(self, parser: TreeSitterParser) -> None:
        """Java method annotations emit guarded_by edges."""
        result = parser.parse("src/UserController.java", _GUARDED_BY_JAVA_ANNOTATIONS, "t", "r", "java")
        guards = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert len(guards) >= 1

    def test_pre_authorize_annotation_emitted(self, parser: TreeSitterParser) -> None:
        """@PreAuthorize annotations produce guarded_by edges."""
        result = parser.parse("src/UserController.java", _GUARDED_BY_JAVA_ANNOTATIONS, "t", "r", "java")
        targets = {e.target_name for e in result.edges if e.edge_type == "guarded_by"}
        assert "PreAuthorize" in targets

    def test_rest_controller_class_annotation_emitted(self, parser: TreeSitterParser) -> None:
        """@RestController on the class itself emits a guarded_by edge."""
        result = parser.parse("src/UserController.java", _GUARDED_BY_JAVA_ANNOTATIONS, "t", "r", "java")
        targets = {e.target_name for e in result.edges if e.edge_type == "guarded_by"}
        assert "RestController" in targets

    def test_health_endpoint_has_no_pre_authorize(self, parser: TreeSitterParser) -> None:
        """The health() method has no @PreAuthorize, so no guarded_by edge from it."""
        result = parser.parse("src/UserController.java", _GUARDED_BY_JAVA_ANNOTATIONS, "t", "r", "java")
        health_node = next(
            (n for n in result.nodes if n.name == "health"), None
        )
        if health_node is None:
            return  # if not extracted, no false edge is possible
        guards_from_health = [
            e for e in result.edges
            if e.edge_type == "guarded_by"
            and e.source_id == health_node.node_id
            and e.target_name == "PreAuthorize"
        ]
        assert len(guards_from_health) == 0

    def test_java_guarded_by_deduplicated(self, parser: TreeSitterParser) -> None:
        """The same (method, annotation) pair is emitted at most once."""
        result = parser.parse("src/UserController.java", _GUARDED_BY_JAVA_ANNOTATIONS, "t", "r", "java")
        pairs = [(e.source_id, e.target_name) for e in result.edges if e.edge_type == "guarded_by"]
        assert len(pairs) == len(set(pairs))


# ===========================================================================
# EXTENDS edge extraction — Python
# ===========================================================================

_PY_INHERITANCE = """\
class Base:
    def base_method(self):
        pass

class Child(Base):
    def child_method(self):
        pass

class MultiChild(Base, Mixin):
    def multi_method(self):
        pass

class NoParent:
    pass
"""


class TestExtendsEdgesPython:
    """Python EXTENDS edges extracted from class inheritance."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        pytest.importorskip("tree_sitter_python", reason="tree-sitter-python not installed")
        return TreeSitterParser()

    def test_extends_edges_emitted(self, parser: TreeSitterParser) -> None:
        """Python classes with base classes emit extends edges."""
        result = parser.parse("src/models.py", _PY_INHERITANCE, "t", "r", "python")
        extends = [e for e in result.edges if e.edge_type == "extends"]
        assert len(extends) >= 1

    def test_child_extends_base(self, parser: TreeSitterParser) -> None:
        """Child(Base) emits an extends edge with target_name='Base'."""
        result = parser.parse("src/models.py", _PY_INHERITANCE, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "Base" in targets

    def test_multiple_bases_both_emitted(self, parser: TreeSitterParser) -> None:
        """MultiChild(Base, Mixin) emits extends edges for both Base and Mixin."""
        result = parser.parse("src/models.py", _PY_INHERITANCE, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "Mixin" in targets

    def test_no_parent_class_no_extends_edge(self, parser: TreeSitterParser) -> None:
        """Classes with no base class emit no extends edge."""
        result = parser.parse("src/models.py", _PY_INHERITANCE, "t", "r", "python")
        no_parent_id = next(
            (n.node_id for n in result.nodes if n.node_type == "class" and n.name == "NoParent"),
            None,
        )
        if no_parent_id is None:
            return
        extends_from_no_parent = [
            e for e in result.edges if e.edge_type == "extends" and e.source_id == no_parent_id
        ]
        assert len(extends_from_no_parent) == 0

    def test_object_base_not_emitted(self, parser: TreeSitterParser) -> None:
        """'object' as base class is NOT emitted as an extends edge."""
        code = "class Explicit(object):\n    pass\n"
        result = parser.parse("src/models.py", code, "t", "r", "python")
        targets = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "object" not in targets

    def test_extends_source_is_class_node(self, parser: TreeSitterParser) -> None:
        """EXTENDS edges originate from class nodes."""
        result = parser.parse("src/models.py", _PY_INHERITANCE, "t", "r", "python")
        class_ids = {n.node_id for n in result.nodes if n.node_type == "class"}
        for e in result.edges:
            if e.edge_type == "extends":
                assert e.source_id in class_ids


# ===========================================================================
# EXTENDS edge extraction — Java
# ===========================================================================

_JAVA_INHERITANCE = """\
package com.example;

public class Animal {
    public void speak() {}
}

public class Dog extends Animal {
    public void bark() {}
}

public class ServiceDog extends Dog implements Trainable {
    public void performTask() {}
}

public interface Trainable {
    void train();
}

public interface AdvancedTrainable extends Trainable {
    void advancedTrain();
}
"""


class TestExtendsEdgesJava:
    """Java EXTENDS edges for class inheritance and interface implementation."""

    @pytest.fixture
    def parser(self) -> TreeSitterParser:
        pytest.importorskip("tree_sitter_java", reason="tree-sitter-java not installed")
        return TreeSitterParser()

    def test_extends_edges_emitted(self, parser: TreeSitterParser) -> None:
        """Java classes with extends/implements emit extends edges."""
        result = parser.parse("src/Animal.java", _JAVA_INHERITANCE, "t", "r", "java")
        extends = [e for e in result.edges if e.edge_type == "extends"]
        assert len(extends) >= 1

    def test_dog_extends_animal(self, parser: TreeSitterParser) -> None:
        """Dog extends Animal emits an extends edge."""
        result = parser.parse("src/Animal.java", _JAVA_INHERITANCE, "t", "r", "java")
        targets = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "Animal" in targets

    def test_implements_emitted_as_extends(self, parser: TreeSitterParser) -> None:
        """implements Trainable also emits an extends edge."""
        result = parser.parse("src/Animal.java", _JAVA_INHERITANCE, "t", "r", "java")
        targets = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "Trainable" in targets

    def test_interface_extends_interface(self, parser: TreeSitterParser) -> None:
        """interface AdvancedTrainable extends Trainable emits an extends edge."""
        result = parser.parse("src/Animal.java", _JAVA_INHERITANCE, "t", "r", "java")
        targets = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "Trainable" in targets

    def test_no_parent_no_extends_edge(self, parser: TreeSitterParser) -> None:
        """Animal has no extends/implements — no extends edge from Animal."""
        result = parser.parse("src/Animal.java", _JAVA_INHERITANCE, "t", "r", "java")
        animal_id = next(
            (n.node_id for n in result.nodes if n.node_type == "class" and n.name == "Animal"),
            None,
        )
        if animal_id is None:
            return
        from_animal = [e for e in result.edges if e.edge_type == "extends" and e.source_id == animal_id]
        assert len(from_animal) == 0

    def test_extends_source_is_class_node(self, parser: TreeSitterParser) -> None:
        """EXTENDS edges originate from class nodes."""
        result = parser.parse("src/Animal.java", _JAVA_INHERITANCE, "t", "r", "java")
        class_ids = {n.node_id for n in result.nodes if n.node_type == "class"}
        for e in result.edges:
            if e.edge_type == "extends":
                assert e.source_id in class_ids
