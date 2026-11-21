import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitAdapter } from './adapters/git/git-adapter.js';
import { AstSymbolsProvider } from './adapters/providers/ast-symbols.js';
import { ContractsAndDbProvider } from './adapters/providers/contracts-db.js';
import { CoverageImpactProvider } from './adapters/providers/coverage-impact.js';
import { ExistingBuildGraphProvider } from './adapters/providers/existing-build-graph.js';
import { GitNexusProvider } from './adapters/providers/gitnexus.js';
import { CapabilityPlanner, type ImpactProvider } from './analyze/capability-planner.js';
import { classifyChangeSet } from './analyze/diff-analyzer.js';
import {
  BuiltinModuleImpactProvider,
  LightweightImportProvider,
  runImpactAnalysis,
} from './analyze/impact-analyzer.js';
import { assessRisk } from './analyze/risk-engine.js';
import { CacheEngine } from './cache/cache-engine.js';
import { RemoteCacheClient } from './cache/remote-cache.js';
import { evaluatePolicyContext, resolveWorkspaceRoot } from './config/loader.js';
import { currentPlatform, generateRunId, getDeviceId, sha256 } from './domain/hash.js';
import {
  AEG_VERSION,
  REPORT_SCHEMA_VERSION,
  type AnalysisMode,
  type ChangeSet,
  type ExecutionEnvironment,
  type GatePolicyName,
  type QualityReport,
  type SuiteRunResult,
  type TestPlan,
} from './domain/types.js';
import { evaluateQualityGate, mapGateToExitCode } from './gate/gate-engine.js';
import { appendRunHistory, computeSuiteFailureRates } from './metrics/history.js';
import { buildTestPlan } from './plan/test-planner.js';
import { buildAgentSummary, persistRunArtifacts } from './report/reporter.js';
import { executeTestPlan } from './run/test-runner.js';

export interface PipelineOptions {
  workspaceRoot: string;
  base?: string;
  head?: string;
  scope?: ChangeSet['scope'];
  mode?: AnalysisMode;
  policy?: GatePolicyName;
  planOnly?: boolean;
  skipTests?: boolean;
  disableCache?: boolean;
  planFilePath?: string;
  extraProviders?: ImpactProvider[];
  persistArtifacts?: boolean;
  signal?: AbortSignal;
}

export interface PipelineOutcome {
  report: QualityReport;
  exitCode: number;
  artifacts?: {
    runDir: string;
    reportPath: string;
    summaryPath: string;
    planPath: string;
  };
}

export function buildExecutionEnvironment(params: {
  projectRevision: string;
  repositoryTreeHash: string;
  worktreeClean: boolean;
}): ExecutionEnvironment {
  const platform = currentPlatform();
  const runtimeVersions: Record<string, string> = {
    node: process.versions.node,
  };
  const osVersion = os.release();
  const architecture = process.arch;
  const toolchainDigest = sha256(
    `${platform}:${osVersion}:${architecture}:node=${process.versions.node}:aeg=${AEG_VERSION}`,
  );

  return {
    deviceId: getDeviceId(),
    platform,
    osVersion,
    architecture,
    aegVersion: AEG_VERSION,
    runtimeVersions,
    toolchainDigest,
    projectRevision: params.projectRevision,
    repositoryTreeHash: params.repositoryTreeHash,
    worktreeClean: params.worktreeClean,
  };
}

export function createDefaultCapabilityPlanner(extraProviders: ImpactProvider[] = []): CapabilityPlanner {
  const planner = new CapabilityPlanner();
  planner.register(new BuiltinModuleImpactProvider());
  planner.register(new ExistingBuildGraphProvider());
  planner.register(new LightweightImportProvider());
  planner.register(new ContractsAndDbProvider());
  planner.register(new GitNexusProvider());
  planner.register(new AstSymbolsProvider());
  planner.register(new CoverageImpactProvider());
  for (const p of extraProviders) {
    planner.register(p);
  }
  return planner;
}

export async function runQualityPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
  const totalStart = Date.now();
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const git = new GitAdapter(workspaceRoot);
  const runId = generateRunId();

  // 1. Load candidate + protected baseline PolicySnapshot (once per run)
  const policyContext = evaluatePolicyContext(workspaceRoot, git, options.base);
  const effectiveBundle = policyContext.effective;
  const requestedMode: AnalysisMode =
    options.mode ?? effectiveBundle.config.analysis?.default_mode ?? 'balanced';
  const policy: GatePolicyName = options.policy ?? 'local';

  // 2. Git Diff + File classification (once per run)
  const diffStart = Date.now();
  const rawChangeSet = git.getChangeSet({
    base: options.base ?? policyContext.baseline?.sourceRef,
    head: options.head,
    scope: options.scope ?? 'combined',
  });
  const changeSet = classifyChangeSet(rawChangeSet, effectiveBundle.config);
  const diffMs = Date.now() - diffStart;

  const environment = buildExecutionEnvironment({
    projectRevision: changeSet.headRevision,
    repositoryTreeHash: changeSet.repositoryTreeHash,
    worktreeClean: !changeSet.workingTreeDirty,
  });

  // 3. Capability Planner + Impact Analysis
  const impactStart = Date.now();
  const capabilityPlanner = createDefaultCapabilityPlanner(options.extraProviders);
  const { impact, effectiveMode } = await runImpactAnalysis({
    planner: capabilityPlanner,
    input: {
      workspaceRoot,
      changeSet,
      config: effectiveBundle.config,
      modules: effectiveBundle.modules,
      mode: requestedMode,
    },
    hasPolicyRelaxation: policyContext.relaxations.length > 0,
  });
  const impactMs = Date.now() - impactStart;

  // 4. Risk Assessment
  const riskStart = Date.now();
  const risk = assessRisk({
    changeSet,
    impact,
    config: effectiveBundle.config,
    modules: effectiveBundle.modules,
    policyContext,
  });
  const riskMs = Date.now() - riskStart;

  // 5. Test Plan (or load an explicit plan file for `aeg test --plan`)
  const cacheEngine = new CacheEngine(workspaceRoot, effectiveBundle.config);
  const remoteCache = new RemoteCacheClient({ config: effectiveBundle.config });
  const historicalFailureRates = computeSuiteFailureRates(workspaceRoot);
  const planStart = Date.now();
  let plan: TestPlan;
  if (options.planFilePath) {
    const absPlan = path.resolve(workspaceRoot, options.planFilePath);
    if (!fs.existsSync(absPlan)) {
      throw new Error(`Plan file not found: ${options.planFilePath}`);
    }
    plan = JSON.parse(fs.readFileSync(absPlan, 'utf8')) as TestPlan;
    if (plan.repositoryTreeHash !== changeSet.repositoryTreeHash) {
      throw new Error(
        `Plan '${plan.id}' is stale: plan tree (${plan.repositoryTreeHash.slice(0, 12)}) does not match current working tree (${changeSet.repositoryTreeHash.slice(0, 12)}).`,
      );
    }
    if (plan.policyDigest !== effectiveBundle.policyDigest) {
      throw new Error(
        `Plan '${plan.id}' policyDigest mismatch; regenerate the plan before executing.`,
      );
    }
  } else {
    plan = buildTestPlan({
      bundle: effectiveBundle,
      changeSet,
      impact,
      risk,
      mode: effectiveMode,
      environment,
      cacheEngine,
      disableCache: options.disableCache,
      historicalFailureRates,
    });

    // Phase 4: On local cache miss, consult signed remote cache if configured and allowed
    if (!options.disableCache && effectiveMode !== 'release' && remoteCache.isEnabled()) {
      for (const planned of plan.suites) {
        if (
          planned.disposition === 'execute' &&
          planned.cacheDecision &&
          planned.cacheDecision.mode !== 'disabled'
        ) {
          const suiteDef = effectiveBundle.tests.suites[planned.suiteId];
          const pullRes = await remoteCache.pull({
            fingerprint: planned.cacheDecision.fingerprint,
            suiteId: planned.suiteId,
            portable: Boolean(suiteDef?.portable),
            repositoryTreeHash: changeSet.repositoryTreeHash,
            configDigest: effectiveBundle.configDigest,
            policyDigest: effectiveBundle.policyDigest,
            environment,
          });
          if (pullRes.hit) {
            planned.disposition = 'reuse_cache';
            planned.cacheDecision = {
              ...planned.cacheDecision,
              decision: 'hit',
              reasons: [...planned.cacheDecision.reasons, pullRes.reason],
              evidenceRefs: [
                ...planned.cacheDecision.evidenceRefs,
                `remote-cache:${planned.cacheDecision.fingerprint.slice(0, 16)}`,
              ],
            };
          }
        }
      }
    }
  }
  const planMs = Date.now() - planStart;

  // 6. Test Execution
  const runStart = Date.now();
  let results: SuiteRunResult[] = [];
  if (!options.planOnly && !options.skipTests) {
    results = await executeTestPlan({
      workspaceRoot,
      runId,
      bundle: effectiveBundle,
      plan,
      environment,
      cacheEngine,
      signal: options.signal,
    });

    // Phase 4: Push verified signed entries to remote cache (only if write-enabled & suite passed)
    if (remoteCache.isEnabled()) {
      for (const res of results) {
        if (res.status === 'passed' && !res.cached) {
          const planned = plan.suites.find((s) => s.suiteId === res.suiteId);
          const suiteDef = effectiveBundle.tests.suites[res.suiteId];
          if (planned?.cacheDecision && planned.cacheDecision.mode !== 'disabled') {
            await remoteCache.push({
              fingerprint: planned.cacheDecision.fingerprint,
              suiteId: res.suiteId,
              portable: Boolean(suiteDef?.portable),
              repositoryTreeHash: plan.repositoryTreeHash,
              configDigest: plan.configDigest,
              policyDigest: plan.policyDigest,
              environment,
              outputDigest: res.outputDigest,
              durationMs: res.durationMs,
            });
          }
        }
      }
    }
  }
  const runMs = Date.now() - runStart;

  // 7. Quality Gate Decision
  const gateStart = Date.now();
  const gate = evaluateQualityGate({
    policy,
    policyContext,
    changeSet,
    impact,
    risk,
    plan,
    results,
    planOnly: options.planOnly,
  });
  const gateMs = Date.now() - gateStart;

  // 8. Minimal Agent Summary & Full Report
  const agentSummary = buildAgentSummary({
    runId,
    mode: effectiveMode,
    policy,
    impact,
    risk,
    plan,
    results,
    gate,
    policyContext,
    maxFailureExcerptBytes: effectiveBundle.config.agent_context?.max_failure_excerpt_bytes,
  });

  const report: QualityReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId,
    aegVersion: AEG_VERSION,
    createdAt: new Date().toISOString(),
    mode: effectiveMode,
    requestedMode,
    policy,
    timings: {
      totalMs: Date.now() - totalStart,
      diffMs,
      impactMs,
      riskMs,
      planMs,
      runMs,
      gateMs,
    },
    environment,
    policyContext: {
      baselineStatus: policyContext.baselineStatus,
      baselineRef: policyContext.baseline?.sourceRef,
      configDigest: effectiveBundle.configDigest,
      policyDigest: effectiveBundle.policyDigest,
      differences: policyContext.differences,
      relaxations: policyContext.relaxations,
      warnings: policyContext.warnings,
    },
    changeSet,
    impact,
    risk,
    plan,
    results,
    gate,
    agentSummary,
  };

  const artifacts =
    options.persistArtifacts !== false
      ? persistRunArtifacts(workspaceRoot, report)
      : undefined;

  if (options.persistArtifacts !== false && !options.planOnly) {
    try {
      appendRunHistory(workspaceRoot, report, effectiveBundle.config.project.name);
    } catch {
      // non-fatal observability append
    }
  }

  const exitCode = options.planOnly
    ? 0
    : mapGateToExitCode(gate, results);

  return { report, exitCode, artifacts };
}
