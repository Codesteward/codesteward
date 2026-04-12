"""Tests for taint-source node and edge emission across all language parsers.

Each parser class is exercised directly (not via TreeSitterParser) so that
grammar-specific ``importorskip`` checks are co-located with the test and the
required grammar packages are optional.
"""

from typing import Any

import pytest

pytest.importorskip("tree_sitter", reason="tree-sitter not installed")

# ---------------------------------------------------------------------------
# C — CGI + Mongoose + libmicrohttpd
# ---------------------------------------------------------------------------

_C_CGI_SOURCE = """\
#include <stdlib.h>
#include <stdio.h>

void handle_request() {
    const char *qs = getenv("QUERY_STRING");
    const char *cookie = getenv("HTTP_COOKIE");
    char buf[1024];
    fread(buf, 1, 1024, stdin);
}
"""

_C_MONGOOSE_SOURCE = """\
#include "mongoose.h"

void handle_event(struct mg_connection *c, int ev, void *ev_data) {
    struct mg_http_message *hm = (struct mg_http_message *) ev_data;
    mg_http_get_var(&hm->query, "name", buf, sizeof(buf));
    mg_http_get_header(hm, "Authorization");
}
"""

_C_NO_HTTP_SOURCE = """\
#include <stdlib.h>

void util_func() {
    const char *path = getenv("PATH");
    int x = 1 + 2;
}
"""

_C_FGETS_SOURCE = """\
#include <stdio.h>

void handle_post() {
    char buf[256];
    fgets(buf, sizeof(buf), stdin);
}
"""


class TestCTaintSources:
    """_extract_c_taint_sources emits external nodes + calls edges for C HTTP input."""

    @pytest.fixture
    def parser(self) -> Any:
        pytest.importorskip("tree_sitter_c", reason="tree-sitter-c not installed")
        from codesteward.engine.parsers.c import CParser
        return CParser()

    def test_cgi_getenv_query_string_emits_source(self, parser: Any) -> None:
        """getenv('QUERY_STRING') produces a taint-source node."""
        result = parser.parse("main.c", _C_CGI_SOURCE, "t", "r")
        external = [n for n in result.nodes if n.node_type == "external"]
        names = {n.name for n in external}
        assert any("QUERY_STRING" in n for n in names)

    def test_cgi_getenv_http_cookie_emits_source(self, parser: Any) -> None:
        """getenv('HTTP_COOKIE') produces a taint-source node."""
        result = parser.parse("main.c", _C_CGI_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("HTTP_COOKIE" in n for n in names)

    def test_fread_stdin_emits_source(self, parser: Any) -> None:
        """fread(buf, 1, n, stdin) produces a taint-source node."""
        result = parser.parse("main.c", _C_CGI_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("stdin" in n for n in names)

    def test_calls_edges_point_at_handler(self, parser: Any) -> None:
        """The taint CALLS edge target_name is the enclosing function name."""
        result = parser.parse("main.c", _C_CGI_SOURCE, "t", "r")
        external_ids = {n.node_id for n in result.nodes if n.node_type == "external"}
        taint_calls = [e for e in result.edges if e.edge_type == "calls" and e.source_id in external_ids]
        assert len(taint_calls) >= 1
        assert all(e.target_name == "handle_request" for e in taint_calls)

    def test_mongoose_functions_emit_source(self, parser: Any) -> None:
        """mg_http_get_var and mg_http_get_header always emit taint sources."""
        result = parser.parse("net.c", _C_MONGOOSE_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("mg_http" in n for n in names)

    def test_non_http_getenv_no_source(self, parser: Any) -> None:
        """getenv('PATH') must NOT produce a taint-source node."""
        result = parser.parse("util.c", _C_NO_HTTP_SOURCE, "t", "r")
        external = [n for n in result.nodes if n.node_type == "external"]
        assert len(external) == 0

    def test_source_node_file_is_c_http(self, parser: Any) -> None:
        """Synthetic taint nodes carry file='c_http'."""
        result = parser.parse("main.c", _C_CGI_SOURCE, "t", "r")
        for n in result.nodes:
            if n.node_type == "external":
                assert n.file == "c_http"

    def test_no_duplicate_source_nodes(self, parser: Any) -> None:
        """Each distinct source name produces exactly one external node."""
        result = parser.parse("main.c", _C_CGI_SOURCE, "t", "r")
        ids = [n.node_id for n in result.nodes if n.node_type == "external"]
        assert len(ids) == len(set(ids))

    def test_fgets_stdin_emits_source(self, parser: Any) -> None:
        """fgets(buf, n, stdin) produces a taint-source node."""
        result = parser.parse("post.c", _C_FGETS_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("stdin" in n for n in names)

    def test_c_file_node_emitted(self, parser: Any) -> None:
        """Parsing always produces a file node."""
        result = parser.parse("main.c", _C_CGI_SOURCE, "t", "r")
        assert result.file_node.node_type == "file"
        assert result.file_node.name == "main.c"

    def test_function_node_extracted(self, parser: Any) -> None:
        """Function definitions produce function nodes."""
        result = parser.parse("main.c", _C_CGI_SOURCE, "t", "r")
        fn_nodes = [n for n in result.nodes if n.node_type == "function"]
        assert any(n.name == "handle_request" for n in fn_nodes)


# ---------------------------------------------------------------------------
# C++ — CGI + Crow + Drogon
# ---------------------------------------------------------------------------

_CPP_DROGON_SOURCE = """\
#include <drogon/drogon.h>

void handle(const drogon::HttpRequestPtr &req, Callback callback) {
    auto body = req->getBody();
    auto param = req->getParameter("name");
    auto header = req->getHeader("Authorization");
}
"""

_CPP_CROW_SOURCE = """\
#include <crow.h>

void handle(const crow::request &req, crow::response &res) {
    auto body = req.body;
    auto params = req.url_params;
}
"""

_CPP_CGI_SOURCE = """\
#include <stdlib.h>

void handle_cgi() {
    const char *qs = getenv("QUERY_STRING");
}
"""


class TestCppTaintSources:
    """_extract_cpp_taint_sources emits external nodes + calls edges for C++ HTTP frameworks."""

    @pytest.fixture
    def parser(self) -> Any:
        pytest.importorskip("tree_sitter_cpp", reason="tree-sitter-cpp not installed")
        from codesteward.engine.parsers.cpp import CppParser
        return CppParser()

    def test_drogon_getbody_emits_source(self, parser: Any) -> None:
        """req->getBody() triggers a cpp_http.getBody taint-source node."""
        result = parser.parse("handler.cpp", _CPP_DROGON_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("getBody" in n for n in names)

    def test_drogon_get_parameter_emits_source(self, parser: Any) -> None:
        """req->getParameter() triggers a taint-source node."""
        result = parser.parse("handler.cpp", _CPP_DROGON_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("getParameter" in n for n in names)

    def test_crow_body_field_emits_source(self, parser: Any) -> None:
        """req.body field access triggers a taint-source node."""
        result = parser.parse("handler.cpp", _CPP_CROW_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("body" in n for n in names)

    def test_cpp_cgi_getenv_emits_source(self, parser: Any) -> None:
        """getenv('QUERY_STRING') in C++ file also emits a taint source."""
        result = parser.parse("cgi.cpp", _CPP_CGI_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("QUERY_STRING" in n for n in names)

    def test_calls_edge_points_at_handler(self, parser: Any) -> None:
        """Taint CALLS edge target is the enclosing handler function."""
        result = parser.parse("handler.cpp", _CPP_DROGON_SOURCE, "t", "r")
        external_ids = {n.node_id for n in result.nodes if n.node_type == "external"}
        taint_calls = [e for e in result.edges if e.edge_type == "calls" and e.source_id in external_ids]
        assert len(taint_calls) >= 1

    def test_source_node_file_is_cpp_http(self, parser: Any) -> None:
        """Synthetic C++ taint nodes carry file='cpp_http'."""
        result = parser.parse("handler.cpp", _CPP_DROGON_SOURCE, "t", "r")
        for n in result.nodes:
            if n.node_type == "external":
                assert n.file == "cpp_http"

    def test_no_duplicate_source_nodes(self, parser: Any) -> None:
        """Identical taint sources are deduplicated."""
        result = parser.parse("handler.cpp", _CPP_DROGON_SOURCE, "t", "r")
        ids = [n.node_id for n in result.nodes if n.node_type == "external"]
        assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# C# — ASP.NET Core FromQuery / HttpRequest.Query
# ---------------------------------------------------------------------------

_CS_PARAM_ATTRS_SOURCE = """\
using Microsoft.AspNetCore.Mvc;

public class UserController : ControllerBase
{
    [HttpGet("search")]
    public IActionResult Search([FromQuery] string name, [FromBody] UserDto body)
    {
        return Ok(name);
    }

    [HttpPost("upload")]
    public IActionResult Upload([FromForm] IFormFile file, [FromHeader] string auth)
    {
        return Ok();
    }
}
"""

_CS_REQUEST_MEMBER_SOURCE = """\
using Microsoft.AspNetCore.Mvc;

public class MyController : ControllerBase
{
    public IActionResult Handle()
    {
        var q = Request.Query["name"];
        var b = Request.Form["field"];
        return Ok();
    }
}
"""


class TestCSharpTaintSources:
    """_extract_cs_taint_sources emits external nodes for ASP.NET Core input."""

    @pytest.fixture
    def parser(self) -> Any:
        pytest.importorskip("tree_sitter_c_sharp", reason="tree-sitter-c-sharp not installed")
        from codesteward.engine.parsers.csharp import CSharpParser
        return CSharpParser()

    def test_from_query_attr_emits_source(self, parser: Any) -> None:
        """[FromQuery] parameter emits an aspnetcore.FromQuery taint-source."""
        result = parser.parse("UserController.cs", _CS_PARAM_ATTRS_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("FromQuery" in n for n in names)

    def test_from_body_attr_emits_source(self, parser: Any) -> None:
        """[FromBody] parameter emits a taint-source."""
        result = parser.parse("UserController.cs", _CS_PARAM_ATTRS_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("FromBody" in n for n in names)

    def test_from_form_attr_emits_source(self, parser: Any) -> None:
        """[FromForm] parameter emits a taint-source."""
        result = parser.parse("UserController.cs", _CS_PARAM_ATTRS_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("FromForm" in n for n in names)

    def test_request_query_member_emits_source(self, parser: Any) -> None:
        """Request.Query[...] emits an aspnetcore.Request.Query taint-source."""
        result = parser.parse("MyController.cs", _CS_REQUEST_MEMBER_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Query" in n for n in names)

    def test_source_node_file_is_aspnetcore(self, parser: Any) -> None:
        """Synthetic C# taint nodes carry file='aspnetcore'."""
        result = parser.parse("UserController.cs", _CS_PARAM_ATTRS_SOURCE, "t", "r")
        for n in result.nodes:
            if n.node_type == "external":
                assert n.file == "aspnetcore"

    def test_calls_edges_emitted(self, parser: Any) -> None:
        """Each taint source emits at least one CALLS edge."""
        result = parser.parse("UserController.cs", _CS_PARAM_ATTRS_SOURCE, "t", "r")
        external_ids = {n.node_id for n in result.nodes if n.node_type == "external"}
        taint_calls = [e for e in result.edges if e.edge_type == "calls" and e.source_id in external_ids]
        assert len(taint_calls) >= 1

    def test_no_duplicate_source_nodes(self, parser: Any) -> None:
        """Identical sources are deduplicated."""
        result = parser.parse("UserController.cs", _CS_PARAM_ATTRS_SOURCE, "t", "r")
        ids = [n.node_id for n in result.nodes if n.node_type == "external"]
        assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# Rust — Actix-web / Axum extractors
# ---------------------------------------------------------------------------

_RUST_ACTIX_SOURCE = """\
use actix_web::{web, HttpResponse};

async fn get_user(path: web::Path<u32>, query: web::Query<UserQuery>) -> HttpResponse {
    HttpResponse::Ok().finish()
}

async fn create_user(body: web::Json<UserDto>) -> HttpResponse {
    HttpResponse::Ok().finish()
}
"""

_RUST_AXUM_SOURCE = """\
use axum::extract::{Path, Query, Json};

async fn handler(Path(id): Path<u32>, Query(params): Query<SearchQuery>) -> String {
    id.to_string()
}
"""


class TestRustTaintSources:
    """_extract_rust_taint_sources emits external nodes for Actix-web / Axum extractors."""

    @pytest.fixture
    def parser(self) -> Any:
        pytest.importorskip("tree_sitter_rust", reason="tree-sitter-rust not installed")
        from codesteward.engine.parsers.rust import RustParser
        return RustParser()

    def test_actix_path_extractor_emits_source(self, parser: Any) -> None:
        """web::Path<T> parameter emits a taint-source node."""
        result = parser.parse("handlers.rs", _RUST_ACTIX_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Path" in n for n in names)

    def test_actix_query_extractor_emits_source(self, parser: Any) -> None:
        """web::Query<T> parameter emits a taint-source node."""
        result = parser.parse("handlers.rs", _RUST_ACTIX_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Query" in n for n in names)

    def test_actix_json_extractor_emits_source(self, parser: Any) -> None:
        """web::Json<T> parameter emits a taint-source node."""
        result = parser.parse("handlers.rs", _RUST_ACTIX_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Json" in n for n in names)

    def test_axum_path_extractor_emits_source(self, parser: Any) -> None:
        """Axum extract::Path extractor emits a taint-source node."""
        result = parser.parse("handlers.rs", _RUST_AXUM_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Path" in n for n in names)

    def test_source_node_file_is_actix_axum(self, parser: Any) -> None:
        """Synthetic Rust taint nodes carry file='actix_axum'."""
        result = parser.parse("handlers.rs", _RUST_ACTIX_SOURCE, "t", "r")
        for n in result.nodes:
            if n.node_type == "external":
                assert n.file == "actix_axum"

    def test_calls_edges_emitted(self, parser: Any) -> None:
        """Each Rust extractor parameter produces a CALLS edge to the handler."""
        result = parser.parse("handlers.rs", _RUST_ACTIX_SOURCE, "t", "r")
        external_ids = {n.node_id for n in result.nodes if n.node_type == "external"}
        taint_calls = [e for e in result.edges if e.edge_type == "calls" and e.source_id in external_ids]
        assert len(taint_calls) >= 1

    def test_no_duplicate_source_nodes(self, parser: Any) -> None:
        """Identical extractor sources are deduplicated."""
        result = parser.parse("handlers.rs", _RUST_ACTIX_SOURCE, "t", "r")
        ids = [n.node_id for n in result.nodes if n.node_type == "external"]
        assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# PHP — superglobals + Laravel + Symfony
# ---------------------------------------------------------------------------

_PHP_SUPERGLOBAL_SOURCE = """\
<?php

function handle_request() {
    $name = $_GET['name'];
    $data = $_POST['data'];
    $cookie = $_COOKIE['session'];
}
"""

_PHP_LARAVEL_SOURCE = """\
<?php

use Illuminate\\Http\\Request;

function store(Request $request) {
    $name = $request->input('name');
    $file = $request->file('upload');
}
"""


class TestPhpTaintSources:
    """_extract_php_taint_sources emits external nodes for PHP HTTP input."""

    @pytest.fixture
    def parser(self) -> Any:
        pytest.importorskip("tree_sitter_php", reason="tree-sitter-php not installed")
        from codesteward.engine.parsers.php import PhpParser
        return PhpParser()

    def test_get_superglobal_emits_source(self, parser: Any) -> None:
        """$_GET access emits a taint-source node."""
        result = parser.parse("index.php", _PHP_SUPERGLOBAL_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("GET" in n for n in names)

    def test_post_superglobal_emits_source(self, parser: Any) -> None:
        """$_POST access emits a taint-source node."""
        result = parser.parse("index.php", _PHP_SUPERGLOBAL_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("POST" in n for n in names)

    def test_cookie_superglobal_emits_source(self, parser: Any) -> None:
        """$_COOKIE access emits a taint-source node."""
        result = parser.parse("index.php", _PHP_SUPERGLOBAL_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("COOKIE" in n for n in names)

    def test_laravel_input_method_emits_source(self, parser: Any) -> None:
        """$request->input() emits a taint-source node."""
        result = parser.parse("handler.php", _PHP_LARAVEL_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("input" in n for n in names)

    def test_calls_edges_point_at_handler(self, parser: Any) -> None:
        """Taint CALLS edges point at the enclosing function."""
        result = parser.parse("index.php", _PHP_SUPERGLOBAL_SOURCE, "t", "r")
        external_ids = {n.node_id for n in result.nodes if n.node_type == "external"}
        taint_calls = [e for e in result.edges if e.edge_type == "calls" and e.source_id in external_ids]
        assert len(taint_calls) >= 1
        assert all(e.target_name == "handle_request" for e in taint_calls)

    def test_source_node_file_is_php(self, parser: Any) -> None:
        """Synthetic PHP taint nodes carry file='php'."""
        result = parser.parse("index.php", _PHP_SUPERGLOBAL_SOURCE, "t", "r")
        for n in result.nodes:
            if n.node_type == "external":
                assert n.file == "php"

    def test_no_duplicate_source_nodes(self, parser: Any) -> None:
        """Identical sources are deduplicated."""
        result = parser.parse("index.php", _PHP_SUPERGLOBAL_SOURCE, "t", "r")
        ids = [n.node_id for n in result.nodes if n.node_type == "external"]
        assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# Kotlin — Spring Boot parameter annotations
# ---------------------------------------------------------------------------

_KOTLIN_SPRING_SOURCE = """\
import org.springframework.web.bind.annotation.*

@RestController
class UserController {

    @GetMapping("/users")
    fun listUsers(@RequestParam name: String, @RequestHeader auth: String): String {
        return name
    }

    @PostMapping("/users")
    fun createUser(@RequestBody body: UserDto): String {
        return body.name
    }
}
"""

_KOTLIN_KTOR_SOURCE = """\
import io.ktor.server.application.*
import io.ktor.server.routing.*

fun Route.userRoutes() {
    get("/users") {
        val name = call.request.queryParameters["name"]
        val body = call.receive<UserDto>()
    }
}
"""


class TestKotlinTaintSources:
    """_extract_kotlin_taint_sources emits external nodes for Kotlin HTTP frameworks."""

    @pytest.fixture
    def parser(self) -> Any:
        pytest.importorskip("tree_sitter_kotlin", reason="tree-sitter-kotlin not installed")
        from codesteward.engine.parsers.kotlin import KotlinParser
        return KotlinParser()

    def test_spring_request_param_emits_source(self, parser: Any) -> None:
        """@RequestParam annotation emits a taint-source node."""
        result = parser.parse("UserController.kt", _KOTLIN_SPRING_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("RequestParam" in n for n in names)

    def test_spring_request_body_emits_source(self, parser: Any) -> None:
        """@RequestBody annotation emits a taint-source node."""
        result = parser.parse("UserController.kt", _KOTLIN_SPRING_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("RequestBody" in n for n in names)

    def test_source_node_file_is_kotlin_http(self, parser: Any) -> None:
        """Synthetic Kotlin taint nodes carry file='kotlin_http'."""
        result = parser.parse("UserController.kt", _KOTLIN_SPRING_SOURCE, "t", "r")
        for n in result.nodes:
            if n.node_type == "external":
                assert n.file == "kotlin_http"

    def test_calls_edges_emitted(self, parser: Any) -> None:
        """Spring taint sources emit CALLS edges to handler functions."""
        result = parser.parse("UserController.kt", _KOTLIN_SPRING_SOURCE, "t", "r")
        external_ids = {n.node_id for n in result.nodes if n.node_type == "external"}
        taint_calls = [e for e in result.edges if e.edge_type == "calls" and e.source_id in external_ids]
        assert len(taint_calls) >= 1

    def test_no_duplicate_source_nodes(self, parser: Any) -> None:
        """Identical sources are deduplicated."""
        result = parser.parse("UserController.kt", _KOTLIN_SPRING_SOURCE, "t", "r")
        ids = [n.node_id for n in result.nodes if n.node_type == "external"]
        assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# Scala — Play framework + Akka HTTP
# ---------------------------------------------------------------------------

_SCALA_PLAY_SOURCE = """\
import play.api.mvc._

class UserController @Inject()(cc: ControllerComponents) extends AbstractController(cc) {

  def search = Action { request =>
    val name = request.queryString.get("name")
    val body = request.body.asJson
    Ok("done")
  }
}
"""

_SCALA_AKKA_SOURCE = """\
import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.server.Route

object Routes {
  def buildRoute(): Route =
    path("users") {
      parameters("name", "page") { (name, page) =>
        entity(as[String]) { body =>
          complete("ok")
        }
      }
    }
}
"""


class TestScalaTaintSources:
    """_extract_scala_taint_sources emits external nodes for Scala HTTP frameworks."""

    @pytest.fixture
    def parser(self) -> Any:
        pytest.importorskip("tree_sitter_scala", reason="tree-sitter-scala not installed")
        from codesteward.engine.parsers.scala import ScalaParser
        return ScalaParser()

    def test_play_query_string_emits_source(self, parser: Any) -> None:
        """request.queryString access emits a taint-source node."""
        result = parser.parse("UserController.scala", _SCALA_PLAY_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("queryString" in n or "body" in n for n in names)

    def test_akka_parameters_directive_emits_source(self, parser: Any) -> None:
        """Akka HTTP parameters() directive emits a taint-source node."""
        result = parser.parse("Routes.scala", _SCALA_AKKA_SOURCE, "t", "r")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("parameters" in n or "entity" in n for n in names)

    def test_source_node_file_is_scala_http(self, parser: Any) -> None:
        """Synthetic Scala taint nodes carry file='scala_http'."""
        result = parser.parse("UserController.scala", _SCALA_PLAY_SOURCE, "t", "r")
        for n in result.nodes:
            if n.node_type == "external":
                assert n.file == "scala_http"

    def test_no_duplicate_source_nodes(self, parser: Any) -> None:
        """Identical sources are deduplicated."""
        result = parser.parse("UserController.scala", _SCALA_PLAY_SOURCE, "t", "r")
        ids = [n.node_id for n in result.nodes if n.node_type == "external"]
        assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# TypeScript — NestJS parameter decorators
# ---------------------------------------------------------------------------

_TS_NESTJS_PARAM_SOURCE = """\
import { Controller, Get, Post, Body, Param, Query, Headers } from '@nestjs/common';

@Controller('users')
export class UserController {
  @Get(':id')
  getUser(@Param('id') id: string, @Query('filter') filter: string): string {
    return id;
  }

  @Post()
  createUser(@Body() dto: CreateUserDto, @Headers('authorization') auth: string): string {
    return 'created';
  }
}
"""


class TestTypeScriptNestJSTaintSources:
    """_extract_nestjs_taint_sources emits external nodes for NestJS param decorators."""

    @pytest.fixture
    def parser(self) -> Any:
        pytest.importorskip("tree_sitter_typescript", reason="tree-sitter-typescript not installed")
        from codesteward.engine.parsers.typescript import TypeScriptParser
        return TypeScriptParser()

    def test_param_decorator_emits_source(self, parser: Any) -> None:
        """@Param() decorator emits a nestjs.Param taint-source node."""
        result = parser.parse("user.controller.ts", _TS_NESTJS_PARAM_SOURCE, "t", "r", "typescript")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Param" in n for n in names)

    def test_query_decorator_emits_source(self, parser: Any) -> None:
        """@Query() decorator emits a nestjs.Query taint-source node."""
        result = parser.parse("user.controller.ts", _TS_NESTJS_PARAM_SOURCE, "t", "r", "typescript")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Query" in n for n in names)

    def test_body_decorator_emits_source(self, parser: Any) -> None:
        """@Body() decorator emits a nestjs.Body taint-source node."""
        result = parser.parse("user.controller.ts", _TS_NESTJS_PARAM_SOURCE, "t", "r", "typescript")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Body" in n for n in names)

    def test_headers_decorator_emits_source(self, parser: Any) -> None:
        """@Headers() decorator emits a nestjs.Headers taint-source node."""
        result = parser.parse("user.controller.ts", _TS_NESTJS_PARAM_SOURCE, "t", "r", "typescript")
        names = {n.name for n in result.nodes if n.node_type == "external"}
        assert any("Headers" in n for n in names)

    def test_source_node_file_is_nestjs(self, parser: Any) -> None:
        """Synthetic NestJS taint nodes carry file='nestjs'."""
        result = parser.parse("user.controller.ts", _TS_NESTJS_PARAM_SOURCE, "t", "r", "typescript")
        for n in result.nodes:
            if n.node_type == "external" and "nestjs" in n.name:
                assert n.file == "nestjs"

    def test_calls_edges_emitted(self, parser: Any) -> None:
        """Each NestJS param taint source emits a CALLS edge to the handler method."""
        result = parser.parse("user.controller.ts", _TS_NESTJS_PARAM_SOURCE, "t", "r", "typescript")
        external_ids = {n.node_id for n in result.nodes if n.node_type == "external"}
        taint_calls = [e for e in result.edges if e.edge_type == "calls" and e.source_id in external_ids]
        assert len(taint_calls) >= 1

    def test_no_duplicate_source_nodes(self, parser: Any) -> None:
        """Identical decorator sources are deduplicated across methods."""
        result = parser.parse("user.controller.ts", _TS_NESTJS_PARAM_SOURCE, "t", "r", "typescript")
        ids = [n.node_id for n in result.nodes if n.node_type == "external" and "nestjs" in n.name]
        assert len(ids) == len(set(ids))
