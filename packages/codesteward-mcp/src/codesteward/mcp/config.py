"""Codesteward MCP server configuration.

Loaded from environment variables and/or a YAML config file.  All settings
have sensible defaults so the server works out of the box without any config
(Neo4j optional — parse-only stub mode when not configured).
"""


import os
from pathlib import Path
from typing import Any

import structlog
import yaml
from pydantic import Field
from pydantic_settings import BaseSettings

log = structlog.get_logger()


class McpConfig(BaseSettings):
    """All runtime settings for the Codesteward MCP server.

    Values are resolved in this priority order (highest first):
    1. Environment variables (e.g. ``NEO4J_URI``)
    2. YAML config file pointed to by ``MCP_CONFIG_FILE``
    3. Defaults below
    """

    # ── Transport ────────────────────────────────────────────────────────────
    transport: str = Field("sse", description="MCP transport: 'sse', 'http', or 'stdio'")
    host: str = Field("0.0.0.0", description="HTTP server bind host")
    port: int = Field(3000, description="HTTP server port")

    # ── Neo4j (optional) ─────────────────────────────────────────────────────
    neo4j_uri: str = Field("bolt://localhost:7687", alias="NEO4J_URI")
    neo4j_user: str = Field("neo4j", alias="NEO4J_USER")
    neo4j_password: str = Field("", alias="NEO4J_PASSWORD")

    # ── Default tenant / repo for single-user local deployments ──────────────
    default_tenant_id: str = Field("local", description="Default tenant namespace")
    default_repo_id: str = Field("", description="Default repo ID (set to the repo name)")
    default_repo_path: str = Field(
        "/repos/project",
        description=(
            "Default filesystem path to the repository.  Used when graph_rebuild "
            "is called without an explicit repo_path argument.  In the Docker setup "
            "this matches the mount point defined in docker-compose.yml."
        ),
    )

    # ── Graph workspace ───────────────────────────────────────────────────────
    workspace_base: str = Field(
        "workspace",
        description="Base directory for graph build metadata",
    )

    # ── Logging ───────────────────────────────────────────────────────────────
    log_level: str = Field("INFO", description="Log level: DEBUG / INFO / WARNING / ERROR")

    model_config = {"populate_by_name": True, "env_prefix": ""}

    @property
    def neo4j_available(self) -> bool:
        """True when Neo4j credentials are configured."""
        return bool(self.neo4j_password)


def load_config(config_file: str | None = None) -> McpConfig:
    """Load MCP server config, optionally merging a YAML file.

    Environment variables always override YAML values.

    Args:
        config_file: Path to a YAML config file.  Falls back to the
            ``MCP_CONFIG_FILE`` environment variable, then defaults.

    Returns:
        Populated ``McpConfig`` instance.
    """
    config_path = config_file or os.getenv("MCP_CONFIG_FILE")
    yaml_values: dict[str, Any] = {}

    if config_path:
        path = Path(config_path)
        if path.exists():
            try:
                yaml_values = yaml.safe_load(path.read_text()) or {}
                log.info("mcp_config_loaded", path=str(path))
            except Exception as exc:
                log.warning("mcp_config_load_failed", path=str(path), error=str(exc))
        else:
            log.warning("mcp_config_not_found", path=str(path))

    # Env vars override YAML values; McpConfig reads env vars automatically
    # via pydantic-settings.  We pre-populate non-env YAML keys here.
    env_overrides: dict[str, Any] = {}
    for key, val in yaml_values.items():
        upper = key.upper()
        if upper not in os.environ:
            env_overrides[key] = val

    return McpConfig(**env_overrides)
