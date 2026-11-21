# GEMINI.md — AI Engineering Guard (AEG)

This repository uses **AI Engineering Guard (`aeg`)** as its deterministic, model-agnostic engineering quality engine.

## Required Workflow for Gemini / Antigravity Agents

1. After editing code, run:
   - Windows: `node ./bin/aeg.js check --format agent-summary` (or `.\bin\aeg.cmd check --format agent-summary`)
   - Linux / macOS: `aeg check --format agent-summary`
2. For agent delivery or PR checks, run with `--mode deep --policy delivery` (or `--policy pull-request`).
3. If `outcome !== "passed"`:
   - Use `aeg explain risk --format json` to understand risk triggers.
   - Use `aeg inspect failure --format json` and `aeg inspect log <failure-id> --lines 80` to read bounded, secret-redacted failure logs.
4. Never weaken `.engineering-guard/*.yaml` to bypass failures; AEG compares against the protected baseline `PolicySnapshot` and blocks candidate relaxations.

See also [AGENTS.md](./AGENTS.md) and [docs/AGENT-ADAPTATION.md](./docs/AGENT-ADAPTATION.md).
