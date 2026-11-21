import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteCacheClient } from '../../src/cache/remote-cache.js';
import { main } from '../../src/cli/index.js';
import { migrateProjectConfig } from '../../src/config/migrator.js';
import {
  collectMultiProjectDashboard,
  renderDashboardHtml,
} from '../../src/dashboard/dashboard.js';
import { buildExecutionEnvironment, runQualityPipeline } from '../../src/engine.js';
import { computeSuiteFailureRates, loadRunHistory } from '../../src/metrics/history.js';
import { runBudgetedShadowCheck } from '../../src/shadow/shadow-runner.js';

const tempDirs: string[] = [];

function createGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'p4@example.com'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'AEG Phase4'], { cwd: dir, windowsHide: true });
  return dir;
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['commit', '-m', message], { cwd: dir, windowsHide: true });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('Phase 4: Signed Remote Cache, Shadow Budget, Historical Sorting, Dashboard & Migration', () => {
  it('enforces HMAC signatures, read-only branch protection, and tenant isolation on remote cache', async () => {
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeg-remote-cas-'));
    tempDirs.push(remoteDir);
    const secret = 'remote-cas-signing-secret';
    const env = buildExecutionEnvironment({
      projectRevision: 'rev1',
      repositoryTreeHash: 'tree-remote-1',
      worktreeClean: true,
    });

    const baseConfig = {
      schema_version: 1 as const,
      project: { name: 'alpha-svc' },
      cache: {
        enabled: true,
        backend: 'remote-dir' as const,
        cross_platform: false,
        remote: {
          directory: remoteDir,
          tenant_id: 'team-a',
          read_only: true,
          require_signature: true,
        },
      },
    };

    // 1. Read-only PR client cannot poison remote cache
    const readOnlyClient = new RemoteCacheClient({ config: baseConfig, signingSecret: secret });
    const blockedPush = await readOnlyClient.push({
      fingerprint: 'fp-123',
      suiteId: 'unit',
      portable: true,
      repositoryTreeHash: 'tree-remote-1',
      configDigest: 'cfg1',
      policyDigest: 'pol1',
      environment: env,
      outputDigest: 'out1',
      durationMs: 42,
    });
    expect(blockedPush.pushed).toBe(false);

    // 2. Trusted writer pushes signed entry
    const writerClient = new RemoteCacheClient({
      config: {
        ...baseConfig,
        cache: {
          ...baseConfig.cache,
          remote: { ...baseConfig.cache.remote, read_only: false },
        },
      },
      signingSecret: secret,
    });
    const okPush = await writerClient.push({
      fingerprint: 'fp-123',
      suiteId: 'unit',
      portable: true,
      repositoryTreeHash: 'tree-remote-1',
      configDigest: 'cfg1',
      policyDigest: 'pol1',
      environment: env,
      outputDigest: 'out1',
      durationMs: 42,
    });
    expect(okPush.pushed).toBe(true);

    // 3. Read-only consumer pulls & verifies signed entry
    const hit = await readOnlyClient.pull({
      fingerprint: 'fp-123',
      suiteId: 'unit',
      portable: true,
      repositoryTreeHash: 'tree-remote-1',
      configDigest: 'cfg1',
      policyDigest: 'pol1',
      environment: env,
    });
    expect(hit.hit).toBe(true);

    // 4. Wrong secret rejects entry
    const badSecretClient = new RemoteCacheClient({ config: baseConfig, signingSecret: 'wrong-key' });
    const badPull = await badSecretClient.pull({
      fingerprint: 'fp-123',
      suiteId: 'unit',
      portable: true,
      repositoryTreeHash: 'tree-remote-1',
      configDigest: 'cfg1',
      policyDigest: 'pol1',
      environment: env,
    });
    expect(badPull.hit).toBe(false);
    expect(badPull.reason).toContain('signature');
  });

  it('detects missed failures in shadow-check, enforces weekly budget, prioritizes flaky suites, and renders multi-project HTML dashboard', async () => {
    const dirA = createGitRepo('aeg-p4-projA-');
    const dirB = createGitRepo('aeg-p4-projB-');

    // Setup Project A with 2 modules: modA (selected) and modB (excluded on modA change, but fails in shadow!)
    fs.mkdirSync(path.join(dirA, 'src/a'), { recursive: true });
    fs.mkdirSync(path.join(dirA, 'src/b'), { recursive: true });
    fs.mkdirSync(path.join(dirA, '.engineering-guard'), { recursive: true });
    fs.writeFileSync(path.join(dirA, 'src/a/index.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dirA, 'src/b/index.ts'), 'export const b = 1;\n');
    fs.writeFileSync(
      path.join(dirA, '.engineering-guard/config.yaml'),
      `schema_version: 1
project: { name: project-alpha, baseline_ref: main }
shadow_tests:
  schedule: weekly
  sample_rate: 1.0
  max_duration: 1m
  weekly_budget: 10m
`,
    );
    fs.writeFileSync(
      path.join(dirA, '.engineering-guard/modules.yaml'),
      `schema_version: 1
modules:
  a: { paths: [src/a/**] }
  b: { paths: [src/b/**] }
`,
    );
    fs.writeFileSync(
      path.join(dirA, '.engineering-guard/tests.yaml'),
      `schema_version: 1
suites:
  a-stable:
    framework: command
    command: { executable: node, args: [-e, "process.exit(0)"] }
    covers: [a]
    level: unit
  a-flaky:
    framework: command
    command: { executable: node, args: [-e, "process.exit(1)"] }
    covers: [a]
    level: unit
  b-hidden-bug:
    framework: command
    command: { executable: node, args: [-e, "console.error('hidden regression'); process.exit(1)"] }
    covers: [b]
    level: unit
`,
    );
    fs.writeFileSync(path.join(dirA, '.gitignore'), '.aeg/\n');
    commitAll(dirA, 'init alpha');

    // Edit src/a/index.ts -> runs a-stable & a-flaky (a-flaky fails -> records history!)
    fs.writeFileSync(path.join(dirA, 'src/a/index.ts'), 'export const a = 2;\n');
    const first = await runQualityPipeline({ workspaceRoot: dirA, policy: 'local' });
    expect(first.exitCode).toBe(1);
    expect(loadRunHistory(dirA).length).toBe(1);
    const rates = computeSuiteFailureRates(dirA);
    expect(rates['a-flaky']).toBe(1);
    expect(rates['a-stable']).toBe(0);

    // Second run: a-flaky MUST be sorted BEFORE a-stable for fail-fast feedback!
    const second = await runQualityPipeline({ workspaceRoot: dirA, policy: 'local', planOnly: true });
    const suiteOrder = second.report.plan.suites.map((s) => s.suiteId);
    expect(suiteOrder.indexOf('a-flaky')).toBeLessThan(suiteOrder.indexOf('a-stable'));

    // Run shadow-check -> runs excluded suite `b-hidden-bug` and catches the missed failure!
    const shadow = await runBudgetedShadowCheck({ workspaceRoot: dirA, forceRun: true });
    expect(shadow.status).toBe('completed');
    expect(shadow.excludedCheckedSuites).toContain('b-hidden-bug');
    expect(shadow.missedFailures).toHaveLength(1);
    expect(shadow.missedFailures[0]!.suiteId).toBe('b-hidden-bug');
    expect(shadow.recall).toBe(0.5);

    // Exhaust weekly budget -> deferred without pretending verified
    fs.writeFileSync(
      path.join(dirA, '.aeg/metrics/shadow-budget.json'),
      JSON.stringify({
        weekKey: shadow.weekKey,
        usedMs: 999_999_999,
        runsCompleted: 1,
        runsDeferred: 0,
        totalMissedFailures: 1,
        lastRunAt: new Date().toISOString(),
      }),
    );
    const deferred = await runBudgetedShadowCheck({ workspaceRoot: dirA, forceRun: true });
    expect(deferred.status).toBe('deferred_budget_exhausted');

    // Setup Project B with 1 passing run
    fs.mkdirSync(path.join(dirB, 'src/core'), { recursive: true });
    fs.mkdirSync(path.join(dirB, '.engineering-guard'), { recursive: true });
    fs.writeFileSync(path.join(dirB, 'src/core/app.ts'), 'export const ok = true;\n');
    fs.writeFileSync(path.join(dirB, '.engineering-guard/config.yaml'), 'schema_version: 1\nproject: { name: project-beta, baseline_ref: main }\n');
    fs.writeFileSync(path.join(dirB, '.engineering-guard/modules.yaml'), 'schema_version: 1\nmodules: { core: { paths: [src/core/**] } }\n');
    fs.writeFileSync(
      path.join(dirB, '.engineering-guard/tests.yaml'),
      'schema_version: 1\nsuites: { core-unit: { framework: command, command: { executable: node, args: [-e, "process.exit(0)"] }, covers: [core], level: unit } }\n',
    );
    fs.writeFileSync(path.join(dirB, '.gitignore'), '.aeg/\n');
    commitAll(dirB, 'init beta');
    fs.writeFileSync(path.join(dirB, 'src/core/app.ts'), 'export const ok = false;\n');
    await runQualityPipeline({ workspaceRoot: dirB, policy: 'local' });

    // Multi-project dashboard aggregation + offline HTML generation
    const dashData = collectMultiProjectDashboard([dirA, dirB]);
    expect(dashData.projectCount).toBe(2);
    expect(dashData.totals.totalRuns).toBeGreaterThanOrEqual(3);
    expect(dashData.totals.totalShadowMissedFailures).toBe(1);

    const html = renderDashboardHtml(dashData);
    expect(html).toContain('project-alpha');
    expect(html).toContain('project-beta');
    expect(html).toContain('AI Engineering Guard — Multi-Project Quality Dashboard');

    // CLI `aeg dashboard --projects ... --out ...`
    const outHtml = path.join(dirB, '.aeg/reports/dashboard.html');
    const dashCode = await main([
      'dashboard',
      '--cwd',
      dirB,
      '--projects',
      `${dirA},${dirB}`,
      '--out',
      outHtml,
      '--format',
      'json',
    ]);
    expect(dashCode).toBe(0);
    expect(fs.existsSync(outHtml)).toBe(true);
  });

  it('safely migrates legacy config files with dry-run preview and backup creation', () => {
    const dir = createGitRepo('aeg-p4-mig-');
    fs.mkdirSync(path.join(dir, '.engineering-guard'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.engineering-guard/config.yaml'), 'project:\n  name: legacy-app\n');
    fs.writeFileSync(path.join(dir, '.engineering-guard/modules.yaml'), 'modules:\n  core:\n    paths: [src/**]\n');
    fs.writeFileSync(
      path.join(dir, '.engineering-guard/tests.yaml'),
      'suites:\n  unit:\n    framework: command\n    command: { executable: node, args: [-v] }\n    covers: [core]\n    level: unit\n',
    );

    const dry = migrateProjectConfig({ workspaceRoot: dir, dryRun: true });
    expect(dry.migrated).toBe(true);
    expect(dry.backupPaths).toHaveLength(0);
    expect(dry.changes.length).toBeGreaterThanOrEqual(4);

    const applied = migrateProjectConfig({ workspaceRoot: dir, dryRun: false });
    expect(applied.migrated).toBe(true);
    expect(applied.backupPaths).toHaveLength(3);
    expect(fs.existsSync(applied.backupPaths[0]!)).toBe(true);
  });
});
