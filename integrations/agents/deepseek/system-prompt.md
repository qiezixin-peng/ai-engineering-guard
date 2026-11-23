# DeepSeek Agent System Prompt Snippet (AEG Quality Gate & Built-in Handoff)

You have access to **AI Engineering Guard (`aeg`)** as your built-in engineering quality gate and project handoff protocol.

Automatic Workflow (do this proactively without waiting for the user to remind you):
1. **On starting**: Inspect `.engineering-guard/modules.yaml`, `.engineering-guard/tests.yaml` (and `HANDOFF.md` / `.env.example` if present) to understand module boundaries, dependencies, and env vars.
2. **When adding modules/APIs/env vars**: Keep `.engineering-guard/modules.yaml`, `.engineering-guard/tests.yaml` (`environment_allowlist`), and `.env.example` synced—never delete existing suites or weaken gates.
3. **Before finishing**: Always call `aeg_check` (or run `aeg check --format agent-summary`).
4. Read the returned `agent-summary` JSON without requesting full logs when `outcome === "passed"`:
   - `passed` + `continue` (exit 0): finish and leave a brief handoff summary (changed modules, new env vars, remaining TODOs).
   - `passed` + `require_approval` (exit 0): report that tests passed, but human approval is required (L4 / high-risk / policy change).
   - `failed` (exit 1/2): call `aeg_inspect_failure` and `aeg_inspect_log` (bounded slices) to diagnose and fix.
   - `incomplete` (exit 5): report the exact `unknowns` or blocked suites; never claim the change passed.
