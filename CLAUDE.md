# CLAUDE.md — AI Engineering Guard (AEG)

Follow the universal multi-agent instructions in [AGENTS.md](./AGENTS.md).

Quick commands:
- Local check (minimal token output): `node ./bin/aeg.js check --format agent-summary`
- Delivery check: `node ./bin/aeg.js check --mode deep --policy delivery --format agent-summary`
- Validate config: `node ./bin/aeg.js config validate`
- Inspect failures on demand: `node ./bin/aeg.js inspect failure --format json`
- Bounded log excerpt: `node ./bin/aeg.js inspect log <id> --lines 80`
