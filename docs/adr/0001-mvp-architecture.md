# ADR 0001: MVP Architecture, Trust Boundaries, and Universal Agent Protocol

- Status: Accepted
- Date: 2026-11-21
- Reference: AI Engineering Guard Design Document V1.4 (Sections 5, 8, 10, 17, 20, 24)

## Decisions

1. **Single Authoritative Core & Distribution**: TypeScript + ESM Node.js (>=20) single npm package (`ai-engineering-guard`) with CLI `aeg` (`bin/aeg.js` + Windows `bin/aeg.cmd`). Direct runtime dependencies strictly kept minimal (`ajv`, `picomatch`, `yaml` = 3 dependencies, well below the <=12 budget).
2. **Zero Daemon / Zero Heavy Runtime Dependencies**: Single-process short-lived CLI. No background daemon, no central database, no bundled Nx/moon/Pants/Bazel/GitNexus/browsers.
3. **Unified Pipeline & Capability Planner**: `fast`, `balanced`, `deep`, and `release` share a single `runQualityPipeline` and `CapabilityPlanner` with `EvidenceEnvelope<T>`. Only one authoritative provider runs per evidence category by default.
4. **Trust Boundary & Anti-Relaxation**: Final gate always compares the working-tree candidate config against the protected baseline `PolicySnapshot` (read via `git show <base>:.engineering-guard/...`). Candidate config may tighten checks but cannot delete suites, modify baseline test commands, lower risk overrides, expand cache, or drop gate blocking rules.
5. **Exact Git Tree Local Cache Only in MVP**: `.aeg/cache/index.json` uses atomic temp-file writes, SHA-256 entry integrity verification, self-healing on index corruption, LRU/size pruning, and binds `repositoryTreeHash` (including dirty/untracked file contents) + `configDigest` + `policyDigest` + `ExecutionEnvironment`. Cross-commit Suite fingerprinting stays disabled in MVP.
6. **Structured Command Execution**: Commands execute via `executable` + `args` (`shell: false` by default), workspace `cwd` boundary checks, sanitized environment allowlists, bounded secret-redacted logs, and full process-tree termination (`taskkill /T /F` on Windows, negative PID group kill on POSIX).
7. **Universal Multi-Agent Compatibility**: All agents (DeepSeek, Gemini, Codex, Claude, Durable Pi) consume identical exit codes (`0`–`5`) and `--format agent-summary` JSON, backed by `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, OpenAI/DeepSeek `tools.json` + `tool-dispatcher.mjs`, and shared `SKILL.md`.
