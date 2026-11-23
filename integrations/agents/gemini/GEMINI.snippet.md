## Engineering Quality Gate & Built-in Handoff (AEG)

Follow this automatically on every task without waiting for reminders:
- **Pickup**: Read `.engineering-guard/modules.yaml`, `.engineering-guard/tests.yaml` (and `HANDOFF.md` / `.env.example` if present) before editing.
- **Sync**: Update `.engineering-guard/modules.yaml`, `.engineering-guard/tests.yaml`, and `.env.example` when adding modules, dependencies, public APIs, or env vars (never relax `.engineering-guard/` policies or delete suites).
- **Gate**: Run `aeg check --format agent-summary` (Windows: `aeg.cmd check --format agent-summary`) before finishing; use `--mode deep --policy delivery` for delivery/PR checks.
- **Diagnose**: On failure or incomplete gate, run `aeg explain risk --format json`, `aeg inspect failure --format json`, and `aeg inspect log <failure-id> --lines 80`.
