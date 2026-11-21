import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImpactProvider } from '../../src/analyze/capability-planner.js';
import { runQualityPipeline } from '../../src/engine.js';

const tempDirs: string[] = [];

function createGoldenRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeg-golden-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'golden@example.com'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Golden'], { cwd: dir, windowsHide: true });

  fs.mkdirSync(path.join(dir, 'src/core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/auth'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.engineering-guard'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'src/core/calc.ts'), 'export const calc = (x: number) => x + 1;\n');
  fs.writeFileSync(path.join(dir, 'src/core/api.ts'), 'export interface PublicApi { v: 1 }\n');
  fs.writeFileSync(path.join(dir, 'src/auth/guard.ts'), 'export const checkAuth = () => true;\n');
  fs.writeFileSync(path.join(dir, 'src/ui/view.ts'), 'export const render = () => "ok";\n');

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/config.yaml'),
    `schema_version: 1
project: { name: golden-app, baseline_ref: main }
analysis: { default_mode: balanced, auto_escalate: true, minimum_confidence: 0.75 }
risk:
  default_level: L2
  protected_modules: [auth]
  overrides:
    public_api_change: L3
    database_migration: L4
cache: { enabled: true, exact_tree: true }
gates:
  local: { block_on: [test_failure, invalid_config] }
  delivery: { require_clean_worktree: true, block_on: [test_failure, L4_unknown, invalid_config, policy_relaxation, incomplete] }
`,
  );

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/modules.yaml'),
    `schema_version: 1
modules:
  core:
    paths: [src/core/**]
    public_api_paths: [src/core/api.ts]
    contracts: [core-public-api]
  auth:
    paths: [src/auth/**]
    depends_on: [core]
    criticality: critical
  ui:
    paths: [src/ui/**]
    depends_on: [core]
`,
  );

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/tests.yaml'),
    `schema_version: 1
suites:
  core-unit:
    framework: command
    command: { executable: node, args: [-e, "process.exit(0)"] }
    covers: [core]
    level: unit
    critical: true
  auth-unit:
    framework: command
    command: { executable: node, args: [-e, "process.exit(0)"] }
    covers: [auth]
    level: unit
    critical: true
  ui-unit:
    framework: command
    command: { executable: node, args: [-e, "process.exit(0)"] }
    covers: [ui]
    level: unit
`,
  );

  fs.writeFileSync(path.join(dir, '.gitignore'), '.aeg/\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'golden baseline'], { cwd: dir, windowsHide: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Golden Scenarios & Fault Injection', () => {
  it('Golden 1: Protected auth module change => L4, auto-escalates to deep, passes with require_approval', async () => {
    const dir = createGoldenRepo();
    fs.writeFileSync(path.join(dir, 'src/auth/guard.ts'), 'export const checkAuth = () => true; // v2\n');

    const { report, exitCode } = await runQualityPipeline({
      workspaceRoot: dir,
      mode: 'fast',
      policy: 'local',
    });

    expect(exitCode).toBe(0);
    expect(report.requestedMode).toBe('fast');
    expect(report.mode).toBe('deep'); // Auto-escalated due to security_auth path!
    expect(report.risk.level).toBe('L4');
    expect(report.gate.outcome).toBe('passed');
    expect(report.gate.workflowAction).toBe('require_approval');
  });

  it('Golden 2: Public API change in core cascades to auth & ui, triggers L4 (auth protected) + all 3 suites', async () => {
    const dir = createGoldenRepo();
    fs.writeFileSync(path.join(dir, 'src/core/api.ts'), 'export interface PublicApi { v: 2 }\n');

    const { report, exitCode } = await runQualityPipeline({
      workspaceRoot: dir,
      mode: 'balanced',
      policy: 'local',
    });

    expect(exitCode).toBe(0);
    expect(report.impact.directlyChangedModules).toEqual(['core']);
    expect(report.impact.transitivelyAffectedModules).toEqual(['auth', 'ui']);
    expect(report.impact.affectedContracts).toEqual(['core-public-api']);
    expect(report.plan.suites.map((s) => s.suiteId).sort()).toEqual(['auth-unit', 'core-unit', 'ui-unit']);
  });

  it('Fault Injection: Crashing external provider never produces silent pass (returns incomplete)', async () => {
    const dir = createGoldenRepo();
    fs.writeFileSync(path.join(dir, 'src/ui/view.ts'), 'export const render = () => "v2";\n');

    const crashingProvider: ImpactProvider = {
      id: 'faulty-symbols',
      version: '0.0.1',
      category: 'symbol_graph',
      supportedModes: ['fast', 'balanced', 'deep', 'release'],
      estimatedCostMs: 10,
      priority: 100,
      isAvailable: () => true,
      async analyze() {
        throw new Error('Simulated provider crash');
      },
    };

    const { report, exitCode } = await runQualityPipeline({
      workspaceRoot: dir,
      mode: 'balanced',
      policy: 'local',
      extraProviders: [crashingProvider],
    });

    expect(exitCode).toBe(5);
    expect(report.gate.outcome).toBe('incomplete');
    expect(report.gate.workflowAction).toBe('block');
    expect(report.impact.unknowns.some((u) => u.includes('Simulated provider crash'))).toBe(true);
  });

  it('Fault Injection: Delivery policy blocks dirty working tree (exit code 2)', async () => {
    const dir = createGoldenRepo();
    fs.writeFileSync(path.join(dir, 'src/ui/view.ts'), 'export const render = () => "dirty";\n');

    const { report, exitCode } = await runQualityPipeline({
      workspaceRoot: dir,
      mode: 'balanced',
      policy: 'delivery',
    });

    expect(exitCode).toBe(2);
    expect(report.gate.outcome).toBe('failed');
    expect(report.gate.reasons.some((r) => r.code === 'dirty_worktree')).toBe(true);
  });
});
