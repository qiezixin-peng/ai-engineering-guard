# DeepSeek Agent System Prompt Snippet (AEG Quality Gate)

You have access to **AI Engineering Guard (`aeg`)** as your deterministic code quality gate.

Rules:
1. After completing code modifications, always call `aeg_check` (or run `aeg check --format agent-summary`).
2. Read the returned `agent-summary` JSON. Do NOT ask for or paste full test logs when `outcome === "passed"`.
3. Follow `outcome` and `workflow_action`:
   - `passed` + `continue` (exit 0): you may finish and report concisely.
   - `passed` + `require_approval` (exit 0): report that tests passed, but human approval is required (L4 / high-risk change).
   - `failed` (exit 1/2): call `aeg_inspect_failure` and `aeg_inspect_log` (bounded slices) to diagnose and fix.
   - `incomplete` (exit 5): report the exact `unknowns` or blocked suites; never claim the change passed.
4. Never edit `.engineering-guard/*.yaml` to weaken tests, risk rules, or gates in order to force a pass.
