---
name: ai-engineering-guard
description: Use AI Engineering Guard (aeg) as the unified, model-agnostic engineering quality gate across DeepSeek, Gemini, Codex, Claude, and Durable Pi workflows. Invoke after code changes to analyze impact, assess L0-L4 risk, run deduplicated/cached tests, and obtain minimal agent-summary gate decisions.
---

# AI Engineering Guard (`aeg`) — Universal Agent Skill

`ai-engineering-guard` (CLI: `aeg`, MCP: `aeg-mcp`) is a shared, deterministic, model-agnostic engineering quality decision engine designed for **all AI agents** (DeepSeek, Gemini, Codex, Claude, Durable Pi) with stable exit codes (`0`–`5`) and token-efficient structured JSON (`--format agent-summary`).

## Invocation

- **Global / PATH**:
  ```bash
  aeg check --format agent-summary
  ```
- **Local checkout (Windows PowerShell / cmd — works even if `.ps1` ExecutionPolicy is restricted)**:
  ```powershell
  & "<path-to-ai-engineering-guard>\bin\aeg.cmd" check --format agent-summary --cwd <repo-path>
  # or directly with Node:
  node "<path-to-ai-engineering-guard>/bin/aeg.js" check --format agent-summary --cwd <repo-path>
  ```

## Standard Workflow

1. **Initialize a new repo** (if `.engineering-guard/` does not exist yet):
   ```bash
   aeg init --cwd <repo-path>
   aeg config validate --cwd <repo-path>
   ```
2. **Run local check after edits** (default `balanced` mode, minimal token output; works from any subdirectory):
   ```bash
   aeg check --format agent-summary --cwd <repo-path>
   ```
3. **Run delivery / PR gate** (deep analysis + strict policy):
   ```bash
   aeg check --mode deep --policy delivery --format agent-summary --cwd <repo-path>
   ```
4. **Progressive failure inspection** (only when `outcome` is `failed` or `error`):
   ```bash
   aeg inspect failure --format json --cwd <repo-path>
   aeg inspect log <failure-id> --start 1 --lines 80 --format json --cwd <repo-path>
   ```
5. **Explainability**:
   ```bash
   aeg explain risk --format json --cwd <repo-path>
   aeg explain test <suite-id> --format json --cwd <repo-path>
   ```
6. **SARIF / JUnit & Cross-Platform Aggregation (Durable Pi / CI)**:
   ```bash
   aeg check --policy pull-request --sarif .aeg/reports/aeg.sarif --junit .aeg/reports/aeg-junit.xml --cwd <repo-path>
   aeg aggregate --plan .aeg/plans/current.json --receipts <receipts-dir> --policy delivery --format json --cwd <repo-path>
   ```
7. **Zero-Dependency Dual-Framing MCP Server (`aeg-mcp`)**:
   - Command: `node "<path-to-ai-engineering-guard>/bin/aeg-mcp.js"` (run `aeg agents config --agent all` to print exact machine-specific configs for Codex TOML, Gemini JSON, DeepSeek, and Claude Code).

## Exit Code & Decision Contract

| Exit Code | Meaning | Required Agent Behavior |
|---:|---|---|
| `0` | Passed (`continue` or `require_approval`) | If `workflow_action === "require_approval"`, notify user that human approval is required (e.g. L4). |
| `1` | Test failure | Inspect failures via `aeg inspect failure`, fix code, re-run `aeg check`. |
| `2` | Gate rejected (policy relaxation / dirty worktree) | Fix gate violation; do NOT relax `.engineering-guard/*.yaml`. |
| `3` | Config schema error | Run `aeg config validate` and repair YAML. |
| `4` | Runner / tool / environment error | Inspect error details; do NOT treat as passed. |
| `5` | Incomplete evidence (`unknowns`, uncovered module, blocked platform) | Resolve unknowns/coverage or escalate to human; never claim passed. |

## Non-Negotiable Rules

- Never modify `.engineering-guard/` to delete suites, lower risk overrides, or disable checks just to pass a gate.
- Never paste raw full test logs into agent context; rely on `agent-summary` and bounded `aeg inspect log` excerpts.
