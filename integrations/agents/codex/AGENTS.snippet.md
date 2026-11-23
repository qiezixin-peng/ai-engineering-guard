## Quality Gate & Built-in Handoff (AI Engineering Guard)

Follow this automatically on every task without waiting for reminders:
1. **Pickup**: Read `.engineering-guard/modules.yaml`, `.engineering-guard/tests.yaml` (and `HANDOFF.md` / `.env.example` if present) before editing.
2. **Sync**: When adding modules, dependencies, public APIs, tests, or env vars, update `.engineering-guard/modules.yaml`, `.engineering-guard/tests.yaml`, and `.env.example` (never delete existing suites or lower risk rules).
3. **Gate**: Before finishing or committing, run `aeg check --format agent-summary` (or `node "<path-to-ai-engineering-guard>/bin/aeg.js" check --format agent-summary`) and respect exit codes `0`–`5` and `workflow_action`.
4. **Diagnose**: On failure, inspect with `aeg inspect failure --format json` and `aeg inspect log <id> --lines 80`.
