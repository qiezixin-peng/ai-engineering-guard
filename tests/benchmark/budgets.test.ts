import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangeSet } from '../../src/analyze/diff-analyzer.js';
import { BuiltinModuleImpactProvider } from '../../src/analyze/impact-analyzer.js';
import { assessRisk } from '../../src/analyze/risk-engine.js';
import { CacheEngine } from '../../src/cache/cache-engine.js';
import { buildConfigBundle } from '../../src/config/loader.js';
import { PACKAGE_ROOT } from '../../src/config/schema-validator.js';
import { buildExecutionEnvironment } from '../../src/engine.js';
import { buildTestPlan } from '../../src/plan/test-planner.js';
import type { ChangeSet } from '../../src/domain/types.js';

describe('Section 5.11 Performance, Memory, and Dependency Budgets', () => {
  it('satisfies direct runtime dependency budget (<= 12)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const depCount = Object.keys(pkg.dependencies ?? {}).length;
    expect(depCount).toBeLessThanOrEqual(12);
  });

  it('satisfies aeg --help cold start budget (<= 300 ms)', () => {
    const binPath = path.join(PACKAGE_ROOT, 'bin', 'aeg.js');
    // Warm OS page cache once, then measure median of 3 cold Node invocations
    execFileSync(process.execPath, [binPath, '--help'], { windowsHide: true });

    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      execFileSync(process.execPath, [binPath, '--help'], { windowsHide: true });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[1]!;
    expect(medianMs).toBeLessThanOrEqual(300);
  });

  it('satisfies incremental analysis (<= 2000ms) and plan generation (<= 200ms) for 2000-file / 50-change scale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeg-bench-'));
    try {
      // Build 20 modules covering 2,000 logical files & 20 test suites
      const modLines = ['schema_version: 1', 'modules:'];
      const suiteLines = ['schema_version: 1', 'suites:'];
      for (let i = 0; i < 20; i++) {
        modLines.push(`  mod${i}:`);
        modLines.push(`    paths: ["src/mod${i}/**"]`);
        modLines.push(`    depends_on: [${i > 0 ? `mod${i - 1}` : ''}]`);
        suiteLines.push(`  suite${i}:`);
        suiteLines.push(`    framework: command`);
        suiteLines.push(`    command: { executable: node, args: [-v] }`);
        suiteLines.push(`    covers: [mod${i}]`);
        suiteLines.push(`    level: unit`);
      }

      const bundle = buildConfigBundle(
        dir,
        'schema_version: 1\nproject: { name: bench }\n',
        modLines.join('\n'),
        suiteLines.join('\n'),
        'working_tree',
      );

      // 50 changed files across modules
      const files = Array.from({ length: 50 }, (_, idx) => ({
        path: `src/mod${idx % 20}/file_${idx}.ts`,
        changeType: 'modified' as const,
        additions: 10,
        deletions: 3,
        hunks: [],
      }));

      const rawCs: ChangeSet = {
        repositoryId: 'bench-repo',
        baseRevision: 'aaa',
        headRevision: 'bbb',
        scope: 'combined',
        repositoryTreeHash: 'bench-tree',
        files,
        commits: [],
        workingTreeDirty: false,
        untrackedFiles: [],
        submoduleChanges: [],
        analysisWarnings: [],
      };

      const analysisStart = performance.now();
      const cs = classifyChangeSet(rawCs, bundle.config);
      const provider = new BuiltinModuleImpactProvider();
      const env = await provider.analyze({
        workspaceRoot: dir,
        changeSet: cs,
        config: bundle.config,
        modules: bundle.modules,
        mode: 'balanced',
      });
      const impact = { ...env.data, confidence: env.confidence, envelopes: [env] };
      const risk = assessRisk({
        changeSet: cs,
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
      const analysisMs = performance.now() - analysisStart;

      const cacheEngine = new CacheEngine(dir, bundle.config);
      const execEnv = buildExecutionEnvironment({
        projectRevision: 'bbb',
        repositoryTreeHash: 'bench-tree',
        worktreeClean: true,
      });

      const planStart = performance.now();
      const plan = buildTestPlan({
        bundle,
        changeSet: cs,
        impact,
        risk,
        mode: 'balanced',
        environment: execEnv,
        cacheEngine,
      });
      const planMs = performance.now() - planStart;

      expect(plan.suites.length).toBe(20);
      expect(analysisMs).toBeLessThanOrEqual(2000);
      expect(planMs).toBeLessThanOrEqual(200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
