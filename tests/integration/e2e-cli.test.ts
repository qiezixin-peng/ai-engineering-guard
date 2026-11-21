import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { currentPlatform } from '../../src/domain/hash.js';
import { runQualityPipeline } from '../../src/engine.js';
// @ts-ignore JS bridge tested directly
import { dispatchAegToolCall } from '../../integrations/agents/deepseek/tool-dispatcher.mjs';

const tempDirs: string[] = [];

function createGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'aeg-test@example.com'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'AEG Test'], { cwd: dir, windowsHide: true });
  return dir;
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['commit', '-m', message], { cwd: dir, windowsHide: true });
}

function setupSampleProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src/music'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/playlist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/orphan'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.engineering-guard'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'README.md'), '# Sample Repo\n');
  fs.writeFileSync(path.join(dir, 'src/music/index.ts'), 'export function play() { return 1; }\n');
  fs.writeFileSync(path.join(dir, 'src/playlist/index.ts'), 'export function list() { return []; }\n');
  fs.writeFileSync(path.join(dir, 'src/orphan/index.ts'), 'export const orphan = true;\n');

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/config.yaml'),
    `schema_version: 1
project:
  name: sample-music
  languages: [typescript]
  baseline_ref: main
analysis:
  default_mode: balanced
  auto_escalate: true
risk:
  default_level: L2
  protected_modules: []
cache:
  enabled: true
  backend: local
  directory: .aeg/cache
  exact_tree: true
gates:
  local:
    block_on: [test_failure, invalid_config]
  pull-request:
    block_on: [test_failure, L4_unknown, invalid_config, policy_relaxation]
  delivery:
    require_clean_worktree: true
    block_on: [test_failure, L4_unknown, invalid_config, policy_relaxation, incomplete]
`,
  );

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/modules.yaml'),
    `schema_version: 1
modules:
  music:
    paths: [src/music/**]
    depends_on: []
    criticality: normal
  playlist:
    paths: [src/playlist/**]
    depends_on: [music]
    criticality: normal
  orphan:
    paths: [src/orphan/**]
    depends_on: []
    criticality: normal
`,
  );

  const otherPlatform = currentPlatform() === 'macos' ? 'linux' : 'macos';

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/tests.yaml'),
    `schema_version: 1
suites:
  music-unit:
    framework: command
    command:
      executable: node
      args: [-e, "console.log('music-unit ok')"]
      cwd: .
      timeout: 30s
    covers: [music]
    level: unit
    critical: true
  playlist-unit:
    framework: command
    command:
      executable: node
      args: [-e, "console.log('playlist-unit ok')"]
      cwd: .
      timeout: 30s
    covers: [playlist]
    level: unit
  failing-suite:
    framework: command
    command:
      executable: node
      args: [-e, "console.error('AssertionError: expected 1 to be 2 at src/playlist/index.ts:1:1'); process.exit(1)"]
      cwd: .
      timeout: 30s
    covers: [playlist]
    level: integration
  other-os-suite:
    framework: command
    command:
      executable: node
      args: [-e, "console.log('other os')"]
      cwd: .
      timeout: 30s
    covers: [music]
    level: e2e
    platforms: [${otherPlatform}]
regressions: []
`,
  );

  fs.writeFileSync(path.join(dir, '.gitignore'), '.aeg/\n');
  commitAll(dir, 'initial commit');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('End-to-End Pipeline & CLI Integration', () => {
  it('completes init + config validate on a fresh git repo', async () => {
    const dir = createGitRepo('aeg-init-');
    fs.mkdirSync(path.join(dir, 'src/auth'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/auth/login.ts'), 'export const ok = true;\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fresh-app', scripts: { test: 'node -v' } }));
    commitAll(dir, 'init');

    const initCode = await main(['init', '--cwd', dir, '--format', 'json']);
    expect(initCode).toBe(0);
    const valCode = await main(['config', 'validate', '--cwd', dir, '--format', 'json']);
    expect(valCode).toBe(0);
  });

  it('handles docs-only L0, local change + exact cache hit + invalidation on edit', async () => {
    const dir = createGitRepo('aeg-e2e-');
    setupSampleProject(dir);

    // 1. Docs-only change -> L0, passed, suites not_required
    fs.writeFileSync(path.join(dir, 'README.md'), '# Updated docs\n');
    const docsRes = await runQualityPipeline({ workspaceRoot: dir, policy: 'local' });
    expect(docsRes.exitCode).toBe(0);
    expect(docsRes.report.risk.level).toBe('L0');
    expect(docsRes.report.gate.outcome).toBe('passed');
    expect(docsRes.report.plan.excludedSuites.length).toBe(4);
    expect(docsRes.report.plan.excludedSuites.every((s) => s.disposition === 'not_required')).toBe(true);

    // 2. Edit playlist (single leaf module, L1 -> runs only playlist-unit, NOT failing-suite integration)
    fs.writeFileSync(path.join(dir, 'src/playlist/index.ts'), 'export function list() { return [1]; }\n');
    const firstRun = await runQualityPipeline({ workspaceRoot: dir, policy: 'local' });
    expect(firstRun.exitCode).toBe(0);
    expect(firstRun.report.risk.level).toBe('L1');
    expect(firstRun.report.results.map((r) => r.suiteId)).toEqual(['playlist-unit']);
    expect(firstRun.report.results[0]!.disposition).toBe('execute');
    expect(firstRun.report.agentSummary.tests.executed).toBe(1);
    expect(firstRun.report.agentSummary.tests.cached).toBe(0);

    // 3. Re-run on identical working tree -> exact Git Tree cache HIT
    const secondRun = await runQualityPipeline({ workspaceRoot: dir, policy: 'local' });
    expect(secondRun.exitCode).toBe(0);
    expect(secondRun.report.results[0]!.disposition).toBe('reuse_cache');
    expect(secondRun.report.results[0]!.cached).toBe(true);
    expect(secondRun.report.agentSummary.tests.cached).toBe(1);

    // 4. Modify file again -> cache MUST invalidate
    fs.writeFileSync(path.join(dir, 'src/playlist/index.ts'), 'export function list() { return [1, 2]; }\n');
    const thirdRun = await runQualityPipeline({ workspaceRoot: dir, policy: 'local' });
    expect(thirdRun.exitCode).toBe(0);
    expect(thirdRun.report.results[0]!.disposition).toBe('execute');
    expect(thirdRun.report.results[0]!.cached).toBe(false);
  });

  it('blocks candidate policy relaxation against protected baseline PolicySnapshot', async () => {
    const dir = createGitRepo('aeg-tamper-');
    setupSampleProject(dir);

    // Tamper with candidate tests.yaml: delete music-unit!
    fs.writeFileSync(
      path.join(dir, '.engineering-guard/tests.yaml'),
      `schema_version: 1
suites:
  playlist-unit:
    framework: command
    command:
      executable: node
      args: [-e, "console.log('ok')"]
      cwd: .
    covers: [playlist]
    level: unit
regressions: []
`,
    );

    const res = await runQualityPipeline({ workspaceRoot: dir, policy: 'pull-request' });
    expect(res.report.policyContext.relaxations.length).toBeGreaterThan(0);
    expect(res.report.risk.level).toBe('L4');
    // Effective bundle still preserves deleted baseline suite music-unit!
    expect(res.report.plan.suites.some((s) => s.suiteId === 'music-unit')).toBe(true);
    expect(res.report.gate.workflowAction).toBe('block');
    expect(res.exitCode).not.toBe(0);
  });

  it('returns exit code 5 (incomplete) when affected module has no test coverage', async () => {
    const dir = createGitRepo('aeg-uncov-');
    setupSampleProject(dir);

    fs.writeFileSync(path.join(dir, 'src/orphan/index.ts'), 'export const orphan = false;\n');
    const res = await runQualityPipeline({ workspaceRoot: dir, policy: 'local' });
    expect(res.report.gate.outcome).toBe('incomplete');
    expect(res.report.gate.workflowAction).toBe('block');
    expect(res.exitCode).toBe(5);
  });

  it('returns exit code 1 with bounded failure excerpt on test failure and exit code 4 on timeout', async () => {
    const dir = createGitRepo('aeg-fail-');
    setupSampleProject(dir);

    // Edit music -> cascades to playlist (L2 -> runs playlist-unit + failing-suite integration!)
    fs.writeFileSync(path.join(dir, 'src/music/index.ts'), 'export function play() { return 2; }\n');
    const failRes = await runQualityPipeline({ workspaceRoot: dir, policy: 'local' });
    expect(failRes.exitCode).toBe(1);
    expect(failRes.report.gate.outcome).toBe('failed');
    expect(failRes.report.agentSummary.failures.length).toBe(1);
    expect(failRes.report.agentSummary.failures[0]!.category).toBe('assertion');
    expect(failRes.report.agentSummary.failures[0]!.location).toContain('src/playlist/index.ts');

    // Timeout test (process tree kill)
    const timeoutDir = createGitRepo('aeg-timeout-');
    setupSampleProject(timeoutDir);
    fs.writeFileSync(
      path.join(timeoutDir, '.engineering-guard/tests.yaml'),
      `schema_version: 1
suites:
  slow-unit:
    framework: command
    command:
      executable: node
      args: [-e, "setTimeout(() => {}, 15000)"]
      cwd: .
      timeout: 300ms
    covers: [playlist]
    level: unit
regressions: []
`,
    );
    commitAll(timeoutDir, 'add slow suite');
    fs.writeFileSync(path.join(timeoutDir, 'src/playlist/index.ts'), 'export function list() { return [9]; }\n');

    const timeoutRes = await runQualityPipeline({ workspaceRoot: timeoutDir, policy: 'local' });
    expect(timeoutRes.exitCode).toBe(4);
    expect(timeoutRes.report.gate.outcome).toBe('error');
    expect(timeoutRes.report.results[0]!.disposition).toBe('execution_failed');
    expect(timeoutRes.report.results[0]!.status).toBe('timeout');
  });

  it('returns exit code 5 (incomplete) when a required suite is blocked by platform mismatch', async () => {
    const dir = createGitRepo('aeg-plat-');
    setupSampleProject(dir);

    // Trigger L4 via DB migration so release/e2e/other-os-suite is selected
    fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'migrations/001_init.sql'), 'CREATE TABLE tracks (id INT);\n');
    fs.writeFileSync(path.join(dir, 'src/music/index.ts'), 'export function play() { return 3; }\n');

    const res = await runQualityPipeline({ workspaceRoot: dir, mode: 'release', policy: 'local', planOnly: true });
    const blockedSuite = res.report.plan.suites.find((s) => s.suiteId === 'other-os-suite');
    expect(blockedSuite?.disposition).toBe('blocked');
    expect(res.report.gate.outcome).toBe('incomplete');
  });

  it('works via DeepSeek/OpenAI tool-dispatcher.mjs bridge', () => {
    const dir = createGitRepo('aeg-ds-');
    setupSampleProject(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# DeepSeek check\n');

    const check = dispatchAegToolCall('aeg_check', { cwd: dir, mode: 'fast', policy: 'local' });
    expect(check.exitCode).toBe(0);
    expect(check.data.outcome).toBe('passed');
    expect(check.data.risk.level).toBe('L0');

    const risk = dispatchAegToolCall('aeg_explain_risk', { cwd: dir });
    expect(risk.exitCode).toBe(0);
    expect(risk.data.level).toBe('L0');
  });
});
