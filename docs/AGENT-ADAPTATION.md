# Universal Multi-Agent Adaptation Guide (Gemini / Codex / DeepSeek / Claude / Durable Pi)

AI Engineering Guard (`aeg`) is **100% model-agnostic and host-agnostic**. It never embeds an LLM SDK and never depends on any specific agent framework. Every agent interacts through the same deterministic CLI, exit codes (`0`–`5`), unified `--format agent-summary` JSON envelope, or the zero-dependency dual-framing stdio MCP server (`aeg-mcp`).

## One-Command Machine-Specific Config Generation

Run on your machine to print exact paths and copy-paste snippets for all agents:

```bash
node ./bin/aeg.js agents config --agent all
# Or filter to a single agent:
node ./bin/aeg.js agents config --agent codex
node ./bin/aeg.js agents config --agent gemini
node ./bin/aeg.js agents config --agent deepseek
```

Idempotently inject AEG instructions into any target repository (`AGENTS.md`, `GEMINI.md`, `CLAUDE.md`):

```bash
node ./bin/aeg.js agents install --cwd <target-repo-path>
```

## Supported Agents & Integration Channels

| Agent / Runtime | Integration Method | Files Provided |
|---|---|---|
| **Google Gemini (Gemini CLI / Antigravity)** | `GEMINI.md` + `SKILL.md` + MCP (`~/.gemini/settings.json`) + CLI | `GEMINI.md`, `integrations/agents/gemini/GEMINI.snippet.md`, `integrations/agents/universal-skill/SKILL.md` |
| **OpenAI Codex (CLI / App / Cloud)** | `AGENTS.md` + MCP TOML (`~/.codex/config.toml`) + CLI | `AGENTS.md`, `integrations/agents/codex/AGENTS.snippet.md`, `aeg agents config --agent codex` |
| **DeepSeek (Chat / Reasoner / Python & Node SDK / Cline / Roo / OpenCode / Aider)** | OpenAI-compatible Function Calling (`tools.json` + Node & Python dispatchers) + MCP + CLI | `integrations/agents/deepseek/tools.json`, `tool-dispatcher.mjs`, `tool_dispatcher.py`, `system-prompt.md` |
| **Claude Code** | `CLAUDE.md` + `SKILL.md` + `claude mcp add` + CLI | `CLAUDE.md`, `integrations/agents/mcp/mcp-config.example.json` |
| **Durable Pi** | CLI (`baseline`/`analyze`/`plan-tests`/`test`/`gate`/`aggregate`) + MCP cross-device tools | Native CLI + `TestResultReceipt` + `aeg-mcp` |

## Zero-Dependency Dual-Framing MCP Server (`aeg-mcp`)

- Supports both **newline-delimited JSON-RPC** (Gemini/Codex/Claude SDKs) and **LSP `Content-Length` framing** (Python/DeepSeek bridges).
- Negotiates MCP protocol versions `2024-11-05`, `2025-03-26`, and `2025-06-18`, handles `resources/list` & `prompts/list`, and returns both `content` and `structuredContent`.
- Exposes all **16 tools**:
  - **Read-only (9)**: `analyze_changes`, `get_impact_graph`, `assess_risk`, `plan_tests`, `explain_test_selection`, `get_gate_status`, `get_quality_report`, `get_failure_details`, `get_log_excerpt`
  - **Execution (3)**: `run_test_plan`, `run_quality_gate`, `refresh_baseline`
  - **Cross-device (4)**: `get_execution_matrix`, `register_execution_result`, `get_platform_coverage`, `aggregate_gate_results`

## Windows PowerShell Compatibility

When PowerShell restricts `.ps1` execution policies, invoke either:
- `& "<path-to-ai-engineering-guard>\bin\aeg.cmd" check --format agent-summary`
- `node "<path-to-ai-engineering-guard>/bin/aeg.js" check --format agent-summary`

## Progressive Disclosure & Unified Error Envelope

- **On pass**: `agent-summary` includes zero test stdout/stderr logs (~400–800 bytes total).
- **On failure**: total excerpt bytes across all failures are strictly capped by `agent_context.max_failure_excerpt_bytes`, with secrets redacted and exact `aeg inspect log <id> --lines 80` expansion hints.
- **On config/tool error (exit `3` / `4`)**: `--format agent-summary` still returns a consistent `{ outcome: "error", workflow_action: "block", error_code, error_message, agent_action }` JSON envelope.
- **Subdirectory invocation**: running `aeg` from any nested folder inside a repository automatically resolves upwards to the nearest `.engineering-guard/` workspace root.
