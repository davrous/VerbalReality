"""Persistent capture of Babylon.js code-validation failures for later evaluation.

When the agent's validate→fix→retry loop produces an ``ERROR:`` from the NullEngine
validator (or the validator is unreachable), we currently have no way to see *what*
failed — the loop just retries silently up to 3 times and may give up with no trace.

This module persists every failing attempt to the micro-VM's local disk so the failures
can be inspected and turned into an evaluation dataset. The persistence pattern mirrors
``scene_manager.py`` from https://github.com/davrous/blenderagent:

  * Store under ``$HOME`` (persisted by the Foundry ADC platform across idle/resume of the
    micro-VM that is bound 1:1 to a conversation), falling back to ``/tmp`` only when
    ``$HOME`` is not writable (some local Docker setups). Honors ``FAILURE_STORE_DIR``.
  * All writes are best-effort and NEVER raise — capturing a failure must not break the
    agent turn. I/O errors are logged and swallowed.
  * The append-only ``failures.jsonl`` dataset is written atomically and soft-capped to
    keep the file bounded on long-lived VMs.

Two shapes are written per failure (both under the same store directory):
  1. One line appended to ``failures.jsonl`` (the evaluation dataset).
  2. A per-failure pair ``<conversation>/<ts>-attempt<N>.json`` (full record) and
     ``<ts>-attempt<N>.js`` (the raw failing code), for easy human browsing.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from datetime import datetime, timezone

logger = logging.getLogger("babylon3d_agent.failure_store")

# Maximum number of lines kept in failures.jsonl. When exceeded we keep the most recent
# _MAX_JSONL_LINES. The per-failure .json/.js artifacts are not pruned (a micro-VM is
# ephemeral per conversation, so they stay bounded in practice).
_MAX_JSONL_LINES = int(os.environ.get("FAILURE_STORE_MAX_LINES", "500"))


def _resolve_store_dir() -> str:
    """Resolve the failure-store directory, preferring ``$HOME`` with a ``/tmp`` fallback."""
    override = os.environ.get("FAILURE_STORE_DIR")
    primary = override or os.path.join(os.path.expanduser("~"), "validation_failures")
    try:
        os.makedirs(primary, exist_ok=True)
        return primary
    except OSError:
        fallback = os.path.join(tempfile.gettempdir(), "validation_failures")
        try:
            os.makedirs(fallback, exist_ok=True)
        except OSError:
            logger.warning("Could not create failure store dir %s or %s", primary, fallback)
        logger.warning("Failure store: could not use %s, falling back to %s", primary, fallback)
        return fallback


_STORE_DIR = _resolve_store_dir()
_JSONL_FILE = os.path.join(_STORE_DIR, "failures.jsonl")


# Ordered (pattern -> category) classification. First match wins. Patterns are matched
# case-insensitively against the validator's error message.
_ERROR_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"could not reach|connection refused|timed out|timeout|ECONNREFUSED", re.I), "transport"),
    (re.compile(r"SyntaxError|Unexpected token|Unexpected identifier|Unexpected end of", re.I), "syntax"),
    (re.compile(r"ReferenceError|is not defined", re.I), "reference"),
    (re.compile(r"TypeError|is not a function|Cannot read propert|Cannot set propert|of undefined|of null", re.I), "type"),
    (re.compile(r"RangeError|out of range|invalid array length", re.I), "range"),
    (re.compile(r"BABYLON|mesh|material|vertex|shader|scene\b", re.I), "babylon"),
]


def classify_error(message: str) -> str:
    """Classify a validator error message into a coarse error type for evaluation.

    Returns one of: transport, syntax, reference, type, range, babylon, unknown.
    """
    if not message:
        return "unknown"
    for pattern, category in _ERROR_PATTERNS:
        if pattern.search(message):
            return category
    return "unknown"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _safe_segment(value: str | None) -> str:
    """Sanitize an id into a filesystem-safe directory segment."""
    if not value:
        return "unknown"
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", value)
    return cleaned[:80] or "unknown"


def _append_jsonl(record: dict) -> None:
    """Append one record to failures.jsonl and soft-cap the file length. Best effort."""
    try:
        with open(_JSONL_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        logger.warning("Failure store: could not append to %s", _JSONL_FILE, exc_info=True)
        return

    # Soft cap: if the file grew past the limit, rewrite keeping only the most recent lines.
    try:
        with open(_JSONL_FILE, encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) > _MAX_JSONL_LINES:
            trimmed = lines[-_MAX_JSONL_LINES:]
            tmp = _JSONL_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(trimmed)
            os.replace(tmp, _JSONL_FILE)
    except OSError:
        logger.warning("Failure store: could not trim %s", _JSONL_FILE, exc_info=True)


def _write_artifacts(record: dict, code: str) -> None:
    """Write the per-failure .json + .js artifacts under <store>/<conversation>/. Best effort."""
    conversation = record.get("conversation_id") or record.get("session_id")
    sub_dir = os.path.join(_STORE_DIR, _safe_segment(conversation))
    # File-safe timestamp (no colons) + attempt number.
    ts = record["timestamp"].replace(":", "").replace(".", "-")
    stem = f"{ts}-attempt{record.get('attempt', 0)}"
    try:
        os.makedirs(sub_dir, exist_ok=True)
        with open(os.path.join(sub_dir, stem + ".json"), "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        with open(os.path.join(sub_dir, stem + ".js"), "w", encoding="utf-8") as f:
            f.write(code or "")
    except OSError:
        logger.warning("Failure store: could not write artifacts under %s", sub_dir, exc_info=True)


def record_failure(
    *,
    code: str,
    error: str,
    attempt: int,
    prompt: str | None = None,
    conversation_id: str | None = None,
    session_id: str | None = None,
) -> dict:
    """Persist a single validation failure. Best-effort: never raises.

    Returns the record dict that was stored (useful for logging/telemetry by the caller).
    """
    record = {
        "timestamp": _utc_now_iso(),
        "conversation_id": conversation_id,
        "session_id": session_id,
        "attempt": attempt,
        "error_type": classify_error(error),
        "error_message": error,
        "turn_prompt": prompt,
        "code": code,
        "code_chars": len(code or ""),
    }
    try:
        _append_jsonl(record)
        _write_artifacts(record, code)
    except Exception:  # noqa: BLE001 - capturing must never break the agent turn
        logger.warning("Failure store: unexpected error recording failure", exc_info=True)
    return record


def read_recent(limit: int = 20) -> list[dict]:
    """Return the most recent failures (newest first) from failures.jsonl. Best effort."""
    if limit <= 0:
        return []
    try:
        with open(_JSONL_FILE, encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return []
    except OSError:
        logger.warning("Failure store: could not read %s", _JSONL_FILE, exc_info=True)
        return []

    records: list[dict] = []
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
        if len(records) >= limit:
            break
    return records


def store_dir() -> str:
    """Return the resolved on-disk store directory (for diagnostics/logging)."""
    return _STORE_DIR
