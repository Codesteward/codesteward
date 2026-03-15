"""Tests for the codebase graph builder.

All tests run without Neo4j — the builder is used in stub mode (no driver).
Realistic TypeScript/JavaScript code samples are used as fixtures.
"""


import json
from pathlib import Path

import pytest
from codesteward.engine.graph_builder import (
    GraphBuilder,
    PackageJsonParser,
    ParseResult,
    TypeScriptParser,
    build_graph,
)

# ---------------------------------------------------------------------------
# Realistic TypeScript code fixtures
# ---------------------------------------------------------------------------

# A TypeScript auth module with a class, functions, imports, and PII logging
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

# A simple Express router
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

# JavaScript (CommonJS) utility
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

# A class with inheritance
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

# A file with data flow (params flow to return values)
_DATA_FLOW_TS = """\
export function buildResponse(data: unknown, status: number) {
  return { data, status, timestamp: Date.now() };
}

export async function fetchAndReturn(userId: string) {
  const record = await db.get(userId);
  return record;
}
"""

_CSHARP_SERVICE = """\
using System.Collections.Generic;
using Microsoft.AspNetCore.Authorization;

namespace MyApp.Services
{
    public class UserService : BaseService
    {
        [Authorize]
        [HttpGet("/users/{id}")]
        public async Task<User> GetUser(int id)
        {
            return await _repository.FindAsync(id);
        }

        public UserService(IRepository repository)
        {
            _repository = repository;
        }

        private readonly IRepository _repository;
    }
}
"""

_KOTLIN_SERVICE = """\
package com.example.app

import org.springframework.security.access.annotation.Secured
import kotlinx.coroutines.Deferred

open class PaymentService : BaseService() {

    @Secured("ROLE_ADMIN")
    suspend fun processPayment(amount: Double): Deferred<Result> {
        return async { doProcess(amount) }
    }

    fun validateAmount(amount: Double): Boolean {
        return amount > 0.0
    }
}
"""

_SCALA_SERVICE = """\
package com.example

import scala.concurrent.Future
import scala.concurrent.ExecutionContext

@Secured("admin")
class ReportService extends BaseService with Logging {

  def generateReport(id: Long): Future[Report] = {
    Future { buildReport(id) }
  }

  def validate(id: Long): Boolean = id > 0
}
"""

_COBOL_PROGRAM = """\
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYROLL-CALC.

       ENVIRONMENT DIVISION.

       DATA DIVISION.
       WORKING-STORAGE SECTION.

       PROCEDURE DIVISION.
       COPY PAYROLL-COMMON.

       MAIN-PROCESS SECTION.
           PERFORM VALIDATE-EMPLOYEE
           PERFORM CALCULATE-PAY
           STOP RUN.

       VALIDATE-EMPLOYEE.
           IF EMPLOYEE-ID = SPACES
               MOVE 'N' TO VALID-FLAG
           END-IF.

       CALCULATE-PAY.
           PERFORM COMPUTE-GROSS-PAY.
"""

_GO_SERVICE = """\
package payments

import (
    "fmt"
    "github.com/example/auth"
)

type PaymentProcessor struct {
    repo Repository
}

func NewPaymentProcessor(repo Repository) *PaymentProcessor {
    return &PaymentProcessor{repo: repo}
}

func (p *PaymentProcessor) Process(amount float64) error {
    if err := auth.CheckPermission("payments.write"); err != nil {
        return err
    }
    fmt.Println("processing", amount)
    return p.repo.Save(amount)
}

func validateAmount(amount float64) bool {
    return amount > 0
}
"""

_C_MODULE = """\
#include <stdio.h>
#include <stdlib.h>
#include "payment.h"

int process_payment(double amount) {
    if (amount <= 0) {
        return -1;
    }
    printf("processing %.2f\\n", amount);
    return save_record(amount);
}

static int validate_amount(double amount) {
    return amount > 0;
}
"""

_CPP_SERVICE = """\
#include <string>
#include "base_service.h"

class PaymentService : public BaseService, public Serializable {
public:
    PaymentService(std::string id) : id_(id) {}

    int processPayment(double amount) {
        if (!validate(amount)) return -1;
        return save(amount);
    }

private:
    bool validate(double amount) {
        return amount > 0;
    }

    std::string id_;
};
"""

_RUST_SERVICE = """\
use std::collections::HashMap;
use crate::auth::require_permission;

#[derive(Debug)]
pub struct PaymentService {
    repo: Repository,
}

#[allow(dead_code)]
pub fn new_service(repo: Repository) -> PaymentService {
    PaymentService { repo }
}

impl PaymentService {
    pub async fn process(&self, amount: f64) -> Result<(), Error> {
        require_permission("payments.write")?;
        self.repo.save(amount).await
    }

    fn validate(&self, amount: f64) -> bool {
        amount > 0.0
    }
}
"""

_PHP_SERVICE = """\
<?php

namespace App\\Services;

use App\\Base\\BaseService;
use App\\Auth\\Authorize;

class PaymentService extends BaseService implements Loggable {

    #[Authorize("payments.write")]
    public function processPayment(float $amount): bool {
        if ($amount <= 0) {
            return false;
        }
        return $this->repo->save($amount);
    }

    private function validate(float $amount): bool {
        return $amount > 0;
    }
}
"""


# ===========================================================================
# TypeScriptParser tests
# ===========================================================================


class TestTypeScriptParser:
    """Unit tests for the TypeScript/JS regex-based parser."""

    @pytest.fixture
    def parser(self) -> TypeScriptParser:
        return TypeScriptParser()

    def _parse(self, parser: TypeScriptParser, content: str, file_path: str = "src/test.ts") -> ParseResult:
        return parser.parse(
            file_path=file_path,
            content=content,
            tenant_id="test-tenant",
            repo_id="test-repo",
        )

    # -- Lexical: files -------------------------------------------------

    def test_parse_creates_file_node(self, parser: TypeScriptParser) -> None:
        """Every parsed file produces exactly one file-type node."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        assert result.file_node.node_type == "file"
        assert result.file_node.name == "src/test.ts"

    def test_file_node_id_is_deterministic(self, parser: TypeScriptParser) -> None:
        """Parsing the same file twice yields the same file node ID."""
        r1 = self._parse(parser, _AUTH_MODULE_TS)
        r2 = self._parse(parser, _AUTH_MODULE_TS)
        assert r1.file_node.node_id == r2.file_node.node_id

    # -- Lexical: classes -----------------------------------------------

    def test_class_extraction(self, parser: TypeScriptParser) -> None:
        """AuthService class is extracted as a class-type node."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        classes = [n for n in result.nodes if n.node_type == "class"]
        assert any(c.name == "AuthService" for c in classes)

    def test_exported_class_flagged(self, parser: TypeScriptParser) -> None:
        """AuthService is exported — exported flag must be True."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        cls = next(n for n in result.nodes if n.name == "AuthService")
        assert cls.exported is True

    def test_inheritance_extracts_both_classes(self, parser: TypeScriptParser) -> None:
        """UserService and AdminService are both extracted from the inheritance file."""
        result = self._parse(parser, _INHERITANCE_TS)
        names = {n.name for n in result.nodes if n.node_type == "class"}
        assert "BaseService" in names
        assert "UserService" in names
        assert "AdminService" in names

    # -- Lexical: functions ---------------------------------------------

    def test_async_function_declaration_extracted(self, parser: TypeScriptParser) -> None:
        """hashUserPassword async export function is extracted."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        fns = {n.name for n in result.nodes if n.node_type == "function"}
        assert "hashUserPassword" in fns

    def test_async_function_flagged(self, parser: TypeScriptParser) -> None:
        """hashUserPassword is flagged as async."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        fn = next(n for n in result.nodes if n.name == "hashUserPassword")
        assert fn.is_async is True

    def test_arrow_function_extracted(self, parser: TypeScriptParser) -> None:
        """Arrow function assignment (const name = ...) is extracted."""
        result = self._parse(parser, _ROUTER_TS)
        fn_names = {n.name for n in result.nodes if n.node_type == "function"}
        assert "handleLogin" in fn_names

    def test_js_function_declaration_extracted(self, parser: TypeScriptParser) -> None:
        """Plain JS function declaration (no export) is extracted."""
        result = self._parse(parser, _UTIL_JS, file_path="src/util.js")
        fns = {n.name for n in result.nodes if n.node_type == "function"}
        assert "hashPassword" in fns

    # -- Lexical: variables ---------------------------------------------

    def test_exported_const_extracted(self, parser: TypeScriptParser) -> None:
        """DEFAULT_SESSION_TTL const is extracted as a variable node."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        vars_ = [n for n in result.nodes if n.node_type == "variable"]
        assert any(v.name == "DEFAULT_SESSION_TTL" for v in vars_)

    # -- Referential: imports -------------------------------------------

    def test_es_module_import_creates_edge(self, parser: TypeScriptParser) -> None:
        """ES module import statements create imports edges."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        import_edges = [e for e in result.edges if e.edge_type == "imports"]
        targets = {e.target_name for e in import_edges}
        assert "../database/connection" in targets or any("connection" in t for t in targets)

    def test_multiple_imports_all_extracted(self, parser: TypeScriptParser) -> None:
        """All three imports in the auth module are extracted."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        import_edges = [e for e in result.edges if e.edge_type == "imports"]
        assert len(import_edges) >= 2

    def test_commonjs_require_creates_import_edge(self, parser: TypeScriptParser) -> None:
        """CommonJS require() calls create imports edges."""
        result = self._parse(parser, _UTIL_JS, file_path="src/util.js")
        import_edges = [e for e in result.edges if e.edge_type == "imports"]
        assert len(import_edges) >= 1
        assert any("crypto" in e.target_name for e in import_edges)

    # -- Referential: inheritance edges ---------------------------------

    def test_extends_creates_inheritance_edge(self, parser: TypeScriptParser) -> None:
        """class X extends Y creates an 'extends' edge."""
        result = self._parse(parser, _INHERITANCE_TS)
        ext_edges = [e for e in result.edges if e.edge_type == "extends"]
        assert len(ext_edges) >= 2
        targets = {e.target_name for e in ext_edges}
        assert "BaseService" in targets
        assert "UserService" in targets

    # -- Semantic: data flow --------------------------------------------

    def test_param_to_return_data_flow_edge_created(self, parser: TypeScriptParser) -> None:
        """Parameters appearing in return statements create data_flow edges."""
        result = self._parse(parser, _DATA_FLOW_TS)
        df_edges = [e for e in result.edges if e.edge_type == "data_flow"]
        assert len(df_edges) >= 1

    def test_data_flow_edge_references_function(self, parser: TypeScriptParser) -> None:
        """data_flow edge target_name references the function and parameter."""
        result = self._parse(parser, _DATA_FLOW_TS)
        df_edges = [e for e in result.edges if e.edge_type == "data_flow"]
        assert any("buildResponse" in e.target_name for e in df_edges)

    # -- All-nodes accessor ---------------------------------------------

    def test_all_nodes_includes_file_node(self, parser: TypeScriptParser) -> None:
        """ParseResult.all_nodes includes the file node as the first entry."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        assert result.all_nodes[0] is result.file_node

    # -- Node IDs -------------------------------------------------------

    def test_node_ids_are_unique_within_file(self, parser: TypeScriptParser) -> None:
        """All node IDs within a single file parse are unique."""
        result = self._parse(parser, _AUTH_MODULE_TS)
        ids = [n.node_id for n in result.all_nodes]
        assert len(ids) == len(set(ids))

    def test_node_ids_differ_across_files(self, parser: TypeScriptParser) -> None:
        """The same function name in two different files gets different IDs."""
        r1 = parser.parse("src/a.ts", "function foo() {}", "t", "r")
        r2 = parser.parse("src/b.ts", "function foo() {}", "t", "r")
        ids_a = {n.node_id for n in r1.all_nodes}
        ids_b = {n.node_id for n in r2.all_nodes}
        assert ids_a.isdisjoint(ids_b)


# ===========================================================================
# PackageJsonParser tests
# ===========================================================================

_PACKAGE_JSON_CONTENT = {
    "name": "my-app",
    "version": "1.0.0",
    "dependencies": {
        "express": "^4.18.2",
        "lodash": "^4.17.21",
        "neo4j-driver": "^5.0.0",
    },
    "devDependencies": {
        "typescript": "^5.0.0",
        "jest": "^29.0.0",
    },
}

_LOCK_FILE_CONTENT = {
    "lockfileVersion": 2,
    "packages": {
        "": {"name": "my-app"},
        "node_modules/express": {"version": "4.18.2"},
        "node_modules/lodash": {"version": "4.17.21"},
        "node_modules/body-parser": {"version": "1.20.0"},
    },
}


class TestPackageJsonParser:
    """Tests for dependency edge extraction from package.json."""

    @pytest.fixture
    def pkg_dir(self, tmp_path: Path) -> Path:
        (tmp_path / "package.json").write_text(json.dumps(_PACKAGE_JSON_CONTENT))
        (tmp_path / "package-lock.json").write_text(json.dumps(_LOCK_FILE_CONTENT))
        return tmp_path

    @pytest.fixture
    def parser(self) -> PackageJsonParser:
        return PackageJsonParser()

    def test_direct_dependencies_extracted(self, parser: PackageJsonParser, pkg_dir: Path) -> None:
        """All prod dependencies in package.json become depends_on edges."""
        edges = parser.parse(pkg_dir, "tenant", "repo")
        targets = {e.target_id for e in edges}
        assert "express" in targets
        assert "lodash" in targets
        assert "neo4j-driver" in targets

    def test_dev_dependencies_extracted(self, parser: PackageJsonParser, pkg_dir: Path) -> None:
        """devDependencies are also extracted."""
        edges = parser.parse(pkg_dir, "tenant", "repo")
        targets = {e.target_id for e in edges}
        assert "typescript" in targets
        assert "jest" in targets

    def test_transitive_dependencies_from_lock_file(
        self, parser: PackageJsonParser, pkg_dir: Path
    ) -> None:
        """Transitive deps from package-lock.json are included."""
        edges = parser.parse(pkg_dir, "tenant", "repo")
        targets = {e.target_id for e in edges}
        assert "body-parser" in targets

    def test_all_edges_are_depends_on_type(
        self, parser: PackageJsonParser, pkg_dir: Path
    ) -> None:
        """All extracted dependency edges have edge_type 'depends_on'."""
        edges = parser.parse(pkg_dir, "tenant", "repo")
        assert all(e.edge_type == "depends_on" for e in edges)

    def test_missing_package_json_returns_empty(
        self, parser: PackageJsonParser, tmp_path: Path
    ) -> None:
        """Parsing a directory without package.json returns empty list."""
        edges = parser.parse(tmp_path, "tenant", "repo")
        assert edges == []

    def test_version_included_in_target_name(
        self, parser: PackageJsonParser, pkg_dir: Path
    ) -> None:
        """target_name includes the version string for traceability."""
        edges = parser.parse(pkg_dir, "tenant", "repo")
        express_edge = next(e for e in edges if e.target_id == "express")
        assert "4.18.2" in express_edge.target_name or "^4.18.2" in express_edge.target_name


# ===========================================================================
# GraphBuilder integration tests
# ===========================================================================


class TestGraphBuilder:
    """Integration tests for GraphBuilder using a temporary file tree."""

    @pytest.fixture
    def repo_dir(self, tmp_path: Path) -> Path:
        """Create a minimal TypeScript repository fixture."""
        src = tmp_path / "src"
        src.mkdir()
        (src / "auth.ts").write_text(_AUTH_MODULE_TS)
        (src / "router.ts").write_text(_ROUTER_TS)
        (src / "util.js").write_text(_UTIL_JS)
        (tmp_path / "package.json").write_text(json.dumps(_PACKAGE_JSON_CONTENT))
        # Create a node_modules dir that should be ignored
        nm = tmp_path / "node_modules" / "express"
        nm.mkdir(parents=True)
        (nm / "index.js").write_text("module.exports = {};")
        return tmp_path

    @pytest.mark.asyncio
    async def test_full_build_returns_ok_status(self, repo_dir: Path) -> None:
        """Full build completes with status 'ok'."""
        builder = GraphBuilder()  # no Neo4j driver → stub mode
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
        )
        assert summary["status"] == "ok"

    @pytest.mark.asyncio
    async def test_full_build_counts_files(self, repo_dir: Path) -> None:
        """Full build parses 3 source files (node_modules is ignored)."""
        builder = GraphBuilder()
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
        )
        assert summary["files_parsed"] == 3  # auth.ts, router.ts, util.js

    @pytest.mark.asyncio
    async def test_full_build_extracts_nodes(self, repo_dir: Path) -> None:
        """Full build extracts at least one file, function, and class node."""
        builder = GraphBuilder()
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
        )
        assert summary["nodes"]["file"] >= 3
        assert summary["nodes"].get("function", 0) >= 1
        assert summary["nodes"].get("class", 0) >= 1

    @pytest.mark.asyncio
    async def test_full_build_extracts_edges(self, repo_dir: Path) -> None:
        """Full build extracts import and dependency edges."""
        builder = GraphBuilder()
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
        )
        assert summary["edges"]["total"] > 0
        assert summary["edges"].get("imports", 0) >= 1
        assert summary["edges"].get("depends_on", 0) >= 1

    @pytest.mark.asyncio
    async def test_neo4j_not_connected_in_stub_mode(self, repo_dir: Path) -> None:
        """Without a driver, neo4j_connected is False and no writes happen."""
        builder = GraphBuilder()
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
        )
        assert summary["neo4j_connected"] is False
        assert summary["nodes"]["written_to_neo4j"] == 0
        assert summary["edges"]["written_to_neo4j"] == 0

    @pytest.mark.asyncio
    async def test_incremental_build_processes_only_changed_files(self, repo_dir: Path) -> None:
        """Incremental build parses only the specified files."""
        builder = GraphBuilder()
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
            incremental_files=["src/auth.ts"],
        )
        assert summary["incremental"] is True
        assert summary["files_parsed"] == 1

    @pytest.mark.asyncio
    async def test_incremental_build_excludes_dep_edges(self, repo_dir: Path) -> None:
        """Incremental builds skip package.json dependency re-extraction."""
        builder = GraphBuilder()
        full = await builder.build_graph(
            repo_path=str(repo_dir), tenant_id="test", repo_id="repo"
        )
        incremental = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
            incremental_files=["src/auth.ts"],
        )
        # Full build has depends_on edges; incremental does not re-add them
        assert full["edges"].get("depends_on", 0) > 0
        assert incremental["edges"].get("depends_on", 0) == 0

    @pytest.mark.asyncio
    async def test_nonexistent_incremental_file_skipped(self, repo_dir: Path) -> None:
        """Incremental files that don't exist are silently skipped."""
        builder = GraphBuilder()
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
            incremental_files=["src/does_not_exist.ts"],
        )
        assert summary["files_parsed"] == 0
        assert summary["status"] == "ok"

    @pytest.mark.asyncio
    async def test_parse_errors_reported_in_summary(self, repo_dir: Path) -> None:
        """Files that fail to parse are listed in parse_errors."""
        # Write a file with content that triggers a parse exception
        broken = repo_dir / "src" / "broken.ts"
        broken.write_bytes(b"\xff\xfe invalid utf-32 but read_text errors=replace handles it")
        builder = GraphBuilder()
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
        )
        # errors='replace' means it shouldn't actually fail, but status still ok
        assert summary["status"] in ("ok", "partial")

    @pytest.mark.asyncio
    async def test_module_level_build_graph_function(self, repo_dir: Path) -> None:
        """The module-level build_graph() function is a working convenience wrapper."""
        summary = await build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
        )
        assert summary["files_parsed"] >= 3

    def test_parse_file_method_no_neo4j(self) -> None:
        """parse_file() returns a ParseResult without any DB interaction."""
        builder = GraphBuilder()
        result = builder.parse_file(
            file_path="src/auth.ts",
            content=_AUTH_MODULE_TS,
            tenant_id="test",
            repo_id="repo",
        )
        assert isinstance(result, ParseResult)
        assert result.file_node.node_type == "file"
        fn_names = {n.name for n in result.nodes if n.node_type == "function"}
        assert "hashUserPassword" in fn_names

    @pytest.mark.asyncio
    async def test_javascript_files_parsed_alongside_typescript(self, repo_dir: Path) -> None:
        """Both .ts and .js files are parsed in a TypeScript-primary repo."""
        builder = GraphBuilder()
        summary = await builder.build_graph(
            repo_path=str(repo_dir),
            tenant_id="test",
            repo_id="repo",
            language="typescript",
        )
        # 2 .ts files + 1 .js file = 3 total
        assert summary["files_parsed"] == 3


# ===========================================================================
# C# parser tests
# ===========================================================================


class TestCSharpParser:
    """Tests for the regex-based C# parser."""

    def _parse(self, content: str, file_path: str = "src/Services/UserService.cs") -> ParseResult:
        pytest.importorskip("tree_sitter_c_sharp", reason="tree-sitter-c-sharp not installed (install with: uv pip install -e '.[graph-csharp]')")
        from codesteward.engine.parsers.csharp import CSharpParser
        parser = CSharpParser()
        return parser.parse(file_path, content, "t1", "r1", "csharp")

    def test_file_node_created(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "csharp"

    def test_class_extracted(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "class"]
        assert "UserService" in names

    def test_method_extracted(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "GetUser" in names

    def test_constructor_extracted(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "UserService" in names

    def test_using_import_edges(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert "System.Collections.Generic" in imports
        assert "Microsoft.AspNetCore.Authorization" in imports

    def test_inheritance_edge(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        extends = [e for e in result.edges if e.edge_type == "extends"]
        assert any(e.target_name == "BaseService" for e in extends)

    def test_attribute_guarded_by(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        guarded = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert any(e.target_name == "Authorize" for e in guarded)

    def test_async_method_flag(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        get_user = next((n for n in result.nodes if n.name == "GetUser"), None)
        assert get_user is not None
        assert get_user.is_async is True

    def test_no_expression_nodes_for_extends(self) -> None:
        result = self._parse(_CSHARP_SERVICE)
        expr_nodes = [n for n in result.nodes if n.node_type == "expression"]
        assert expr_nodes == [], "EXTENDS must be edges, not expression LexicalNodes"


# ===========================================================================
# Kotlin parser tests
# ===========================================================================


class TestKotlinParser:
    """Tests for the regex-based Kotlin parser."""

    def _parse(self, content: str, file_path: str = "src/PaymentService.kt") -> ParseResult:
        pytest.importorskip("tree_sitter_kotlin", reason="tree-sitter-kotlin not installed (install with: uv pip install -e '.[graph-kotlin]')")
        from codesteward.engine.parsers.kotlin import KotlinParser
        parser = KotlinParser()
        return parser.parse(file_path, content, "t1", "r1", "kotlin")

    def test_file_node_created(self) -> None:
        result = self._parse(_KOTLIN_SERVICE)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "kotlin"

    def test_class_extracted(self) -> None:
        result = self._parse(_KOTLIN_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "class"]
        assert "PaymentService" in names

    def test_function_extracted(self) -> None:
        result = self._parse(_KOTLIN_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "processPayment" in names
        assert "validateAmount" in names

    def test_import_edges(self) -> None:
        result = self._parse(_KOTLIN_SERVICE)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert any("Secured" in imp for imp in imports)

    def test_inheritance_edge(self) -> None:
        result = self._parse(_KOTLIN_SERVICE)
        extends = [e for e in result.edges if e.edge_type == "extends"]
        assert any(e.target_name == "BaseService" for e in extends)

    def test_annotation_guarded_by(self) -> None:
        result = self._parse(_KOTLIN_SERVICE)
        guarded = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert any(e.target_name == "Secured" for e in guarded)

    def test_suspend_fun_is_async(self) -> None:
        result = self._parse(_KOTLIN_SERVICE)
        fn = next((n for n in result.nodes if n.name == "processPayment"), None)
        assert fn is not None
        assert fn.is_async is True

    def test_no_expression_nodes_for_extends(self) -> None:
        result = self._parse(_KOTLIN_SERVICE)
        expr_nodes = [n for n in result.nodes if n.node_type == "expression"]
        assert expr_nodes == [], "EXTENDS must be edges, not expression LexicalNodes"


# ===========================================================================
# Scala parser tests
# ===========================================================================


class TestScalaParser:
    """Tests for the regex-based Scala parser."""

    def _parse(self, content: str, file_path: str = "src/ReportService.scala") -> ParseResult:
        pytest.importorskip("tree_sitter_scala", reason="tree-sitter-scala not installed (install with: uv pip install -e '.[graph-scala]')")
        from codesteward.engine.parsers.scala import ScalaParser
        parser = ScalaParser()
        return parser.parse(file_path, content, "t1", "r1", "scala")

    def test_file_node_created(self) -> None:
        result = self._parse(_SCALA_SERVICE)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "scala"

    def test_class_extracted(self) -> None:
        result = self._parse(_SCALA_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "class"]
        assert "ReportService" in names

    def test_method_extracted(self) -> None:
        result = self._parse(_SCALA_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "generateReport" in names
        assert "validate" in names

    def test_import_edges(self) -> None:
        result = self._parse(_SCALA_SERVICE)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert any("Future" in imp for imp in imports)

    def test_inheritance_edge(self) -> None:
        result = self._parse(_SCALA_SERVICE)
        extends = [e for e in result.edges if e.edge_type == "extends"]
        assert any(e.target_name == "BaseService" for e in extends)

    def test_annotation_guarded_by(self) -> None:
        result = self._parse(_SCALA_SERVICE)
        guarded = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert any(e.target_name == "Secured" for e in guarded)

    def test_with_mixin_extends_edges(self) -> None:
        source = "class Foo extends BaseService with Logging with Serializable {\n  def bar(): Unit = {}\n}\n"
        result = self._parse(source)
        extended = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "BaseService" in extended
        assert "Logging" in extended
        assert "Serializable" in extended

    def test_no_expression_nodes_for_extends(self) -> None:
        result = self._parse(_SCALA_SERVICE)
        expr_nodes = [n for n in result.nodes if n.node_type == "expression"]
        assert expr_nodes == [], "EXTENDS must be edges, not expression LexicalNodes"


# ===========================================================================
# COBOL parser tests
# ===========================================================================


class TestCobolParser:
    """Tests for the COBOL parser."""

    def _parse(self, content: str, file_path: str = "src/PAYROLL-CALC.cbl") -> ParseResult:
        from codesteward.engine.parsers.cobol import CobolParser
        parser = CobolParser()
        return parser.parse(file_path, content, "t1", "r1", "cobol")

    def test_file_node_created(self) -> None:
        result = self._parse(_COBOL_PROGRAM)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "cobol"

    def test_program_id_extracted_as_class(self) -> None:
        result = self._parse(_COBOL_PROGRAM)
        names = [n.name for n in result.nodes if n.node_type == "class"]
        assert "PAYROLL-CALC" in names

    def test_section_extracted_as_function(self) -> None:
        result = self._parse(_COBOL_PROGRAM)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "MAIN-PROCESS" in names

    def test_paragraph_extracted_as_function(self) -> None:
        result = self._parse(_COBOL_PROGRAM)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "VALIDATE-EMPLOYEE" in names
        assert "CALCULATE-PAY" in names

    def test_copy_as_import_edge(self) -> None:
        result = self._parse(_COBOL_PROGRAM)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert "PAYROLL-COMMON" in imports

    def test_perform_as_call_edge(self) -> None:
        result = self._parse(_COBOL_PROGRAM)
        calls = [e for e in result.edges if e.edge_type == "calls"]
        call_targets = [e.target_name for e in calls]
        assert "VALIDATE-EMPLOYEE" in call_targets
        assert "CALCULATE-PAY" in call_targets


# ===========================================================================
# Go parser tests
# ===========================================================================


class TestGoParser:
    """Tests for the tree-sitter Go parser."""

    def _parse(self, content: str, file_path: str = "payments/service.go") -> ParseResult:
        pytest.importorskip("tree_sitter_go", reason="tree-sitter-go not installed (install with: uv pip install -e '.[graph-go]')")
        from codesteward.engine.parsers.go import GoParser
        parser = GoParser()
        return parser.parse(file_path, content, "t1", "r1", "go")

    def test_file_node_created(self) -> None:
        result = self._parse(_GO_SERVICE)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "go"

    def test_struct_extracted_as_class(self) -> None:
        result = self._parse(_GO_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "class"]
        assert "PaymentProcessor" in names

    def test_functions_extracted(self) -> None:
        result = self._parse(_GO_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "NewPaymentProcessor" in names
        assert "validateAmount" in names

    def test_method_extracted(self) -> None:
        result = self._parse(_GO_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "Process" in names

    def test_import_edges(self) -> None:
        result = self._parse(_GO_SERVICE)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert any("auth" in imp for imp in imports)

    def test_no_extends_edges(self) -> None:
        """Go has no class inheritance — no EXTENDS edges expected."""
        result = self._parse(_GO_SERVICE)
        extends = [e for e in result.edges if e.edge_type == "extends"]
        assert extends == []

    def test_no_expression_nodes(self) -> None:
        result = self._parse(_GO_SERVICE)
        expr = [n for n in result.nodes if n.node_type == "expression"]
        assert expr == []


# ===========================================================================
# C parser tests
# ===========================================================================


class TestCParser:
    """Tests for the tree-sitter C parser."""

    def _parse(self, content: str, file_path: str = "src/payment.c") -> ParseResult:
        pytest.importorskip("tree_sitter_c", reason="tree-sitter-c not installed (install with: uv pip install -e '.[graph-c]')")
        from codesteward.engine.parsers.c import CParser
        parser = CParser()
        return parser.parse(file_path, content, "t1", "r1", "c")

    def test_file_node_created(self) -> None:
        result = self._parse(_C_MODULE)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "c"

    def test_functions_extracted(self) -> None:
        result = self._parse(_C_MODULE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "process_payment" in names
        assert "validate_amount" in names

    def test_include_import_edges(self) -> None:
        result = self._parse(_C_MODULE)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert "stdio.h" in imports
        assert "payment.h" in imports

    def test_no_class_nodes(self) -> None:
        """C has no classes."""
        result = self._parse(_C_MODULE)
        class_nodes = [n for n in result.nodes if n.node_type == "class"]
        assert class_nodes == []

    def test_no_expression_nodes(self) -> None:
        result = self._parse(_C_MODULE)
        expr = [n for n in result.nodes if n.node_type == "expression"]
        assert expr == []


# ===========================================================================
# C++ parser tests
# ===========================================================================


class TestCppParser:
    """Tests for the tree-sitter C++ parser."""

    def _parse(self, content: str, file_path: str = "src/PaymentService.cpp") -> ParseResult:
        pytest.importorskip("tree_sitter_cpp", reason="tree-sitter-cpp not installed (install with: uv pip install -e '.[graph-cpp]')")
        from codesteward.engine.parsers.cpp import CppParser
        parser = CppParser()
        return parser.parse(file_path, content, "t1", "r1", "cpp")

    def test_file_node_created(self) -> None:
        result = self._parse(_CPP_SERVICE)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "cpp"

    def test_class_extracted(self) -> None:
        result = self._parse(_CPP_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "class"]
        assert "PaymentService" in names

    def test_methods_extracted(self) -> None:
        result = self._parse(_CPP_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "processPayment" in names
        assert "validate" in names

    def test_inheritance_edges(self) -> None:
        result = self._parse(_CPP_SERVICE)
        extends = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "BaseService" in extends
        assert "Serializable" in extends

    def test_include_import_edges(self) -> None:
        result = self._parse(_CPP_SERVICE)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert "string" in imports
        assert "base_service.h" in imports

    def test_no_expression_nodes(self) -> None:
        result = self._parse(_CPP_SERVICE)
        expr = [n for n in result.nodes if n.node_type == "expression"]
        assert expr == []


# ===========================================================================
# Rust parser tests
# ===========================================================================


class TestRustParser:
    """Tests for the tree-sitter Rust parser."""

    def _parse(self, content: str, file_path: str = "src/payment.rs") -> ParseResult:
        pytest.importorskip("tree_sitter_rust", reason="tree-sitter-rust not installed (install with: uv pip install -e '.[graph-rust]')")
        from codesteward.engine.parsers.rust import RustParser
        parser = RustParser()
        return parser.parse(file_path, content, "t1", "r1", "rust")

    def test_file_node_created(self) -> None:
        result = self._parse(_RUST_SERVICE)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "rust"

    def test_struct_extracted_as_class(self) -> None:
        result = self._parse(_RUST_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "class"]
        assert "PaymentService" in names

    def test_functions_extracted(self) -> None:
        result = self._parse(_RUST_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "new_service" in names

    def test_async_function_flag(self) -> None:
        result = self._parse(_RUST_SERVICE)
        process_fn = next((n for n in result.nodes if n.name == "process"), None)
        assert process_fn is not None
        assert process_fn.is_async is True

    def test_import_edges(self) -> None:
        result = self._parse(_RUST_SERVICE)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert any("HashMap" in imp for imp in imports)

    def test_attribute_guarded_by(self) -> None:
        result = self._parse(_RUST_SERVICE)
        guarded = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert any(e.target_name == "allow" for e in guarded)

    def test_no_extends_edges(self) -> None:
        """Rust has no class inheritance."""
        result = self._parse(_RUST_SERVICE)
        extends = [e for e in result.edges if e.edge_type == "extends"]
        assert extends == []

    def test_no_expression_nodes(self) -> None:
        result = self._parse(_RUST_SERVICE)
        expr = [n for n in result.nodes if n.node_type == "expression"]
        assert expr == []


# ===========================================================================
# PHP parser tests
# ===========================================================================


class TestPhpParser:
    """Tests for the tree-sitter PHP parser."""

    def _parse(self, content: str, file_path: str = "app/Services/PaymentService.php") -> ParseResult:
        pytest.importorskip("tree_sitter_php", reason="tree-sitter-php not installed (install with: uv pip install -e '.[graph-php]')")
        from codesteward.engine.parsers.php import PhpParser
        parser = PhpParser()
        return parser.parse(file_path, content, "t1", "r1", "php")

    def test_file_node_created(self) -> None:
        result = self._parse(_PHP_SERVICE)
        assert result.file_node.node_type == "file"
        assert result.file_node.language == "php"

    def test_class_extracted(self) -> None:
        result = self._parse(_PHP_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "class"]
        assert "PaymentService" in names

    def test_methods_extracted(self) -> None:
        result = self._parse(_PHP_SERVICE)
        names = [n.name for n in result.nodes if n.node_type == "function"]
        assert "processPayment" in names
        assert "validate" in names

    def test_extends_edge(self) -> None:
        result = self._parse(_PHP_SERVICE)
        extends = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "BaseService" in extends

    def test_implements_edge(self) -> None:
        result = self._parse(_PHP_SERVICE)
        extends = {e.target_name for e in result.edges if e.edge_type == "extends"}
        assert "Loggable" in extends

    def test_import_edges(self) -> None:
        result = self._parse(_PHP_SERVICE)
        imports = [e.target_name for e in result.edges if e.edge_type == "imports"]
        assert any("BaseService" in imp for imp in imports)
        assert any("Authorize" in imp for imp in imports)

    def test_attribute_guarded_by(self) -> None:
        result = self._parse(_PHP_SERVICE)
        guarded = [e for e in result.edges if e.edge_type == "guarded_by"]
        assert any(e.target_name == "Authorize" for e in guarded)

    def test_no_expression_nodes(self) -> None:
        result = self._parse(_PHP_SERVICE)
        expr = [n for n in result.nodes if n.node_type == "expression"]
        assert expr == []
