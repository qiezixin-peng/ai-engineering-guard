import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { GitAdapter } from '../adapters/git/git-adapter.js';
import { canonicalJson, hashObject } from '../domain/hash.js';
import {
  RISK_ORDER,
  maxRiskLevel,
  type AegConfig,
  type ModulesConfig,
  type PolicyDifference,
  type PolicyEvaluationContext,
  type ProjectConfigBundle,
  type RiskLevel,
  type TestsConfig,
  type TestSuiteDef,
} from '../domain/types.js';
import { validateProjectConfigs, type ValidationIssue } from './schema-validator.js';

export const GUARD_DIR = '.engineering-guard';

/**
 * Walks upwards from `startDir` to locate the nearest AEG-configured workspace root.
 * Ensures agents invoking `aeg check` from nested subdirectories (e.g. `packages/web`) still work seamlessly.
 */
export function resolveWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, GUARD_DIR, 'config.yaml'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    // Do not walk outside the enclosing git repo if .git is reached without .engineering-guard
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = parent;
  }
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

function parseYamlStrict(content: string, fileLabel: string): unknown {
  try {
    const parsed = YAML.parse(content, { strict: true });
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`Expected a YAML mapping object in ${fileLabel}`);
    }
    return parsed;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`Failed to parse ${fileLabel}: ${msg}`, [
      {
        file: fileLabel as ValidationIssue['file'],
        path: '/',
        severity: 'error',
        message: msg,
      },
    ]);
  }
}

export function buildConfigBundle(
  workspaceRoot: string,
  rawConfig: string,
  rawModules: string,
  rawTests: string,
  source: ProjectConfigBundle['source'],
  sourceRef?: string,
): ProjectConfigBundle {
  const config = parseYamlStrict(rawConfig, 'config.yaml') as AegConfig;
  const modules = parseYamlStrict(rawModules, 'modules.yaml') as ModulesConfig;
  const tests = parseYamlStrict(rawTests, 'tests.yaml') as TestsConfig;

  const validation = validateProjectConfigs(workspaceRoot, config, modules, tests);
  if (!validation.valid) {
    throw new ConfigValidationError(
      `Invalid AEG configuration (${source}): ${validation.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.file}:${i.path} ${i.message}`)
        .join('; ')}`,
      validation.issues,
    );
  }

  const configDigest = hashObject({ config, modules, tests });
  const policyDigest = hashObject({
    risk: config.risk ?? {},
    gates: config.gates ?? {},
    cache: config.cache ?? {},
    suites: tests.suites,
    regressions: tests.regressions ?? [],
  });

  return {
    config,
    modules,
    tests,
    configDigest,
    policyDigest,
    source,
    sourceRef,
  };
}

export function loadWorkingTreeConfig(workspaceRoot: string): ProjectConfigBundle {
  const dir = path.join(workspaceRoot, GUARD_DIR);
  const readReq = (filename: 'config.yaml' | 'modules.yaml' | 'tests.yaml'): string => {
    const fullPath = path.join(dir, filename);
    if (!fs.existsSync(fullPath)) {
      throw new ConfigValidationError(`Missing required config file: ${GUARD_DIR}/${filename}`, [
        {
          file: filename,
          path: '/',
          severity: 'error',
          message: `File not found: ${GUARD_DIR}/${filename}. Run 'aeg init' first.`,
        },
      ]);
    }
    return fs.readFileSync(fullPath, 'utf8');
  };

  return buildConfigBundle(
    workspaceRoot,
    readReq('config.yaml'),
    readReq('modules.yaml'),
    readReq('tests.yaml'),
    'working_tree',
  );
}

export function loadProtectedBaselineConfig(
  workspaceRoot: string,
  git: GitAdapter,
  baselineRef: string,
): { bundle?: ProjectConfigBundle; status: 'verified' | 'missing' | 'unparseable'; warning?: string } {
  const rawConfig = git.readFileAtRevision(baselineRef, `${GUARD_DIR}/config.yaml`);
  const rawModules = git.readFileAtRevision(baselineRef, `${GUARD_DIR}/modules.yaml`);
  const rawTests = git.readFileAtRevision(baselineRef, `${GUARD_DIR}/tests.yaml`);

  if (!rawConfig && !rawModules && !rawTests) {
    return {
      status: 'missing',
      warning: `Protected baseline '${baselineRef}' does not contain ${GUARD_DIR} configuration.`,
    };
  }

  if (!rawConfig || !rawModules || !rawTests) {
    return {
      status: 'unparseable',
      warning: `Protected baseline '${baselineRef}' has incomplete ${GUARD_DIR} configuration.`,
    };
  }

  try {
    const bundle = buildConfigBundle(
      workspaceRoot,
      rawConfig,
      rawModules,
      rawTests,
      'protected_baseline',
      baselineRef,
    );
    return { bundle, status: 'verified' };
  } catch (err: unknown) {
    return {
      status: 'unparseable',
      warning: `Protected baseline '${baselineRef}' failed schema validation: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export function evaluatePolicyContext(
  workspaceRoot: string,
  git: GitAdapter,
  requestedBaseRef?: string,
): PolicyEvaluationContext {
  const candidate = loadWorkingTreeConfig(workspaceRoot);
  const baselineRef =
    requestedBaseRef ??
    git.detectDefaultBaselineRef(candidate.config.project.baseline_ref);

  if (!baselineRef) {
    return {
      candidate,
      effective: candidate,
      baselineStatus: 'missing',
      differences: [],
      relaxations: [],
      warnings: ['No baseline Git revision available; running against candidate configuration only.'],
    };
  }

  const baseLoaded = loadProtectedBaselineConfig(workspaceRoot, git, baselineRef);
  if (baseLoaded.status !== 'verified' || !baseLoaded.bundle) {
    return {
      candidate,
      effective: candidate,
      baselineStatus: baseLoaded.status,
      differences: [],
      relaxations: [],
      warnings: baseLoaded.warning ? [baseLoaded.warning] : [],
    };
  }

  const baseline = baseLoaded.bundle;
  if (baseline.configDigest === candidate.configDigest) {
    return {
      baseline,
      candidate,
      effective: baseline,
      baselineStatus: 'same_as_candidate',
      differences: [],
      relaxations: [],
      warnings: [],
    };
  }

  const differences = diffConfigBundles(baseline, candidate);
  const relaxations = differences.filter((d) => d.kind === 'relaxation');
  const effective = mergeNonRelaxingEffectiveBundle(workspaceRoot, baseline, candidate);

  const warnings: string[] = [];
  if (relaxations.length > 0) {
    warnings.push(
      `Candidate configuration attempted ${relaxations.length} policy relaxation(s); baseline PolicySnapshot '${baselineRef}' remains enforced.`,
    );
  }

  return {
    baseline,
    candidate,
    effective,
    baselineStatus: 'verified',
    differences,
    relaxations,
    warnings,
  };
}

function isSuiteCacheEnabled(suite: TestSuiteDef): boolean {
  if (suite.cache === false) return false;
  if (suite.cache === true) return true;
  if (!suite.cache) return true;
  return suite.cache.enabled !== false;
}

export function diffConfigBundles(
  baseline: ProjectConfigBundle,
  candidate: ProjectConfigBundle,
): PolicyDifference[] {
  const diffs: PolicyDifference[] = [];

  // 1. Modules removed
  for (const modName of Object.keys(baseline.modules.modules)) {
    if (!candidate.modules.modules[modName]) {
      diffs.push({
        kind: 'relaxation',
        category: 'module_removed',
        target: `modules.${modName}`,
        reason: `Baseline module '${modName}' was removed in candidate config.`,
      });
    }
  }

  // 2. Protected modules removed
  const candProtected = new Set(candidate.config.risk?.protected_modules ?? []);
  for (const pm of baseline.config.risk?.protected_modules ?? []) {
    if (!candProtected.has(pm)) {
      diffs.push({
        kind: 'relaxation',
        category: 'protected_module_removed',
        target: `risk.protected_modules.${pm}`,
        reason: `Protected module '${pm}' was removed in candidate config.`,
        baselineValue: pm,
      });
    }
  }

  // 3. Risk default_level or overrides lowered
  const baseDefRisk: RiskLevel = baseline.config.risk?.default_level ?? 'L2';
  const candDefRisk: RiskLevel = candidate.config.risk?.default_level ?? 'L2';
  if (RISK_ORDER[candDefRisk] < RISK_ORDER[baseDefRisk]) {
    diffs.push({
      kind: 'relaxation',
      category: 'risk_override_lowered',
      target: 'risk.default_level',
      reason: `Default risk level lowered from ${baseDefRisk} to ${candDefRisk}.`,
      baselineValue: baseDefRisk,
      candidateValue: candDefRisk,
    });
  }

  for (const [key, baseLevel] of Object.entries(baseline.config.risk?.overrides ?? {})) {
    const candLevel = candidate.config.risk?.overrides?.[key];
    if (!candLevel || RISK_ORDER[candLevel] < RISK_ORDER[baseLevel]) {
      diffs.push({
        kind: 'relaxation',
        category: 'risk_override_lowered',
        target: `risk.overrides.${key}`,
        reason: `Risk override '${key}' lowered from ${baseLevel} to ${candLevel ?? 'removed'}.`,
        baselineValue: baseLevel,
        candidateValue: candLevel,
      });
    }
  }

  // 4. Suites deleted, command changed, coverage reduced, cache relaxed
  for (const [suiteId, baseSuite] of Object.entries(baseline.tests.suites)) {
    const candSuite = candidate.tests.suites[suiteId];
    if (!candSuite) {
      diffs.push({
        kind: 'relaxation',
        category: 'suite_deleted',
        target: `suites.${suiteId}`,
        reason: `Baseline test suite '${suiteId}' was deleted in candidate config.`,
      });
      continue;
    }

    if (canonicalJson(baseSuite.command) !== canonicalJson(candSuite.command)) {
      diffs.push({
        kind: 'relaxation',
        category: 'suite_command_changed',
        target: `suites.${suiteId}.command`,
        reason: `Test suite '${suiteId}' command was modified in candidate config.`,
        baselineValue: baseSuite.command,
        candidateValue: candSuite.command,
      });
    }

    const candCovers = new Set(candSuite.covers);
    for (const mod of baseSuite.covers) {
      if (!candCovers.has(mod)) {
        diffs.push({
          kind: 'relaxation',
          category: 'suite_covers_reduced',
          target: `suites.${suiteId}.covers`,
          reason: `Suite '${suiteId}' no longer covers baseline module '${mod}'.`,
          baselineValue: baseSuite.covers,
          candidateValue: candSuite.covers,
        });
      }
    }

    if (!isSuiteCacheEnabled(baseSuite) && isSuiteCacheEnabled(candSuite)) {
      diffs.push({
        kind: 'relaxation',
        category: 'cache_expanded',
        target: `suites.${suiteId}.cache`,
        reason: `Suite '${suiteId}' enabled caching when disabled in baseline.`,
        baselineValue: baseSuite.cache,
        candidateValue: candSuite.cache,
      });
    }
  }

  // Added suites -> tightening
  for (const suiteId of Object.keys(candidate.tests.suites)) {
    if (!baseline.tests.suites[suiteId]) {
      diffs.push({
        kind: 'tightening',
        category: 'config_tightened',
        target: `suites.${suiteId}`,
        reason: `Candidate config added new test suite '${suiteId}'.`,
      });
    }
  }

  // 5. Regressions removed
  const candRegs = new Map((candidate.tests.regressions ?? []).map((r) => [r.id, r]));
  for (const baseReg of baseline.tests.regressions ?? []) {
    if (!candRegs.has(baseReg.id)) {
      diffs.push({
        kind: 'relaxation',
        category: 'regression_removed',
        target: `regressions.${baseReg.id}`,
        reason: `Baseline regression '${baseReg.id}' was removed in candidate config.`,
      });
    }
  }

  // 6. Global cache expanded
  if (baseline.config.cache?.enabled === false && candidate.config.cache?.enabled !== false) {
    diffs.push({
      kind: 'relaxation',
      category: 'cache_expanded',
      target: 'cache.enabled',
      reason: 'Candidate config enabled cache while baseline disabled it.',
    });
  }
  if (baseline.config.cache?.cross_platform !== true && candidate.config.cache?.cross_platform === true) {
    diffs.push({
      kind: 'relaxation',
      category: 'cache_expanded',
      target: 'cache.cross_platform',
      reason: 'Candidate config enabled cross_platform cache without baseline approval.',
    });
  }

  // 7. Gates relaxed
  for (const [policyName, baseGate] of Object.entries(baseline.config.gates ?? {})) {
    const candGate = candidate.config.gates?.[policyName];
    const candBlocks = new Set(candGate?.block_on ?? []);
    for (const rule of baseGate.block_on ?? []) {
      if (!candBlocks.has(rule)) {
        diffs.push({
          kind: 'relaxation',
          category: 'gate_rule_relaxed',
          target: `gates.${policyName}.block_on`,
          reason: `Gate policy '${policyName}' removed blocking condition '${rule}'.`,
        });
      }
    }
    if (baseGate.require_clean_worktree && !candGate?.require_clean_worktree) {
      diffs.push({
        kind: 'relaxation',
        category: 'gate_rule_relaxed',
        target: `gates.${policyName}.require_clean_worktree`,
        reason: `Gate policy '${policyName}' disabled require_clean_worktree.`,
      });
    }
  }

  return diffs;
}

function mergeNonRelaxingEffectiveBundle(
  _workspaceRoot: string,
  baseline: ProjectConfigBundle,
  candidate: ProjectConfigBundle,
): ProjectConfigBundle {
  // Start from baseline so candidate can NEVER remove/weaken baseline protections,
  // while permitting candidate to tighten (add new modules/suites/regressions/protected modules/higher risks).
  const mergedModules: ModulesConfig = {
    schema_version: 1,
    modules: {
      ...candidate.modules.modules,
      ...baseline.modules.modules,
    },
  };

  // For suites: keep baseline definitions for any suite present in baseline (no command/cache/coverage weakening),
  // plus allow brand-new suites added by candidate.
  const mergedSuites: Record<string, TestSuiteDef> = {
    ...candidate.tests.suites,
    ...baseline.tests.suites,
  };

  const regMap = new Map(
    (candidate.tests.regressions ?? []).map((r) => [r.id, r]),
  );
  for (const baseReg of baseline.tests.regressions ?? []) {
    regMap.set(baseReg.id, baseReg);
  }

  const mergedTests: TestsConfig = {
    schema_version: 1,
    suites: mergedSuites,
    regressions: Array.from(regMap.values()),
  };

  const protectedSet = new Set([
    ...(baseline.config.risk?.protected_modules ?? []),
    ...(candidate.config.risk?.protected_modules ?? []),
  ]);

  const mergedOverrides: Record<string, RiskLevel> = {
    ...(candidate.config.risk?.overrides ?? {}),
  };
  for (const [k, v] of Object.entries(baseline.config.risk?.overrides ?? {})) {
    mergedOverrides[k] = mergedOverrides[k] ? maxRiskLevel(mergedOverrides[k]!, v) : v;
  }

  const mergedGates: Record<string, { block_on?: string[]; require_clean_worktree?: boolean; require_approval_on?: string[] }> = {
    ...(candidate.config.gates ?? {}),
  };
  for (const [policyName, baseGate] of Object.entries(baseline.config.gates ?? {})) {
    const candGate = mergedGates[policyName];
    mergedGates[policyName] = {
      block_on: Array.from(new Set([...(baseGate.block_on ?? []), ...(candGate?.block_on ?? [])])),
      require_clean_worktree: Boolean(baseGate.require_clean_worktree || candGate?.require_clean_worktree),
      require_approval_on: Array.from(
        new Set([...(baseGate.require_approval_on ?? []), ...(candGate?.require_approval_on ?? [])]),
      ),
    };
  }

  const mergedConfig: AegConfig = {
    ...baseline.config,
    risk: {
      default_level: maxRiskLevel(
        baseline.config.risk?.default_level ?? 'L2',
        candidate.config.risk?.default_level ?? 'L2',
      ),
      protected_modules: Array.from(protectedSet),
      overrides: mergedOverrides,
    },
    cache: {
      ...baseline.config.cache,
      enabled:
        baseline.config.cache?.enabled === false
          ? false
          : candidate.config.cache?.enabled !== false,
      cross_platform: false,
      exact_tree: baseline.config.cache?.exact_tree ?? true,
    },
    gates: mergedGates,
  };

  return {
    config: mergedConfig,
    modules: mergedModules,
    tests: mergedTests,
    configDigest: hashObject({ config: mergedConfig, modules: mergedModules, tests: mergedTests }),
    policyDigest: baseline.policyDigest,
    source: 'protected_baseline',
    sourceRef: baseline.sourceRef,
  };
}
