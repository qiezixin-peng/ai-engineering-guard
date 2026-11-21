## Engineering Quality Gate (AEG)

Use `aeg` as the deterministic quality verification command after edits:
- Windows: `& "<path-to-ai-engineering-guard>\bin\aeg.cmd" check --format agent-summary`
- Cross-platform: `aeg check --format agent-summary`
- Delivery gate: `aeg check --mode deep --policy delivery --format agent-summary`

On failure or incomplete gate:
- Inspect risk: `aeg explain risk --format json`
- Inspect failure: `aeg inspect failure --format json`
- Read bounded log: `aeg inspect log <failure-id> --lines 80`
- Never relax `.engineering-guard/` policies to force a pass.
