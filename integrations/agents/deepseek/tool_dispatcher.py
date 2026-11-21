"""
Zero-dependency Python tool dispatcher for AI Engineering Guard (AEG).
Works seamlessly with DeepSeek (deepseek-chat / deepseek-reasoner), OpenAI SDK,
Gemini Python SDK, LangGraph, AutoGen, and CrewAI agents.

Executes AEG strictly via `subprocess.run(..., shell=False)` (never invokes a shell).
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List

AEG_BIN = Path(__file__).resolve().parents[3] / "bin" / "aeg.js"
TOOLS_SCHEMA_PATH = Path(__file__).resolve().parent / "tools.json"


def load_aeg_tools_schema() -> List[Dict[str, Any]]:
    """Return OpenAI/DeepSeek-compatible `tools` list for chat.completions.create(tools=...)."""
    with TOOLS_SCHEMA_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)["tools"]


def dispatch_aeg_tool_call(
    name: str,
    arguments: Dict[str, Any] | str | None = None,
    node_executable: str = "node",
) -> Dict[str, Any]:
    """Dispatch a model tool call to AEG CLI and return `{exitCode, data}`."""
    if isinstance(arguments, str):
        args: Dict[str, Any] = json.loads(arguments) if arguments.strip() else {}
    else:
        args = dict(arguments or {})

    cwd = str(args.get("cwd") or os.getcwd())
    cli_args: List[str] = [node_executable, str(AEG_BIN)]

    if name == "aeg_check":
        cli_args += ["check", "--format", "agent-summary", "--cwd", cwd]
        if args.get("mode"):
            cli_args += ["--mode", str(args["mode"])]
        if args.get("policy"):
            cli_args += ["--policy", str(args["policy"])]
        if args.get("base"):
            cli_args += ["--base", str(args["base"])]
        if args.get("plan_only"):
            cli_args.append("--plan-only")
        if args.get("no_cache"):
            cli_args.append("--no-cache")
    elif name == "aeg_explain_risk":
        cli_args += ["explain", "risk", "--format", "json", "--cwd", cwd]
        if args.get("base"):
            cli_args += ["--base", str(args["base"])]
        if args.get("mode"):
            cli_args += ["--mode", str(args["mode"])]
    elif name == "aeg_explain_test":
        cli_args += ["explain", "test", str(args["suite_id"]), "--format", "json", "--cwd", cwd]
        if args.get("base"):
            cli_args += ["--base", str(args["base"])]
    elif name == "aeg_inspect_failure":
        cli_args += ["inspect", "failure"]
        if args.get("failure_id"):
            cli_args.append(str(args["failure_id"]))
        cli_args += ["--format", "json", "--cwd", cwd]
        if args.get("run_id"):
            cli_args += ["--run", str(args["run_id"])]
    elif name == "aeg_inspect_log":
        cli_args += ["inspect", "log", str(args["failure_id"]), "--format", "json", "--cwd", cwd]
        if args.get("start_line"):
            cli_args += ["--start", str(args["start_line"])]
        if args.get("lines"):
            cli_args += ["--lines", str(args["lines"])]
    elif name == "aeg_config_validate":
        cli_args += ["config", "validate", "--format", "json", "--cwd", cwd]
    else:
        raise ValueError(f"Unknown AEG tool call: {name}")

    proc = subprocess.run(
        cli_args,
        shell=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    raw = proc.stdout.strip() or proc.stderr.strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {"outcome": "error", "workflow_action": "block", "error_message": raw}

    return {"exitCode": proc.returncode, "data": parsed}
