## Quality Gate (AI Engineering Guard)

Before finalizing code edits or committing:
1. Run `aeg check --format agent-summary` (or `node "<path-to-ai-engineering-guard>/bin/aeg.js" check --format agent-summary`).
2. Respect exit codes `0`–`5` and `workflow_action` (`continue` / `require_approval` / `block`).
3. On failure, inspect with `aeg inspect failure --format json` and `aeg inspect log <id> --lines 80`.
4. Do NOT edit `.engineering-guard/*.yaml` to weaken tests or lower risk rules.
