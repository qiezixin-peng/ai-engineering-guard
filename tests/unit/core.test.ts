import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { redactSensitiveText } from '../../src/adapters/command/command-runner.js';
import { classifyChangeSet } from '../../src/analyze/diff-analyzer.js';
import {
  BuiltinModuleImpactProvider,
  buildReverseDependencyGraph,
  computeTransitiveDownstream,
} from '../../src/analyze/impact-analyzer.js';
import { assessRisk } from '../../src/analyze/risk-engine.js';
import { CacheEngine } from '../../src/cache/cache-engine.js';
import { buildConfigBundle, diffConfigBundles } from '../../src/config/loader.js';
import { PACKAGE_ROOT, validateProjectConfigs } from '../../src/config/schema-validator.js';
import { buildExecutionEnvironment } from '../../src/engine.js';
import { buildTestPlan } from '../../src/plan/test-planner.js';
import type { ChangeSet, ModulesConfig, ProjectConfigBundle } from '../../src/domain/types.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Schema Validation & Templates', () => {
  it('validates shipped templates against JSON Schemas (zero drift)', () => {
    const dir = makeTempDir('aeg-tpl-');
    const cfg = YAML.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'templates/config.yaml'), 'utf8'));
    const mods = YAML.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'templates/modules.yaml'), 'utf8'));
    const tests = YAML.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'templates/tests.yaml'), 'utf8'));

    const res = validateProjectConfigs(dir, cfg, mods, tests);
    expect(res.valid).toBe(true);
    expect(res.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('rejects suite DAG cycles, once_per_change without portable, and cwd workspace escape', () => {
    const dir = makeTempDir('aeg-val-');
    const cfg = { schema_version: 1, project: { name: 'demo' } };
    const mods = { schema_version: 1, modules: { a: { paths: ['src/a/**'] } } };
    const tests = {
      schema_version: 1,
      suites: {
        s1: {
          framework: 'command',
          command: { executable: 'node', args: ['-v'], cwd: '../escape' },
          covers: ['a'],
          level: 'unit',
          depends_on: ['s2'],
          execution: 'once_per_change',
          portable: false,
        },
        s2: {
          framework: 'command',
          command: { executable: 'node', args: ['-v'], cwd: '.' },
          covers: ['a'],
          level: 'unit',
          depends_on: ['s1'],
        },
      },
    };

    const res = validateProjectConfigs(dir, cfg, mods, tests);
    expect(res.valid).toBe(false);
    const messages = res.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('escapes workspace');
    expect(messages).toContain('once_per_change');
    expect(messages).toContain('Cyclic suite dependency');
  });
});

describe('PolicySnapshot Diff & Anti-Relaxation', () => {
  const baseCfg = `
schema_version: 1
project: { name: demo }
risk:
  default_level: L2
  protected_modules: [auth]
  overrides:
    public_api_change: L3
cache:
  enabled: true
  cross_platform: false
gates:
  pull-request:
    block_on: [test_failure, L4_unknown, invalid_config]
`;
  const baseMods = `
schema_version: 1
modules:
  auth: { paths: [src/auth/**], criticality: critical }
  app: { paths: [src/app/**], depends_on: [auth] }
`;
  const baseTests = `
schema_version: 1
suites:
  auth-unit:
    framework: command
    command: { executable: node, args: [-e, "process.exit(0)"] }
    covers: [auth]
    level: unit
    cache: false
  app-unit:
    framework: command
    command: { executable: node, args: [-e, "process.exit(0)"] }
    covers: [app]
    level: unit
regressions:
  - id: BUG-1
    suite: auth-unit
    trigger_paths: [src/auth/**]
`;

  it('detects suite deletion, command edit, risk lowering, protected module removal, and cache expansion', () => {
    const dir = makeTempDir('aeg-pol-');
    const baseline = buildConfigBundle(dir, baseCfg, baseMods, baseTests, 'protected_baseline', 'main');

    const candCfg = `
schema_version: 1
project: { name: demo }
risk:
  default_level: L1
  protected_modules: []
  overrides:
    public_api_change: L1
cache:
  enabled: true
  cross_platform: true
gates:
  pull-request:
    block_on: [test_failure]
`;
    const candTests = `
schema_version: 1
suites:
  auth-unit:
    framework: command
    command: { executable: node, args: [-e, "console.log('bypassed')"] }
    covers: [auth]
    level: unit
    cache: true
regressions: []
`;
    const candidate = buildConfigBundle(dir, candCfg, baseMods, candTests, 'working_tree');
    const diffs = diffConfigBundles(baseline, candidate);
    const categories = new Set(diffs.filter((d) => d.kind === 'relaxation').map((d) => d.category));

    expect(categories.has('protected_module_removed')).toBe(true);
    expect(categories.has('risk_override_lowered')).toBe(true);
    expect(categories.has('suite_deleted')).toBe(true);
    expect(categories.has('suite_command_changed')).toBe(true);
    expect(categories.has('regression_removed')).toBe(true);
    expect(categories.has('cache_expanded')).toBe(true);
    expect(categories.has('gate_rule_relaxed')).toBe(true);
  });
});

describe('Reverse Dependency Graph & Test Deduplication', () => {
  it('propagates downstream along reverse edges (A depends_on B => B impacts A)', () => {
    const mods: ModulesConfig = {
      schema_version: 1,
      modules: {
        db: { paths: ['src/db/**'] },
        music: { paths: ['src/music/**'], depends_on: ['db'] },
        tagging: { paths: ['src/tagging/**'], depends_on: ['music'] },
        playlist: { paths: ['src/playlist/**'], depends_on: ['music', 'tagging'] },
        unrelated: { paths: ['src/unrelated/**'] },
      },
    };
    const rev = buildReverseDependencyGraph(mods);
    const downstream = computeTransitiveDownstream(['db'], rev).map((d) => d.moduleId).sort();
    expect(downstream).toEqual(['music', 'playlist', 'tagging']);
  });

  it('deduplicates suites mapped from multiple modules and preserves all selection reasons', async () => {
    const dir = makeTempDir('aeg-dedup-');
    const bundle: ProjectConfigBundle = buildConfigBundle(
      dir,
      `schema_version: 1\nproject: { name: music-app }\n`,
      `schema_version: 1\nmodules:\n  music: { paths: [src/music/**] }\n  tagging: { paths: [src/tagging/**], depends_on: [music] }\n  playlist: { paths: [src/playlist/**], depends_on: [music, tagging] }\n`,
      `schema_version: 1\nsuites:\n  shared-integration:\n    framework: command\n    command: { executable: node, args: [-v] }\n    covers: [music, tagging, playlist]\n    level: integration\nregressions:\n  - id: BUG-42\n    suite: shared-integration\n    trigger_paths: [src/music/**]\n`,
      'working_tree',
    );

    const changeSet: ChangeSet = classifyChangeSet(
      {
        repositoryId: 'repo1',
        baseRevision: 'aaa',
        headRevision: 'bbb',
        scope: 'combined',
        repositoryTreeHash: 'tree123',
        files: [{ path: 'src/music/player.ts', changeType: 'modified', additions: 5, deletions: 1, hunks: [] }],
        commits: [],
        workingTreeDirty: false,
        untrackedFiles: [],
        submoduleChanges: [],
        analysisWarnings: [],
      },
      bundle.config,
    );

    const provider = new BuiltinModuleImpactProvider();
    const env = await provider.analyze({
      workspaceRoot: dir,
      changeSet,
      config: bundle.config,
      modules: bundle.modules,
      mode: 'balanced',
    });

    const impact = { ...env.data, confidence: env.confidence, envelopes: [env] };
    const risk = assessRisk({
      changeSet,
      impact,
      config: bundle.config,
      modules: bundle.modules,
      policyContext: {
        candidate: bundle,
        effective: bundle,
        baselineStatus: 'same_as_candidate',
        differences: [],
        relaxations: [],
        warnings: [],
      },
    });

    const cacheEngine = new CacheEngine(dir, bundle.config);
    const execEnv = buildExecutionEnvironment({
      projectRevision: 'bbb',
      repositoryTreeHash: 'tree123',
      worktreeClean: true,
    });
    const plan = buildTestPlan({
      bundle,
      changeSet,
      impact,
      risk,
      mode: 'balanced',
      environment: execEnv,
      cacheEngine,
    });

    expect(plan.suites).toHaveLength(1);
    expect(plan.suites[0]!.coveredModules).toEqual(['music', 'playlist', 'tagging']);
    expect(plan.suites[0]!.matchedRegressions).toEqual(['BUG-42']);
    expect(plan.dedupStats.candidatesBeforeDedup).toBeGreaterThanOrEqual(4);
    expect(plan.dedupStats.suitesAfterDedup).toBe(1);
    expect(plan.dedupStats.savedExecutions).toBeGreaterThanOrEqual(3);
  });
});

describe('Exact Git Tree Cache Engine & Redaction', () => {
  it('hits on exact tree, misses on different tree, recovers from corrupted index, and never caches failure', () => {
    const dir = makeTempDir('aeg-cache-');
    const config = {
      schema_version: 1 as const,
      project: { name: 'cache-test' },
      cache: { enabled: true, backend: 'local' as const, directory: '.aeg/cache', exact_tree: true },
    };
    const suiteDef = {
      framework: 'command' as const,
      command: { executable: 'node', args: ['-v'] },
      covers: ['core'],
      level: 'unit' as const,
    };
    const env = buildExecutionEnvironment({
      projectRevision: 'abc',
      repositoryTreeHash: 'tree-A',
      worktreeClean: true,
    });
    const cache = new CacheEngine(dir, config);

    const keyA = {
      repositoryTreeHash: 'tree-A',
      suiteId: 'unit',
      executionVariant: 'default',
      suiteDef,
      configDigest: 'cfg1',
      policyDigest: 'pol1',
      environment: env,
      allowedEnvValues: {},
    };

    // Failed run must NOT be cached
    cache.storePassedResult({
      config,
      keyInput: keyA,
      result: {
        suiteId: 'unit',
        executionVariant: 'default',
        disposition: 'execute',
        status: 'failed',
        cached: false,
        durationMs: 10,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outputDigest: 'out1',
        artifactRefs: [],
        failureDetails: [],
      },
    });
    expect(
      cache.evaluateLookup({ config, mode: 'balanced', confidence: 0.95, keyInput: keyA }).decision,
    ).toBe('miss');

    // Passed run -> cached for tree-A
    cache.storePassedResult({
      config,
      keyInput: keyA,
      result: {
        suiteId: 'unit',
        executionVariant: 'default',
        disposition: 'execute',
        status: 'passed',
        cached: false,
        durationMs: 10,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outputDigest: 'out2',
        artifactRefs: [],
        failureDetails: [],
      },
    });
    expect(
      cache.evaluateLookup({ config, mode: 'balanced', confidence: 0.95, keyInput: keyA }).decision,
    ).toBe('hit');

    // Different tree-B -> MUST MISS (no cross-tree reuse in MVP)
    const keyB = { ...keyA, repositoryTreeHash: 'tree-B' };
    expect(
      cache.evaluateLookup({ config, mode: 'balanced', confidence: 0.95, keyInput: keyB }).decision,
    ).toBe('miss');

    // Release mode -> MUST REJECT cache
    expect(
      cache.evaluateLookup({ config, mode: 'release', confidence: 0.95, keyInput: keyA }).decision,
    ).toBe('rejected');

    // Corrupted index -> self-heals to miss
    fs.writeFileSync(path.join(dir, '.aeg', 'cache', 'index.json'), '{broken json', 'utf8');
    expect(
      cache.evaluateLookup({ config, mode: 'balanced', confidence: 0.95, keyInput: keyA }).decision,
    ).toBe('miss');
  });

  it('redacts API keys, tokens, and private keys from logs', () => {
    const raw = 'Authorization: Bearer sk-1234567890abcdefghij123456\nAPI_KEY=supersecretvalue12345\nghp_abcdefghijklmnopqrstuvwxyz123456';
    const clean = redactSensitiveText(raw);
    expect(clean).not.toContain('sk-1234567890');
    expect(clean).not.toContain('supersecretvalue12345');
    expect(clean).not.toContain('ghp_abcdefghij');
    expect(clean).toContain('[REDACTED]');
  });
});
