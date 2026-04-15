"""Regression test: structlog must not write to stdout.

In stdio MCP transport, stdout is the JSON-RPC channel.  Any structlog
output on stdout corrupts the protocol and the client drops the connection
with ``JSON Parse error: Unable to parse JSON string``.

This test guards against the bug fixed in 0.5.1 where
``structlog.configure()`` was called without an explicit ``logger_factory``
and defaulted to ``PrintLoggerFactory(file=sys.stdout)``.
"""

import io
import logging
import sys

import structlog

from codesteward.mcp.server import _configure_logging


def test_structlog_writes_to_stderr_not_stdout(monkeypatch):
    """structlog output must go to stderr, leaving stdout clean for JSON-RPC."""
    fake_stdout = io.StringIO()
    fake_stderr = io.StringIO()
    monkeypatch.setattr(sys, "stdout", fake_stdout)
    monkeypatch.setattr(sys, "stderr", fake_stderr)

    _configure_logging("INFO")

    log = structlog.get_logger()
    log.warning("test_event", key="value")
    log.error("another_event", detail="payload")

    assert fake_stdout.getvalue() == "", (
        "structlog wrote to stdout — this will corrupt the MCP stdio "
        f"JSON-RPC channel. Got: {fake_stdout.getvalue()!r}"
    )
    assert "test_event" in fake_stderr.getvalue()
    assert "another_event" in fake_stderr.getvalue()


def test_stdlib_logging_writes_to_stderr(monkeypatch):
    """stdlib logging must also stay off stdout."""
    fake_stdout = io.StringIO()
    fake_stderr = io.StringIO()
    monkeypatch.setattr(sys, "stdout", fake_stdout)
    monkeypatch.setattr(sys, "stderr", fake_stderr)

    for handler in list(logging.root.handlers):
        logging.root.removeHandler(handler)

    _configure_logging("INFO")
    logging.getLogger("codesteward.test").warning("stdlib_event")

    assert fake_stdout.getvalue() == "", (
        "stdlib logging wrote to stdout. "
        f"Got: {fake_stdout.getvalue()!r}"
    )
    assert "stdlib_event" in fake_stderr.getvalue()
