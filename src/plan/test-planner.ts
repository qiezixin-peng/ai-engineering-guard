import crypto from 'node:crypto';
import path from 'node:path';
import picomatch from 'picomatch';
import type { CacheEngine } from '../cache/cache-engine.js';
import { hashObject, parseDurationMs } from '../domain/hash.js';
import {
  RISK_ORDER,
  type AnalysisMode,
  type CacheCandidate,
  type ChangeSet,
  type CoverageRequirement,
  type ExecutionEnvironment,
  type ExcludedTestSuite,
  type ImpactResult,
  type PlannedTestSuite,
  type Platform,
  type PlatformRequirement,
  type ProjectConfigBundle,
  type RiskAssessment,
  type TestLevel,
  type TestPlan,
  type TestSuiteDef,
} from '../domain/types.js';

interface CandidateReason {
  suiteId: string;
  coveredModule?: string;
  reason: string;
  evidenceRef: string;
  regressionId?: string;
}

const LEVEL_PRIORITY: Record<TestLevel, number> = {
  static: 1,
  unit: 2,
  integration: 3,
  e2e: 4,
  security: 5,
  full: 6,
};

function allowedLevelsForRisk(riskLevel: RiskAssessment['level'], mode: AnalysisMode): Set<TestLevel> {
  if (mode === 'release' || riskLevel === 'L4') {
    return new Set(['static', 'unit', 'integration', 'e2e', 'security', 'full']);
  }
  if (riskLevel === 'L3') {
    return new Set(['static', 'unit', 'integration', 'e2e', 'security']);
  }
  if (riskLevel === 'L2') {
    return new Set(['static', 'unit', 'integration']);
  }
  if (riskLevel === 'L1') {
    return new Set(['static', 'unit']);
  }
  return new Set(['static']);
}

export function buildTestPlan(params: {
  bundle: ProjectConfigBundle;
  changeSet: ChangeSet;
  impact: ImpactResult;
  risk: RiskAssessment;
  mode: AnalysisMode;
  environment: ExecutionEnvironment;
  cacheEngine: CacheEngine;
  disableCache?: boolean;
  historicalFailureRates?: Record<string, number>;
}): TestPlan {
  const {
    bundle,
    changeSet,
    impact,
    risk,
    mode,
    environment,
    cacheEngine,
    disableCache,
    historicalFailureRates = {},
  } = params;
  const suitesMap = bundle.tests.suites;
  const allSuiteIds = Object.keys(suitesMap).sort();
  const candidates: CandidateReason[] = [];
  const fallbackActions: string[] = [];
  const unknowns: string[] = [...impact.unknowns];
  const rationale: string[] = [];

  const affectedModules = Array.from(
    new Set([...impact.directlyChangedModules, ...impact.transitivelyAffectedModules]),
  ).sort();

  const allowedLevels = allowedLevelsForRisk(risk.level, mode);

  // 1. Direct & transitive affected modules -> covering suites
  const requiredCoverage: CoverageRequirement[] = [];
  for (const modId of affectedModules) {
    const coveringSuites = allSuiteIds.filter((id) => suitesMap[id]!.covers.includes(modId));
    const selectedForMod = coveringSuites.filter((id) => allowedLevels.has(suitesMap[id]!.level));
    const effectiveForMod = selectedForMod.length > 0 ? selectedForMod : coveringSuites;

    requiredCoverage.push({
      moduleId: modId,
      covered: effectiveForMod.length > 0,
      suiteIds: effectiveForMod,
    });

    if (effectiveForMod.length === 0) {
      const msg = `Affected module '${modId}' has no declared test suite covering it.`;
      unknowns.push(msg);
      fallbackActions.push(`Missing coverage for module '${modId}'; gate will require incomplete/manual action.`);
    } else {
      for (const suiteId of effectiveForMod) {
        candidates.push({
          suiteId,
          coveredModule: modId,
          reason: impact.directlyChangedModules.includes(modId)
            ? `Covers directly changed module '${modId}'`
            : `Covers transitively affected downstream module '${modId}'`,
          evidenceRef: `module:${modId}`,
        });
      }
    }
  }

  // 2. Historical regression rules (Section 10.4 & 11.3)
  for (const reg of bundle.tests.regressions ?? []) {
    const matcher = picomatch(reg.trigger_paths, { dot: true });
    const hitFiles = changeSet.files.filter(
      (f) => matcher(f.path) || (f.previousPath ? matcher(f.previousPath) : false),
    );
    if (hitFiles.length > 0 && suitesMap[reg.suite]) {
      candidates.push({
        suiteId: reg.suite,
        reason: `Mandatory historical regression '${reg.id}' triggered by ${hitFiles.map((f) => f.path).join(', ')}`,
        evidenceRef: `regression:${reg.id}`,
        regressionId: reg.id,
      });
    }
  }

  // 3. Direct test file changes -> ensure suites covering those test files or modules run
  const changedTestFiles = changeSet.files.filter((f) => (f.categories ?? []).includes('test'));
  if (changedTestFiles.length > 0 && candidates.length === 0) {
    for (const suiteId of allSuiteIds) {
      const def = suitesMap[suiteId]!;
      const inputs = typeof def.cache === 'object' ? def.cache.inputs ?? [] : [];
      const matchInputs = inputs.length > 0 ? picomatch(inputs, { dot: true }) : () => false;
      if (changedTestFiles.some((f) => matchInputs(f.path)) || def.level === 'unit') {
        candidates.push({
          suiteId,
          reason: `Test files modified (${changedTestFiles.map((f) => f.path).join(', ')})`,
          evidenceRef: `test-files:${changedTestFiles[0]!.path}`,
        });
      }
    }
  }

  // 4. Layered Conservative Fallback (Section 10.4)
  // 4a. Unclassified ordinary files -> directory-neighbor modules first, otherwise critical/unit fallback
  if (impact.unclassifiedFiles.length > 0) {
    const neighborModules = new Set<string>();
    for (const file of impact.unclassifiedFiles) {
      const dir = path.posix.dirname(file);
      for (const [modId, modDef] of Object.entries(bundle.modules.modules)) {
        if (modDef.paths.some((p) => dir !== '.' && p.startsWith(dir))) {
          neighborModules.add(modId);
        }
      }
    }

    if (neighborModules.size > 0) {
      fallbackActions.push(
        `Unclassified files (${impact.unclassifiedFiles.join(', ')}) expanded to sibling module(s): ${Array.from(neighborModules).join(', ')}`,
      );
      for (const modId of neighborModules) {
        for (const suiteId of allSuiteIds.filter((id) => suitesMap[id]!.covers.includes(modId))) {
          candidates.push({
            suiteId,
            coveredModule: modId,
            reason: `Layered fallback for unclassified files in sibling directory of module '${modId}'`,
            evidenceRef: `fallback:unclassified:${modId}`,
          });
        }
      }
    } else {
      const fallbackSuites = allSuiteIds.filter(
        (id) => suitesMap[id]!.critical || suitesMap[id]!.level === 'unit',
      );
      fallbackActions.push(
        `Unclassified files (${impact.unclassifiedFiles.join(', ')}) had no sibling module; expanded to unit/critical suites: ${fallbackSuites.join(', ') || 'none'}`,
      );
      for (const suiteId of fallbackSuites) {
        candidates.push({
          suiteId,
          reason: `Conservative fallback for unclassified files: ${impact.unclassifiedFiles.join(', ')}`,
          evidenceRef: 'fallback:unclassified',
        });
      }
    }
  }

  // 4b. Lockfile, build config, CI, or .engineering-guard config changes -> full ecosystem verification
  const infraChanges = changeSet.files.filter((f) =>
    (f.categories ?? []).some((c) => c === 'lockfile' || c === 'config' || c === 'guard_config' || c === 'ci'),
  );
  if (infraChanges.length > 0) {
    const infraSuites = allSuiteIds.filter(
      (id) =>
        suitesMap[id]!.critical ||
        suitesMap[id]!.level === 'static' ||
        suitesMap[id]!.level === 'unit' ||
        suitesMap[id]!.level === 'integration',
    );
    fallbackActions.push(
      `Build/dependency/guard config modified (${infraChanges.map((f) => f.path).join(', ')}); expanded to ${infraSuites.join(', ')}`,
    );
    for (const suiteId of infraSuites) {
      candidates.push({
        suiteId,
        reason: `Infrastructure/config/lockfile change requires suite '${suiteId}'`,
        evidenceRef: `infra:${infraChanges[0]!.path}`,
      });
    }
  }

  // 4c. L4 / release mode / blocking unknowns -> pull all critical, security, and full suites
  if (mode === 'release' || RISK_ORDER[risk.level] >= RISK_ORDER.L4 || risk.blockingUnknowns.length > 0) {
    const criticalSuites = allSuiteIds.filter(
      (id) =>
        suitesMap[id]!.critical ||
        suitesMap[id]!.level === 'security' ||
        suitesMap[id]!.level === 'full' ||
        mode === 'release',
    );
    for (const suiteId of criticalSuites) {
      candidates.push({
        suiteId,
        reason:
          mode === 'release'
            ? `Required by 'release' verification mode`
            : risk.blockingUnknowns.length > 0
              ? `Conservative fallback triggered by blocking unknowns`
              : `Required by L4 high-risk escalation`,
        evidenceRef: mode === 'release' ? 'mode:release' : `risk:${risk.level}`,
      });
    }
  }

  // 4d. L0 docs-only -> run static suites if declared
  if (risk.level === 'L0' && changeSet.files.length > 0) {
    for (const suiteId of allSuiteIds.filter((id) => suitesMap[id]!.level === 'static')) {
      candidates.push({
        suiteId,
        reason: 'Static verification for L0 documentation change',
        evidenceRef: 'risk:L0',
      });
    }
  }

  // 5. Pull transitive suite dependencies (depends_on)
  const candidatesBeforeDedup = candidates.length;
  const pullDependencies = () => {
    const selectedSet = new Set(candidates.map((c) => c.suiteId));
    const queue = Array.from(selectedSet);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const depId of suitesMap[current]?.depends_on ?? []) {
        if (suitesMap[depId]) {
          candidates.push({
            suiteId: depId,
            reason: `Required dependency of suite '${current}'`,
            evidenceRef: `suite-dep:${current}->${depId}`,
          });
          if (!selectedSet.has(depId)) {
            selectedSet.add(depId);
            queue.push(depId);
          }
        }
      }
    }
  };
  pullDependencies();

  // 6. Suite Deduplication (Section 10.4.1):
  // Key = normalized suiteId + sorted platforms + executionVariant
  interface DedupBucket {
    suiteId: string;
    def: TestSuiteDef;
    executionVariant: string;
    requiredPlatforms: Platform[];
    coveredModules: Set<string>;
    selectionReasons: Set<string>;
    evidenceRefs: Set<string>;
    matchedRegressions: Set<string>;
  }

  const buckets = new Map<string, DedupBucket>();
  for (const cand of candidates) {
    const def = suitesMap[cand.suiteId];
    if (!def) continue;
    const platforms = [...(def.platforms ?? (['windows', 'linux', 'macos'] as Platform[]))].sort();
    const executionVariant = def.execution_variant ?? 'default';
    const dedupKey = `${cand.suiteId}::${platforms.join(',')}::${executionVariant}`;

    let bucket = buckets.get(dedupKey);
    if (!bucket) {
      bucket = {
        suiteId: cand.suiteId,
        def,
        executionVariant,
        requiredPlatforms: platforms,
        coveredModules: new Set(),
        selectionReasons: new Set(),
        evidenceRefs: new Set(),
        matchedRegressions: new Set(),
      };
      buckets.set(dedupKey, bucket);
    }

    if (cand.coveredModule) bucket.coveredModules.add(cand.coveredModule);
    bucket.selectionReasons.add(cand.reason);
    bucket.evidenceRefs.add(cand.evidenceRef);
    if (cand.regressionId) bucket.matchedRegressions.add(cand.regressionId);
  }

  const dedupedList = Array.from(buckets.values());
  const suitesAfterDedup = dedupedList.length;
  const savedExecutions = Math.max(0, candidates.length - suitesAfterDedup);

  // 7. Topological + priority sort (Section 15: level -> regressions -> historical failure rate -> cost)
  const orderedBuckets = topologicalAndPrioritySort(dedupedList, historicalFailureRates);

  // 8. Platform capability check & Exact Tree Cache evaluation
  const plannedSuites: PlannedTestSuite[] = [];
  const cacheCandidates: CacheCandidate[] = [];
  const requiredPlatformsMap = new Map<Platform, { suiteIds: Set<string>; mode: 'once_per_change' | 'each_platform' }>();
  const requiredCapabilitiesSet = new Set<string>();

  for (const bucket of orderedBuckets) {
    const def = bucket.def;
    const execMode = def.execution ?? 'each_platform';

    for (const p of bucket.requiredPlatforms) {
      const existing = requiredPlatformsMap.get(p) ?? { suiteIds: new Set(), mode: execMode };
      existing.suiteIds.add(bucket.suiteId);
      if (execMode === 'each_platform') existing.mode = 'each_platform';
      requiredPlatformsMap.set(p, existing);
    }
    for (const cap of def.capabilities ?? []) {
      requiredCapabilitiesSet.add(cap);
    }

    const supportsCurrentPlatform = bucket.requiredPlatforms.includes(environment.platform);
    if (!supportsCurrentPlatform) {
      const blockMsg = `Suite '${bucket.suiteId}' requires platform [${bucket.requiredPlatforms.join(', ')}], unavailable on current host '${environment.platform}'.`;
      unknowns.push(blockMsg);
      plannedSuites.push({
        suiteId: bucket.suiteId,
        executionVariant: bucket.executionVariant,
        disposition: 'blocked',
        coveredModules: Array.from(bucket.coveredModules).sort(),
        selectionReasons: [...Array.from(bucket.selectionReasons), blockMsg],
        evidenceRefs: Array.from(bucket.evidenceRefs),
        dependencySuiteIds: def.depends_on ?? [],
        matchedRegressions: Array.from(bucket.matchedRegressions).sort(),
        requiredPlatforms: bucket.requiredPlatforms,
        requiredCapabilities: def.capabilities ?? [],
        level: def.level,
      });
      continue;
    }

    const allowedEnvValues: Record<string, string> = {};
    for (const envKey of def.command.environment_allowlist ?? []) {
      if (process.env[envKey] !== undefined) {
        allowedEnvValues[envKey] = process.env[envKey]!;
      }
    }

    const cacheDecision = cacheEngine.evaluateLookup({
      config: bundle.config,
      mode,
      confidence: impact.confidence,
      disableCacheFlag: disableCache,
      keyInput: {
        repositoryTreeHash: changeSet.repositoryTreeHash,
        suiteId: bucket.suiteId,
        executionVariant: bucket.executionVariant,
        suiteDef: def,
        configDigest: bundle.configDigest,
        policyDigest: bundle.policyDigest,
        environment,
        allowedEnvValues,
      },
    });

    cacheCandidates.push({
      suiteId: bucket.suiteId,
      fingerprint: cacheDecision.fingerprint,
      mode: cacheDecision.mode === 'disabled' ? 'exact_tree' : cacheDecision.mode,
      eligible: cacheDecision.decision === 'hit',
      reason: cacheDecision.reasons.join(' '),
    });

    const disposition = cacheDecision.decision === 'hit' ? 'reuse_cache' : 'execute';
    plannedSuites.push({
      suiteId: bucket.suiteId,
      executionVariant: bucket.executionVariant,
      disposition,
      coveredModules: Array.from(bucket.coveredModules).sort(),
      selectionReasons: Array.from(bucket.selectionReasons),
      evidenceRefs: Array.from(bucket.evidenceRefs),
      dependencySuiteIds: def.depends_on ?? [],
      matchedRegressions: Array.from(bucket.matchedRegressions).sort(),
      requiredPlatforms: bucket.requiredPlatforms,
      requiredCapabilities: def.capabilities ?? [],
      level: def.level,
      cacheDecision,
    });
  }

  // 9. Excluded suites -> strictly 'not_required' ONLY with clear classification rationale
  const selectedIds = new Set(plannedSuites.map((s) => s.suiteId));
  const excludedSuites: ExcludedTestSuite[] = [];
  for (const suiteId of allSuiteIds) {
    if (selectedIds.has(suiteId)) continue;
    const def = suitesMap[suiteId]!;
    const touchesAffected = def.covers.some((m) => affectedModules.includes(m));
    const reasons: string[] = [];
    if (changeSet.files.length === 0) {
      reasons.push('No files changed in current scope.');
    } else if (!touchesAffected) {
      reasons.push(
        `Covers [${def.covers.join(', ')}], none of which are in affected modules [${affectedModules.join(', ') || 'none'}].`,
      );
    } else if (!allowedLevels.has(def.level)) {
      reasons.push(
        `Suite level '${def.level}' is outside required levels for risk ${risk.level} in mode '${mode}'.`,
      );
    } else {
      reasons.push('Not triggered by affected modules, regressions, or risk rules.');
    }
    excludedSuites.push({
      suiteId,
      disposition: 'not_required',
      reasons,
      evidenceRefs: [`risk:${risk.level}`, `mode:${mode}`],
    });
  }

  const requiredPlatforms: PlatformRequirement[] = Array.from(requiredPlatformsMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, info]) => ({
      platform,
      suiteIds: Array.from(info.suiteIds).sort(),
      mode: info.mode,
    }));

  rationale.push(
    `Mode '${mode}', risk '${risk.level}', affected modules: [${affectedModules.join(', ') || 'none'}].`,
  );
  rationale.push(
    `Selected ${plannedSuites.length} suite(s) (${candidatesBeforeDedup} initial candidates, ${savedExecutions} deduplicated); excluded ${excludedSuites.length} as not_required.`,
  );

  const createdAt = new Date().toISOString();
  const planBody = {
    repositoryTreeHash: changeSet.repositoryTreeHash,
    configDigest: bundle.configDigest,
    policyDigest: bundle.policyDigest,
    suites: plannedSuites,
    excludedSuites,
    requiredCoverage,
    requiredPlatforms,
  };
  const planDigest = hashObject(planBody);
  const id = `plan-${planDigest.slice(0, 12)}-${crypto.randomBytes(2).toString('hex')}`;

  return {
    id,
    planDigest,
    repositoryTreeHash: changeSet.repositoryTreeHash,
    configDigest: bundle.configDigest,
    policyDigest: bundle.policyDigest,
    createdAt,
    suites: plannedSuites,
    cacheCandidates,
    excludedSuites,
    requiredCoverage,
    requiredPlatforms,
    requiredCapabilities: Array.from(requiredCapabilitiesSet).sort(),
    dedupStats: {
      candidatesBeforeDedup: candidates.length,
      suitesAfterDedup,
      savedExecutions,
    },
    fallbackActions,
    rationale,
    unknowns: Array.from(new Set(unknowns)),
  };
}

function topologicalAndPrioritySort<
  T extends { suiteId: string; def: TestSuiteDef; matchedRegressions: Set<string> },
>(buckets: T[], historicalFailureRates: Record<string, number> = {}): T[] {
  const byId = new Map(buckets.map((b) => [b.suiteId, b]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const b of buckets) {
    inDegree.set(b.suiteId, 0);
    dependents.set(b.suiteId, []);
  }

  for (const b of buckets) {
    for (const dep of b.def.depends_on ?? []) {
      if (byId.has(dep)) {
        inDegree.set(b.suiteId, (inDegree.get(b.suiteId) ?? 0) + 1);
        dependents.get(dep)!.push(b.suiteId);
      }
    }
  }

  const comparePriority = (a: T, b: T): number => {
    const levelDiff = LEVEL_PRIORITY[a.def.level] - LEVEL_PRIORITY[b.def.level];
    if (levelDiff !== 0) return levelDiff;
    const regDiff = (b.matchedRegressions.size > 0 ? 1 : 0) - (a.matchedRegressions.size > 0 ? 1 : 0);
    if (regDiff !== 0) return regDiff;
    const failDiff = (historicalFailureRates[b.suiteId] ?? 0) - (historicalFailureRates[a.suiteId] ?? 0);
    if (Math.abs(failDiff) > 0.001) return failDiff;
    const durA = parseDurationMs(a.def.estimated_duration, 60_000);
    const durB = parseDurationMs(b.def.estimated_duration, 60_000);
    if (durA !== durB) return durA - durB;
    return a.suiteId.localeCompare(b.suiteId);
  };

  const ready = buckets.filter((b) => (inDegree.get(b.suiteId) ?? 0) === 0).sort(comparePriority);
  const result: T[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    result.push(current);
    for (const nextId of dependents.get(current.suiteId) ?? []) {
      const deg = (inDegree.get(nextId) ?? 1) - 1;
      inDegree.set(nextId, deg);
      if (deg === 0) {
        ready.push(byId.get(nextId)!);
        ready.sort(comparePriority);
      }
    }
  }

  // Fallback append if anything remained (should never happen after config DAG validation)
  if (result.length < buckets.length) {
    const seen = new Set(result.map((b) => b.suiteId));
    for (const b of buckets) {
      if (!seen.has(b.suiteId)) result.push(b);
    }
  }

  return result;
}
