"""Language parser registry for the Codesteward graph builder.

Usage::

    from codesteward.engine.parsers import get_parser, LANGUAGE_EXTENSIONS

    parser = get_parser("typescript")
    result = parser.parse(file_path, content, tenant_id, repo_id, "typescript")
"""


from .base import GraphEdge, LanguageParser, LexicalNode, ParseResult
from .java import JavaParser
from .python import PythonParser
from .typescript import TypeScriptParser

# Populated lazily when new-language modules are imported
_REGISTRY: dict[str, type[LanguageParser]] = {
    "typescript": TypeScriptParser,
    "tsx": TypeScriptParser,
    "javascript": TypeScriptParser,
    "jsx": TypeScriptParser,
    "python": PythonParser,
    "java": JavaParser,
}

# Extension → language name mapping (canonical, shared across the codebase)
LANGUAGE_EXTENSIONS: dict[str, frozenset[str]] = {
    "typescript": frozenset({".ts"}),
    "tsx": frozenset({".tsx"}),
    "javascript": frozenset({".js", ".jsx", ".mjs", ".cjs"}),
    "python": frozenset({".py"}),
    "java": frozenset({".java"}),
    # New languages added below when their modules are imported
}

# Flattened ext → language lookup
_EXT_TO_LANG: dict[str, str] = {
    ext: lang
    for lang, exts in LANGUAGE_EXTENSIONS.items()
    for ext in exts
}


def register_language(
    language: str,
    parser_class: type[LanguageParser],
    extensions: frozenset[str],
) -> None:
    """Register a new language parser at runtime.

    Called by language modules (csharp, kotlin, scala, cobol) when imported.

    Args:
        language: Language name string (e.g. "kotlin").
        parser_class: Concrete LanguageParser subclass.
        extensions: Set of file extensions (e.g. frozenset({".kt"})).
    """
    _REGISTRY[language] = parser_class
    LANGUAGE_EXTENSIONS[language] = extensions
    for ext in extensions:
        _EXT_TO_LANG[ext] = language


def get_parser(language: str) -> LanguageParser:
    """Return the best available parser instance for *language*.

    Falls back to TypeScriptParser for completely unknown/unregistered languages.

    Args:
        language: Language name string (e.g. "typescript", "python").

    Returns:
        Instantiated LanguageParser for the requested language.
    """
    cls = _REGISTRY.get(language, TypeScriptParser)
    return cls()


def lang_for_ext(ext: str) -> str | None:
    """Return language name for a file extension, or None if unsupported.

    Args:
        ext: File extension including the dot (e.g. ".ts", ".py").

    Returns:
        Language name string or None.
    """
    return _EXT_TO_LANG.get(ext)


def all_source_extensions() -> frozenset[str]:
    """Return all registered source file extensions.

    Returns:
        Frozenset of extension strings (e.g. frozenset({".ts", ".py", ...})).
    """
    return frozenset(_EXT_TO_LANG.keys())


__all__ = [
    "LexicalNode",
    "GraphEdge",
    "ParseResult",
    "LanguageParser",
    "TypeScriptParser",
    "PythonParser",
    "JavaParser",
    "get_parser",
    "lang_for_ext",
    "all_source_extensions",
    "register_language",
    "LANGUAGE_EXTENSIONS",
]


# Eager-register new language parsers by importing their modules.
# Each module calls register_language() at import time.
def _register_new_languages() -> None:
    import contextlib

    with contextlib.suppress(Exception):
        from . import csharp as _  # noqa: F401
    with contextlib.suppress(Exception):
        from . import kotlin as _  # noqa: F401
    with contextlib.suppress(Exception):
        from . import scala as _  # noqa: F401
    with contextlib.suppress(Exception):
        from . import cobol as _  # noqa: F401
    with contextlib.suppress(Exception):
        from . import go as _  # noqa: F401
    with contextlib.suppress(Exception):
        from . import c as _  # noqa: F401
    with contextlib.suppress(Exception):
        from . import cpp as _  # noqa: F401
    with contextlib.suppress(Exception):
        from . import rust as _  # noqa: F401
    with contextlib.suppress(Exception):
        from . import php as _  # noqa: F401


_register_new_languages()
