# Changelog

All notable changes to **AI Engineering Guard (`aeg`)** are documented in this file.

## [0.0.1] - 2026-11-21

### Initial Release (`V0.0.1`)

- **Core Single-Process Quality Engine (`aeg`)**:
  - Unified pipeline (`analyze -> capability-plan -> impact -> risk -> test-plan -> test -> gate`) with 4 modes (`fast`, `balanced`, `deep`, `release`) and auto-escalation on high-sensitivity changes.
  - JSON Schema validation (`schemas/*.schema.json`), Suite DAG cycle detection, workspace `cwd` boundary enforcement, and Protected Baseline `PolicySnapshot` anti-relaxation gate.
  - Deterministic `L0`–`L4` risk assessment, reverse-dependency module impact graph, layered conservative fallback, suite deduplication, and strict 5-state disposition (`execute`, `reuse_cache`, `not_required`, `blocked`, `execution_failed`).
  - Safe structured command execution (`shell: false` default), environment allowlists, secret redaction, and full process-tree termination on timeout/cancel (Windows + POSIX).
- **On-Demand Enhanced Providers & Caching**:
  - Zero-bloat built-in & on-demand providers: `builtin-module`, `existing-build-graph` (Nx / moon / Pants / Bazel), `import-graph`, `ast-symbols` (TS/JS/Python), optional user-installed `gitnexus`, `coverage-impact` (Istanbul/LCOV), and `contracts-db` (OpenAPI/GraphQL/Proto/Prisma + destructive SQL detection).
  - Exact Git Tree local CAS cache (`.aeg/cache/index.json`) with integrity checks & self-healing, Phase 2 `SuiteInputFingerprint` shadow verification with instant revocation on mismatch, and Phase 4 HMAC-SHA256 signed, tenant/platform-isolated remote cache (`remote-dir` / `remote-http`).
- **CI, Cross-Device Durable Pi & Observability**:
  - On-demand SARIF 2.1.0 & JUnit XML output + GitHub Actions, GitLab CI, and Azure DevOps templates.
  - Durable Pi 3-platform (`windows` / `linux` / `macos`) executor router (`buildExecutionMatrix`) and Coordinator `TestResultReceipt` aggregator (`aeg aggregate`) with replay protection, monotonic attempt fencing, and HMAC signature verification.
  - Budget-controlled shadow full-run validation (`aeg shadow-check`), historical failure-rate fail-fast sorting, offline multi-project HTML quality dashboard (`aeg dashboard`), and safe config migration (`aeg config migrate`).
- **Universal Multi-Agent Compatibility (Gemini / Codex / DeepSeek / Claude / Durable Pi)**:
  - Zero-dependency dual-framing stdio MCP Server (`aeg-mcp`, 16 tools, NDJSON + `Content-Length`, protocol versions `2024-11-05` / `2025-03-26` / `2025-06-18`).
  - Token-efficient `--format agent-summary` JSON with unified error envelope (exit codes `0`–`5`), bounded total excerpt budget, progressive failure inspection (`aeg inspect failure|log`), and subdirectory root auto-resolution.
  - Turnkey integration pack: `aeg agents config`, `aeg agents install`, `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, universal `SKILL.md`, and Node + Python OpenAI/DeepSeek function-calling tool dispatchers.
