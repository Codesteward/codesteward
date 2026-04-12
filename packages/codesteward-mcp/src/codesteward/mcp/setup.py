"""Automated setup and teardown for Codesteward MCP across AI coding tools.

Detects installed tools (Claude Code, Cursor, Cline, Codex CLI, Gemini CLI),
registers the MCP server globally, and merges workflow instructions into
existing config files — nothing is overwritten.

Usage::

    codesteward-mcp setup              # install (GraphQLite default)
    codesteward-mcp setup --uninstall  # remove everything
    codesteward-mcp setup --backend neo4j
"""

import json
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Any

import structlog

log = structlog.get_logger()

# ── Marker for idempotent CLAUDE.md / AGENTS.md merging ─────────────────────

_MARKER_BEGIN = "<!-- codesteward:begin -->"
_MARKER_END = "<!-- codesteward:end -->"

# ── MCP server name ─────────────────────────────────────────────────────────

_SERVER_NAME = "codesteward-graph"

# ── Embedded content ────────────────────────────────────────────────────────


def _mcp_server_config(backend: str, tool: str = "") -> dict[str, Any]:
    """Build the MCP server JSON config for the given backend.

    Args:
        backend: Graph backend name (graphqlite, neo4j, janusgraph).
        tool: Tool name — Claude Code requires ``"type": "stdio"``.
    """
    base: dict[str, Any] = {
        "command": "uvx",
        "args": [
            "--from",
            f"codesteward-mcp[graph-all,{backend}]"
            if backend in ("graphqlite", "janusgraph")
            else "codesteward-mcp[graph-all]",
            "codesteward-mcp",
            "--transport",
            "stdio",
        ],
    }
    # Claude Code requires the "type" field in MCP server config
    if tool == "Claude Code":
        base["type"] = "stdio"

    if backend == "neo4j":
        base["env"] = {
            "GRAPH_BACKEND": "neo4j",
            "NEO4J_URI": "bolt://localhost:7687",
            "NEO4J_USER": "neo4j",
            "NEO4J_PASSWORD": "",
        }
    elif backend == "janusgraph":
        base["env"] = {
            "GRAPH_BACKEND": "janusgraph",
            "JANUSGRAPH_URL": "ws://localhost:8182/gremlin",
        }
    # graphqlite: no env needed — auto-detected by default

    return base


_CLAUDE_MD_SECTION = """\
# Code Intelligence — Codesteward Graph

Codesteward is connected globally as an MCP server. It parses any repository
into a structural graph and exposes queryable tools.
**Follow the workflow below at the start of every session.**

## Step 1 — Derive repo context (always first)

Before doing anything else, resolve the repo identity from the working directory:

```text
repo_id   = last path segment of $PWD   (e.g. /repos/serving-api  → "serving-api")
repo_path = $PWD
tenant_id = "local"
```

## Step 2 — Check the graph

Call `graph_status` with the derived `repo_id`:

```text
graph_status(repo_id="<repo_id>")
```

Read `last_build` in the response:

- **null or missing** → the repository has never been indexed; go to Step 3.
- **present** → graph exists.  If it looks stale relative to recent changes
  the user mentions, go to Step 3.  Otherwise skip to Step 4.

## Step 3 — Build (or rebuild) the graph

```text
graph_rebuild(repo_path="<repo_path>", repo_id="<repo_id>")
```

This parses every source file and writes the structural graph to the
configured backend.  Report back: node count, edge count, languages detected.

## Step 4 — Answer structural questions via the graph

**Prefer graph tools over reading files** for any question about structure,
relationships, or dependencies.

Always include `repo_id` on every call:

```text
codebase_graph_query(query_type="lexical",     query="<name>",  repo_id="<repo_id>")
codebase_graph_query(query_type="referential", query="<name>",  repo_id="<repo_id>")
codebase_graph_query(query_type="dependency",  query="",        repo_id="<repo_id>")
```

Use `Read` / `Grep` only when you need the actual source lines of a specific
file or function after identifying it via the graph.

## query_type reference

| query_type    | Use when you want to…                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `lexical`     | Find functions, classes, or methods by name or file                              |
| `referential` | Find call/import/extends/auth-guard relationships                                |
| `semantic`    | Read taint-flow findings (run `taint_analysis` first; returns empty until then)  |
| `dependency`  | List external package dependencies                                               |
| `cypher`      | Raw Cypher query (Neo4j / GraphQLite backend)                                    |
| `gremlin`     | Raw Gremlin query (JanusGraph backend)                                           |

## Important: empty results do not mean no symbols

An empty result from `codebase_graph_query` does not mean the code has no
symbols.  It may mean the graph has not been built yet.  Always check
`graph_status()` first.

## Taint-flow analysis (optional)

If `taint_analysis` appears in the available tools:

```text
taint_analysis(repo_id="<repo_id>")
codebase_graph_query(query_type="semantic", query="", repo_id="<repo_id>")
```

## Recording inferred relationships

If you identify a relationship the parser could not detect (e.g. a dynamic
call), record it:

```python
graph_augment(
    agent_id="your-agent-id",
    repo_id="<repo_id>",
    additions=[{
        "source_id": "<node_id from query result>",
        "edge_type": "calls",
        "target_id": "<node_id from query result>",
        "target_name": "function_name",
        "confidence": 0.85,
        "rationale": "Called dynamically via registry lookup at line 42"
    }]
)
```
"""

_AGENTS_MD_SECTION = """\
# Code Intelligence — Codesteward Graph

Codesteward is connected globally as an MCP server. It parses any repository
into a structural graph and exposes queryable tools.
**Follow the workflow below at the start of every session.**

## Step 1 — Derive repo context

```text
repo_id   = last path segment of $PWD
repo_path = $PWD
tenant_id = "local"
```

## Step 2 — Check the graph

Call `graph_status(repo_id="<repo_id>")`.
If `last_build` is null, go to Step 3. Otherwise skip to Step 4.

## Step 3 — Build the graph

```text
graph_rebuild(repo_path="<repo_path>", repo_id="<repo_id>")
```

## Step 4 — Query

**Prefer graph tools over reading files** for structural questions.

```text
codebase_graph_query(query_type="lexical",     query="<name>",  repo_id="<repo_id>")
codebase_graph_query(query_type="referential", query="<name>",  repo_id="<repo_id>")
codebase_graph_query(query_type="dependency",  query="",        repo_id="<repo_id>")
```

Use filesystem tools only when you need actual source lines after identifying
a symbol via the graph.

## query_type reference

| query_type    | Use when you want to…                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `lexical`     | Find functions, classes, or methods by name or file                              |
| `referential` | Find call/import/extends/auth-guard relationships                                |
| `semantic`    | Read taint-flow findings (run `taint_analysis` first)                            |
| `dependency`  | List external package dependencies                                               |
| `cypher`      | Raw Cypher query (Neo4j / GraphQLite)                                            |
| `gremlin`     | Raw Gremlin query (JanusGraph)                                                   |

## Important: empty results do not mean no symbols

Always check `graph_status()` first — the graph may not have been built yet.
"""

_SKILL_CONTENT = """\
You are executing an explicit Codesteward workflow. Follow these steps in order.

**Step 1 — Resolve repo context**

Derive from the current working directory:
- `repo_id`   = last path segment of `$PWD`
- `repo_path` = `$PWD`
- `tenant_id` = `"local"` (unless the user specified otherwise)

If the user passed arguments (e.g. `/codesteward rebuild`, `/codesteward taint`,
`/codesteward query <term>`), note the intent.

**Step 2 — Check graph freshness**

Call `graph_status(repo_id=<repo_id>)`.

- If `last_build` is null → proceed to Step 3 (rebuild needed).
- If `last_build` exists and no rebuild was requested → skip to Step 4.

**Step 3 — Rebuild (if needed or requested)**

Call `graph_rebuild(repo_path=<repo_path>, repo_id=<repo_id>)`.
Report: node count, edge count, languages detected.

**Step 4 — Query or analyse**

| Intent / argument | Action |
|---|---|
| `rebuild` | Already done in Step 3; report results. |
| `taint` or `scan` | `taint_analysis(repo_id=<repo_id>)`, then `codebase_graph_query(query_type="semantic", repo_id=<repo_id>)`. |
| `query <term>` | `codebase_graph_query(query_type="referential", query=<term>, repo_id=<repo_id>)`. |
| `status` | Report the output from Step 2 and stop. |
| *(no argument)* | Ask the user: rebuild, query, or taint scan? |

**Step 5 — Summarise and suggest next step**
"""


# ── Tool detection ──────────────────────────────────────────────────────────


def _home() -> Path:
    return Path.home()


def _cline_global_storage() -> Path | None:
    """Return the Cline extension globalStorage path, or None."""
    system = platform.system()
    if system == "Darwin":
        base = _home() / "Library" / "Application Support" / "Code" / "User" / "globalStorage"
    elif system == "Windows":
        appdata = os.environ.get("APPDATA", "")
        if not appdata:
            return None
        base = Path(appdata) / "Code" / "User" / "globalStorage"
    else:  # Linux
        base = _home() / ".config" / "Code" / "User" / "globalStorage"

    cline_dir = base / "saoudrizwan.claude-dev"
    if cline_dir.is_dir():
        return cline_dir
    return None


def _detect_tools() -> dict[str, dict[str, Any]]:
    """Detect which AI coding tools are installed.

    Returns:
        Dict mapping tool name to metadata (config path, instructions path, etc.)
    """
    tools: dict[str, dict[str, Any]] = {}

    # Claude Code — MCP servers live in ~/.claude.json (root-level config),
    # NOT ~/.claude/settings.json (which is for other settings like model/effort).
    claude_dir = _home() / ".claude"
    if claude_dir.is_dir() or shutil.which("claude"):
        tools["Claude Code"] = {
            "config_path": _home() / ".claude.json",
            "config_key": "mcpServers",
            "instructions_path": claude_dir / "CLAUDE.md",
            "instructions_content": _CLAUDE_MD_SECTION,
            "skill_path": claude_dir / "skills" / "codesteward.md",
            "skill_content": _SKILL_CONTENT,
        }

    # Cursor
    cursor_dir = _home() / ".cursor"
    if cursor_dir.is_dir() or shutil.which("cursor"):
        tools["Cursor"] = {
            "config_path": cursor_dir / "mcp.json",
            "config_key": "mcpServers",
        }

    # Cline (VS Code extension)
    cline_dir = _cline_global_storage()
    if cline_dir is not None:
        tools["Cline"] = {
            "config_path": cline_dir / "settings" / "cline_mcp_settings.json",
            "config_key": "mcpServers",
        }

    # Gemini CLI
    gemini_dir = _home() / ".gemini"
    if gemini_dir.is_dir() or shutil.which("gemini"):
        tools["Gemini CLI"] = {
            "config_path": gemini_dir / "settings.json",
            "config_key": "mcpServers",
        }

    # Codex CLI
    codex_dir = _home() / ".codex"
    if codex_dir.is_dir() or shutil.which("codex"):
        tools["Codex CLI"] = {
            "config_path": codex_dir / "config.yaml",
            "config_key": "mcp_servers",
            "config_format": "yaml",
            "instructions_path": _home() / "AGENTS.md",
            "instructions_content": _AGENTS_MD_SECTION,
        }

    return tools


# ── File manipulation helpers ───────────────────────────────────────────────


def _read_json(path: Path) -> dict[str, Any]:
    """Read a JSON file, returning {} if it doesn't exist or is empty."""
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8").strip()
        if not text:
            return {}
        result: dict[str, Any] = json.loads(text)
        return result
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("json_read_failed", path=str(path), error=str(exc))
        return {}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    """Write a JSON file with pretty formatting."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _merge_json_mcp(
    path: Path,
    servers_key: str,
    server_name: str,
    server_config: dict[str, Any],
) -> bool:
    """Merge an MCP server entry into a JSON config file.

    Returns True if the file was modified, False if already up to date.
    """
    data = _read_json(path)
    servers = data.setdefault(servers_key, {})

    # Remove old "codesteward" key if migrating to "codesteward-graph"
    if server_name == _SERVER_NAME and "codesteward" in servers:
        del servers["codesteward"]

    if servers.get(server_name) == server_config:
        return False

    servers[server_name] = server_config
    _write_json(path, data)
    return True


def _remove_json_mcp(path: Path, servers_key: str, server_name: str) -> bool:
    """Remove an MCP server entry from a JSON config file.

    Returns True if the file was modified.
    """
    if not path.exists():
        return False
    data = _read_json(path)
    servers = data.get(servers_key, {})
    removed = False

    for key in (server_name, "codesteward"):
        if key in servers:
            del servers[key]
            removed = True

    if removed:
        _write_json(path, data)
    return removed


def _merge_yaml_mcp(
    path: Path,
    server_name: str,
    server_config: dict[str, Any],
) -> bool:
    """Merge an MCP server entry into a Codex YAML config file.

    Returns True if the file was modified.
    """
    try:
        import yaml
    except ImportError:
        log.warning("yaml_not_available", msg="pyyaml needed for Codex config")
        return False

    data: dict[str, Any] = {}
    if path.exists():
        try:
            text = path.read_text(encoding="utf-8")
            data = yaml.safe_load(text) or {}
        except Exception as exc:
            log.warning("yaml_read_failed", path=str(path), error=str(exc))
            return False

    servers = data.setdefault("mcp_servers", {})

    if server_name == _SERVER_NAME and "codesteward" in servers:
        del servers["codesteward"]

    if servers.get(server_name) == server_config:
        return False

    servers[server_name] = server_config
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, default_flow_style=False, sort_keys=False),
        encoding="utf-8",
    )
    return True


def _remove_yaml_mcp(path: Path, server_name: str) -> bool:
    """Remove an MCP server entry from a Codex YAML config file."""
    try:
        import yaml
    except ImportError:
        return False

    if not path.exists():
        return False

    try:
        text = path.read_text(encoding="utf-8")
        data = yaml.safe_load(text) or {}
    except Exception:
        return False

    servers = data.get("mcp_servers", {})
    removed = False
    for key in (server_name, "codesteward"):
        if key in servers:
            del servers[key]
            removed = True

    if removed:
        path.write_text(
            yaml.safe_dump(data, default_flow_style=False, sort_keys=False),
            encoding="utf-8",
        )
    return removed


def _merge_markdown(path: Path, section_content: str) -> bool:
    """Merge a section into a markdown file using markers.

    - If markers exist: replace between them.
    - If known headers exist without markers: append with markers and warn.
    - If nothing exists: append with markers.

    Returns True if the file was modified.
    """
    wrapped = f"{_MARKER_BEGIN}\n{section_content}\n{_MARKER_END}\n"

    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(wrapped, encoding="utf-8")
        return True

    content = path.read_text(encoding="utf-8")

    if _MARKER_BEGIN in content and _MARKER_END in content:
        start = content.index(_MARKER_BEGIN)
        end = content.index(_MARKER_END) + len(_MARKER_END)
        # Include trailing newline if present
        if end < len(content) and content[end] == "\n":
            end += 1
        new_content = content[:start] + wrapped + content[end:]
        if new_content == content:
            return False
        path.write_text(new_content, encoding="utf-8")
        return True

    # Check for existing Codesteward sections without markers
    _KNOWN_HEADERS = (
        "# Code Intelligence — Codesteward Graph",
        "## CodeSteward — Structural Code Graph",
        "## CodeSteward",
    )
    for header in _KNOWN_HEADERS:
        if header in content:
            print(
                f"  ⚠  Found existing Codesteward section in {path.name} "
                f"without markers.\n"
                f"     Appending new section with markers — "
                f"please remove the old section manually."
            )
            break

    # Append with spacing
    separator = "\n\n" if content and not content.endswith("\n\n") else (
        "\n" if content and not content.endswith("\n") else ""
    )
    path.write_text(content + separator + wrapped, encoding="utf-8")
    return True


def _remove_markdown(path: Path) -> bool:
    """Remove the Codesteward section from a markdown file.

    Returns True if the file was modified.
    """
    if not path.exists():
        return False

    content = path.read_text(encoding="utf-8")
    if _MARKER_BEGIN not in content:
        return False

    start = content.index(_MARKER_BEGIN)
    end_marker = content.find(_MARKER_END)
    if end_marker < 0:
        return False
    end = end_marker + len(_MARKER_END)
    if end < len(content) and content[end] == "\n":
        end += 1

    # Also remove preceding blank lines
    while start > 0 and content[start - 1] == "\n":
        start -= 1
    if start > 0:
        start += 1  # keep one newline

    new_content = content[:start] + content[end:]
    if new_content.strip() == "":
        # File would be empty — remove it entirely
        path.unlink()
        return True

    path.write_text(new_content, encoding="utf-8")
    return True


# ── Main entry points ───────────────────────────────────────────────────────


def run_setup(backend: str = "graphqlite") -> None:
    """Run the full setup: detect tools, register MCP server, merge instructions.

    Args:
        backend: Graph backend — ``graphqlite`` (default), ``neo4j``, or
            ``janusgraph``.
    """
    print(f"\n  Codesteward MCP — Global Setup (backend: {backend})\n")

    tools = _detect_tools()
    if not tools:
        print("  No supported AI coding tools detected.\n")
        print("  Supported: Claude Code, Cursor, Cline, Codex CLI, Gemini CLI")
        print("  Install one and re-run this command.\n")
        sys.exit(1)

    print(f"  Detected tools: {', '.join(tools.keys())}\n")

    actions: list[str] = []

    for tool_name, meta in tools.items():
        server_config = _mcp_server_config(backend, tool=tool_name)
        config_path: Path = meta["config_path"]
        config_format = meta.get("config_format", "json")
        config_key: str = meta.get("config_key", "mcpServers")

        # Register MCP server
        if config_format == "yaml":
            modified = _merge_yaml_mcp(config_path, _SERVER_NAME, server_config)
        else:
            modified = _merge_json_mcp(
                config_path, config_key, _SERVER_NAME, server_config,
            )

        if modified:
            actions.append(f"  + {tool_name}: registered MCP server in {config_path}")
        else:
            actions.append(f"  = {tool_name}: MCP server already configured")

        # Merge instructions (if applicable)
        instructions_path = meta.get("instructions_path")
        instructions_content = meta.get("instructions_content")
        if instructions_path and instructions_content and _merge_markdown(
            Path(instructions_path), instructions_content,
        ):
            actions.append(
                f"  + {tool_name}: merged instructions into "
                f"{instructions_path}"
            )

        # Install skill (Claude Code only)
        skill_path = meta.get("skill_path")
        skill_content = meta.get("skill_content")
        if skill_path and skill_content:
            skill = Path(skill_path)
            if not skill.exists() or skill.read_text(encoding="utf-8") != skill_content:
                skill.parent.mkdir(parents=True, exist_ok=True)
                skill.write_text(skill_content, encoding="utf-8")
                actions.append(f"  + {tool_name}: installed /codesteward skill")

    # Summary
    print("\n".join(actions))
    print(
        "\n  Done. Open any repo and start asking structural questions.\n"
        "  The graph persists at ~/.codesteward/graph.db across sessions.\n"
    )


def run_uninstall() -> None:
    """Remove all Codesteward config from detected tools."""
    print("\n  Codesteward MCP — Uninstall\n")

    tools = _detect_tools()
    if not tools:
        print("  No supported AI coding tools detected. Nothing to remove.\n")
        return

    actions: list[str] = []

    for tool_name, meta in tools.items():
        config_path: Path = meta["config_path"]
        config_format = meta.get("config_format", "json")
        config_key: str = meta.get("config_key", "mcpServers")

        # Remove MCP server
        if config_format == "yaml":
            removed = _remove_yaml_mcp(config_path, _SERVER_NAME)
        else:
            removed = _remove_json_mcp(config_path, config_key, _SERVER_NAME)

        if removed:
            actions.append(f"  - {tool_name}: removed MCP server from {config_path}")

        # Remove instructions
        instructions_path = meta.get("instructions_path")
        if instructions_path and _remove_markdown(Path(instructions_path)):
            actions.append(
                f"  - {tool_name}: removed instructions from {instructions_path}"
            )

        # Remove skill
        skill_path = meta.get("skill_path")
        if skill_path:
            skill = Path(skill_path)
            if skill.exists():
                skill.unlink()
                actions.append(f"  - {tool_name}: removed /codesteward skill")

    if actions:
        print("\n".join(actions))
        print("\n  Done. All Codesteward configuration removed.\n")
    else:
        print("  No Codesteward configuration found. Nothing to remove.\n")
