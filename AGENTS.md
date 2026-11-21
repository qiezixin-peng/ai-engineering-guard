# AI Engineering Guard (AEG) — Agent Instructions

All AI agents working in this repository (Codex, Gemini, DeepSeek, Claude, Durable Pi) MUST use `aeg` as the unified engineering quality gate.

## Standard Verification Loop

1. Before committing or finishing a task, run:
   - Windows (PowerShell / cmd): `.\bin\aeg.cmd check --format agent-summary` (or `node ./bin/aeg.js check --format agent-summary`)
   - Linux / macOS: `aeg check --format agent-summary`
2. Always prefer `--format agent-summary` to minimize context/token consumption.
3. Inspect the JSON fields `outcome`, `workflow_action`, `risk.level`, `tests`, `unknowns`, and `agent_action`:
   - `outcome: "passed"` + `workflow_action: "continue"` (exit code `0`) -> safe to proceed.
   - `outcome: "passed"` + `workflow_action: "require_approval"` (exit code `0`) -> stop and ask a human reviewer to approve (e.g. L4 / security / DB / policy change).
   - `outcome: "failed"` (exit code `1` or `2`) -> inspect failures with `aeg inspect failure` and `aeg inspect log <id> --lines 80`.
   - `outcome: "incomplete"` (exit code `5`) -> do NOT treat as passed; resolve missing coverage, unknowns, or blocked platform requirements.
   - Exit code `3` -> fix `.engineering-guard/*.yaml` schema errors (`aeg config validate`).

## Hard Safety Rules for All Agents

- NEVER edit `.engineering-guard/*.yaml` to delete test suites, weaken risk overrides, remove regressions, or relax gates to make a check pass. AEG enforces the protected baseline `PolicySnapshot` and blocks unauthorized relaxations.
- NEVER dump full test logs into your prompt when tests pass. Only expand failure artifacts via `aeg inspect failure` / `aeg inspect log <id>` on demand.
- NEVER bypass `aeg` exit codes `1`, `2`, `3`, `4`, or `5`.
