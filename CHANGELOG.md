# Changelog

All notable changes to `codesteward-graph` and `codesteward-mcp` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

Both packages share a version number and are always released together.

---

## [Unreleased]

---

## [0.4.0] — 2026-04-12

### Added — codesteward-graph

- **Graph backend abstraction layer** (`engine/backends/`): new `GraphBackend` ABC with a
  unified async interface for node/edge writes, named queries, and raw query passthrough.
  All tool functions are now backend-agnostic.
- **JanusGraph backend** (`backends/janusgraph.py`): Apache 2.0 licensed alternative to Neo4j.
  Connects via Gremlin (Apache TinkerPop `gremlinpython>=3.7`). Named query templates
  (`lexical`, `referential`, `semantic`, `dependency`) reimplemented in Gremlin. Raw query
  passthrough uses Gremlin instead of Cypher.
- **GraphQLite backend** (`backends/graphqlite.py`): embedded SQLite-based graph database
  (`graphqlite>=0.4`) — no server needed, ideal for local dev via `uvx`. Speaks Cypher
  (same templates as Neo4j). Database defaults to `~/.codesteward/graph.db`; override with
  `GRAPHQLITE_DB_PATH`.
- Neo4j backend extracted into `backends/neo4j.py` (same Cypher queries, now behind the
  `GraphBackend` interface).
- `get_backend()` factory in `backends/__init__.py` dispatches by `GRAPH_BACKEND` value.
- New optional dependency extras: `janusgraph` (gremlinpython) and `graphqlite` (graphqlite).

### Added — codesteward-mcp

- `GRAPH_BACKEND` environment variable to select the graph backend: `neo4j` (default),
  `janusgraph`, or `graphqlite`.
- `JANUSGRAPH_URL` environment variable for the Gremlin Server WebSocket URL.
- `GRAPHQLITE_DB_PATH` environment variable for the SQLite database file path.
- `gremlin` raw query type in `codebase_graph_query` for JanusGraph raw Gremlin passthrough.
  Cypher/Gremlin mismatch is rejected with a clear error.
- `docker-compose.janusgraph.yml` — drop-in JanusGraph stack (BerkeleyDB JE + Lucene,
  single-node, no external Cassandra/HBase required).
- `docker-compose.neo4j.yml` — renamed from the previous `docker-compose.yml` for clarity.
- Docker image now installs the `janusgraph` extra by default.
- New optional dependency extras on `codesteward-mcp`: `janusgraph` and `graphqlite`
  (re-exported from `codesteward-graph`).
- Global setup templates: Claude Code (`templates/global-claude-code/`) and OpenAI Codex
  (`templates/global-codex/`) with CLAUDE.md, skill file, settings snippet, and AGENTS.md.
- **`codesteward-mcp setup` subcommand** — one-time global setup that auto-detects installed
  AI tools (Claude Code, Cursor, Cline, Codex CLI, Gemini CLI), registers the MCP server in
  each tool's global config, and merges workflow instructions into CLAUDE.md / AGENTS.md /
  GEMINI.md. Idempotent — safe to re-run. `--uninstall` reverses all changes cleanly.
  `--backend` flag accepts `graphqlite` (default), `neo4j`, or `janusgraph`.
- **Cline support**: `.clinerules` template, Cline detection in `setup` command (cross-platform
  globalStorage path resolution), and Cline section in AGENT_SETUP.md with marketplace install
  instructions via `llms-install.md`.
- `docs/setup/` — per-tool setup guides (Claude Code, Cursor & Cline, Codex CLI, Gemini CLI,
  Windsurf / VS Code / Claude Desktop / Continue.dev, Docker + Neo4j / JanusGraph). Referenced
  from README.md Quick Start.

### Changed — codesteward-mcp

- **`GRAPH_BACKEND` default changed from `neo4j` to `auto`** — auto-detects the appropriate
  backend at startup: Neo4j if `NEO4J_PASSWORD` is set, JanusGraph if `JANUSGRAPH_URL` is
  non-default, otherwise GraphQLite. Existing deployments with explicit env vars are unaffected.
- Tool response fields renamed: `neo4j_connected` → `backend_connected`; new
  `graph_backend` field in `graph_rebuild` and `graph_status` responses.
- `_make_async_driver()` replaced by `_make_backend()` — returns a `GraphBackend` instance
  (or `None` for stub mode) instead of a raw Neo4j driver.
- `GraphBuilder` now accepts a `backend` parameter (the `GraphBackend` instance) instead of
  `neo4j_driver`.
- Cypher query templates moved from inline constants in `tools/graph.py` into each backend's
  `query_named()` implementation.
- Server instructions updated to describe all three backends and the `gremlin` query type.
- README.md Quick Start rewritten: leads with `uvx codesteward-mcp setup` for zero-config
  global setup; manual setup simplified with GraphQLite as default.
- `llms-install.md` rewritten for GraphQLite default and Cline compatibility.
- All `uvx` args in templates and docs fixed to use the `--from` pattern
  (`uvx --from "codesteward-mcp[graph-all,graphqlite]" codesteward-mcp`) — the previous
  pattern failed on macOS where `uvx` cannot parse extras as a command name.
- Global setup templates (`templates/global-claude-code/`, `templates/global-codex/`) updated
  to use GraphQLite as default backend.
- License changed from BSD 3-Clause to Apache 2.0.

---

## [0.3.0] — 2026-03-20

### Added — codesteward-graph

- Taint-source node and edge emission across all 12 parsers, enabling L1 taint analysis by the
  `codesteward-taint` binary without requiring a separate source-annotation pass:
  - **Python** — Flask/Django/FastAPI `request.*`, WSGI `environ`, Starlette `Request`
  - **TypeScript/JavaScript** — Express `req.body`/`req.query`/`req.params`/`req.headers`/`req.cookies`;
    NestJS parameter decorators (`@Body`, `@Param`, `@Query`, `@Headers`, etc.)
  - **Java** — Spring MVC `@RequestParam`, `@PathVariable`, `@RequestBody`, `@RequestHeader`,
    `@CookieValue`; Jakarta EE `@QueryParam`, `@PathParam`, `@FormParam`, `@HeaderParam`
  - **Go** — `net/http` `r.URL.Query()`, `r.FormValue()`, `r.Header.Get()`, `r.Body`;
    Gin `c.Query()`, `c.Param()`, `c.PostForm()`, `c.GetHeader()`
  - **Rust** — Actix-web/Axum typed extractors: `web::Path<T>`, `web::Query<T>`, `web::Json<T>`,
    `web::Form<T>`, `web::Bytes`, `web::Multipart`, `extract::Path`, `extract::Json`, etc.
  - **PHP** — superglobals (`$_GET`, `$_POST`, `$_REQUEST`, `$_FILES`, `$_COOKIE`, `$_SERVER`);
    Laravel `$request->input()`/`query()`/`file()`/etc.; Symfony property bags (`$request->query`,
    `$request->headers`, …); PSR-7 `getQueryParams()`/`getParsedBody()`/etc.;
    CodeIgniter4 `getGet()`/`getPost()`/`getJSON()`/etc.
  - **C#** — ASP.NET Core parameter attributes (`[FromQuery]`, `[FromRoute]`, `[FromBody]`,
    `[FromForm]`, `[FromHeader]`); `HttpRequest` property access (`Request.Query`,
    `Request.Form`, `Request.Headers`, `Request.Cookies`)
  - **Kotlin** — Spring Boot `@RequestParam`, `@PathVariable`, `@RequestBody`, `@RequestHeader`,
    `@CookieValue`; Ktor `call.receive*()`, `call.parameters`, `call.request.queryParameters`;
    Http4k `request.query()`, `request.path()`, `request.bodyString()`
  - **Scala** — Play Framework `request.body.*`, `request.queryString`, `request.headers`;
    Akka HTTP directives (`parameters`, `entity`, `formField`, `headerValueByName`, `cookie`, `path`)
  - **C** — CGI `getenv()` for HTTP env vars (`QUERY_STRING`, `HTTP_COOKIE`, etc.), stdin reads
    (`fread`/`fgets`/`read`); Mongoose `mg_http_get_var`/`mg_http_get_header`;
    libmicrohttpd `MHD_lookup_connection_value`
  - **C++** — all C patterns reused; Crow `req.body`/`req.url_params`/`req.headers`;
    Drogon `req->getBody()`/`req->getParameter()`/`req->getHeader()`/`req->getCookie()`;
    Pistache `request.query()`/`request.resource()`; Oat++ `getPathVariable()`/`getQueryParameter()`
  - **COBOL** — no applicable web taint patterns; no change
- `tests/test_engine/test_taint_sources.py` — new test module with 50+ tests covering taint-source
  detection for C, C++, C#, Rust, PHP, Kotlin, Scala, and NestJS (TypeScript)

### Added — codesteward-mcp

- `taint_analysis` MCP tool: invokes the `codesteward-taint` Go binary as an async subprocess
  and returns YAML with unsafe/sanitized path counts and a findings list. The tool is registered
  only when the binary is present on `PATH` (`shutil.which`); the server starts normally without it.
- `TAINT_FLOW` edges are now writable via `graph_augment` (added `taint_flow` to
  `_ALLOWED_EDGE_TYPES`).
- Docker image: new `taint-fetcher` build stage bundles the `codesteward-taint` binary by
  default (latest GitHub Release). Pin with `--build-arg TAINT_VERSION=<version>` or omit
  entirely with `--build-arg TAINT_VERSION=none`.

### Changed — codesteward-mcp

- `codebase_graph_query` `semantic` template updated from `DATA_FLOW` to `TAINT_FLOW`: results
  now return `source_name`, `source_file`, `sink_name`, `sink_file`, `cwe`, `hops`, `level`,
  `framework` instead of `function_name`, `file`, `line`, `flow_description`. Returns empty
  until `taint_analysis` has been run.

### Removed — codesteward-graph

- `DATA_FLOW` edges are no longer emitted by any parser. Use `TAINT_FLOW` edges written by the
  `codesteward-taint` binary for data-flow analysis.
- `_extract_semantic_edges()` removed from `TreeSitterBase` (and all callers in `python.py`,
  `typescript.py`, `java.py`).

## [0.2.2] — 2026-03-16

### Fixed — codesteward-graph

- External target nodes (guards, unresolved calls) now have `tenant_id` and `repo_id` set on
  creation so they are properly isolated per-tenant in Neo4j

### Changed — codesteward-mcp

- Referential query now returns `to_node_type` alongside `to_name` and `to_file`, so agents can
  distinguish external-library guard targets (`to_node_type: external`, `to_file: null`) from
  unresolved internal references

## [0.2.1] — 2026-03-15

### Fixed — codesteward-mcp

- Docker `CMD` was hardcoded to `--transport http`, overriding the `ENV TRANSPORT=sse` env var
  and causing the container to start on Streamable HTTP instead of SSE

## [0.2.0] — 2026-03-15

### Fixed — codesteward-graph

- `GraphEdge` model was missing `confidence` and `source` fields required by `graph_augment`
- Python parser: `is_async` flag not set for `async def` functions under tree-sitter-python ≥ 0.25
  (grammar now emits `function_definition` with an `async` child rather than `async_function_definition`)
- tree-sitter `Parser` initialisation updated to the ≥ 0.22 API (`Parser(language)` instead of
  `Parser().set_language(language)`)
- Optional-language test classes (Go, C, C++, Rust, PHP, C#, Kotlin, Scala) now skip gracefully
  with `pytest.importorskip` when the corresponding grammar package is not installed
- PyPI classifier corrected from `BSD Software License` to `BSD License`

### Fixed — codesteward-mcp

- Default transport switched from Streamable HTTP (`http`) to SSE (`sse`) so that Claude Code
  and other clients that do not send `Accept: text/event-stream` can connect without a 406 error
- SSE transport now served via `mcp.sse_app()` + uvicorn (consistent with the `http` branch)
- Docker image: `mkdir /workspace` moved before `USER codesteward` to avoid permission denied
- Health check replaced with a TCP socket probe (works on both SSE and HTTP transports)
- `TRANSPORT` environment variable default updated to `sse` in `Dockerfile.mcp` and
  `docker-compose.yml`
- CI and release workflows: `uv sync` now installs `--extra graph` so core grammar tests run
- All template `.mcp.json` / agent config files updated to point to `/sse` endpoint

### Changed — codesteward-mcp

- MCP endpoint URL changed from `http://localhost:3000/mcp` to `http://localhost:3000/sse`

## [0.1.0] — 2026-03-15

### Added — codesteward-graph

- Tree-sitter AST parsers for 13 languages: TypeScript, JavaScript (including TSX/JSX/MJS/CJS),
  Python, Java, Go, Rust, PHP, C#, Kotlin, Scala, C, C++
- Regex-based parser for COBOL (no tree-sitter grammar available)
- `CALLS` edge extraction with cross-file target resolution
- `IMPORTS`, `EXTENDS`, `DEPENDS_ON`, `DATA_FLOW` edge extraction
- `GUARDED_BY` edges for function-level auth guards: Python decorators, FastAPI `Depends`,
  TypeScript/Java annotations (`@UseGuards`, `@PreAuthorize`, etc.)
- `PROTECTED_BY` edges for router-scope auth guards: FastAPI `APIRouter(dependencies=[...])`,
  Express `router.use()`, Gin `group.Use()`, Actix `scope().wrap()`,
  Laravel `Route::middleware()->group()`, ASP.NET `MapGroup().RequireAuthorization()`
- SQL context tagging via template literal detection
- `GraphBuilder` with full and incremental parse modes
- Neo4j writer with tenant + repo namespacing; stub mode without Neo4j
- `PackageJsonParser` for `package.json` dependency extraction

### Added — codesteward-mcp

- MCP server over HTTP+SSE (Streamable HTTP, MCP 2025-03-26 spec) and stdio transports
- Four tools: `graph_rebuild`, `codebase_graph_query`, `graph_augment`, `graph_status`
- Five named query types: `lexical`, `referential`, `semantic`, `dependency`, `cypher`
- `McpConfig` via pydantic-settings — env vars, YAML file, or CLI flags
- `default_repo_path` — zero-argument `graph_rebuild` in the Docker setup
- Docker image and `docker-compose.yml` with Neo4j
- Templates for Claude Code, Cursor, Windsurf, VS Code, Gemini CLI, Continue.dev,
  Claude Desktop (`.mcp.json`, `.cursorrules`, `GEMINI.md`, `.windsurfrules`,
  `copilot-instructions.md`, `CLAUDE.md`)

[Unreleased]: https://github.com/bitkaio/codesteward/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/bitkaio/codesteward/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bitkaio/codesteward/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/bitkaio/codesteward/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/bitkaio/codesteward/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bitkaio/codesteward/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bitkaio/codesteward/releases/tag/v0.1.0
