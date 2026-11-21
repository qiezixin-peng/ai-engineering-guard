import crypto from 'node:crypto';
import path from 'node:path';
import { runStructuredCommand } from '../adapters/command/command-runner.js';
import type { CacheEngine } from '../cache/cache-engine.js';
import { sha256 } from '../domain/hash.js';
import type {
  ExecutionEnvironment,
  ProjectConfigBundle,
  SuiteDisposition,
  SuiteRunResult,
  TestPlan,
  TestResultReceipt,
} from '../domain/types.js';

export interface RunPlanOptions {
  workspaceRoot: string;
  runId: string;
  bundle: ProjectConfigBundle;
  plan: TestPlan;
  environment: ExecutionEnvironment;
  cacheEngine: CacheEngine;
  signal?: AbortSignal;
}

export async function executeTestPlan(options: RunPlanOptions): Promise<SuiteRunResult[]> {
  const { workspaceRoot, runId, bundle, plan, environment, cacheEngine, signal } = options;
  const logsDir = path.join(workspaceRoot, '.aeg', 'runs', runId, 'logs');
  const maxExcerptBytes = bundle.config.agent_context?.max_failure_excerpt_bytes ?? 16_384;
  const results: SuiteRunResult[] = [];
  const statusBySuite = new Map<string, SuiteRunResult['status']>();

  for (const planned of plan.suites) {
    const suiteDef = bundle.tests.suites[planned.suiteId];
    const now = new Date().toISOString();

    if (!suiteDef) {
      const res: SuiteRunResult = {
        suiteId: planned.suiteId,
        executionVariant: planned.executionVariant,
        disposition: 'execution_failed',
        status: 'error',
        cached: false,
        durationMs: 0,
        startedAt: now,
        finishedAt: now,
        outputDigest: sha256(`missing-suite:${planned.suiteId}`),
        artifactRefs: [],
        failureDetails: [
          {
            id: `${planned.suiteId}:missing-def`,
            suiteId: planned.suiteId,
            category: 'spawn_error',
            message: `Suite '${planned.suiteId}' in plan does not exist in effective project configuration.`,
            excerpt: `Suite '${planned.suiteId}' is not declared in tests.yaml.`,
            artifactRef: '',
          },
        ],
      };
      results.push(res);
      statusBySuite.set(planned.suiteId, 'error');
      continue;
    }

    if (planned.disposition === 'blocked') {
      const res: SuiteRunResult = {
        suiteId: planned.suiteId,
        executionVariant: planned.executionVariant,
        disposition: 'blocked',
        status: 'skipped',
        cached: false,
        durationMs: 0,
        startedAt: now,
        finishedAt: now,
        outputDigest: sha256(`blocked:${planned.suiteId}`),
        artifactRefs: [],
        failureDetails: [],
      };
      results.push(res);
      statusBySuite.set(planned.suiteId, 'skipped');
      continue;
    }

    // Check if an upstream dependency suite failed/blocked
    const failedDep = planned.dependencySuiteIds.find((depId) => {
      const st = statusBySuite.get(depId);
      return st !== undefined && st !== 'passed';
    });
    if (failedDep) {
      const res: SuiteRunResult = {
        suiteId: planned.suiteId,
        executionVariant: planned.executionVariant,
        disposition: 'blocked',
        status: 'skipped',
        cached: false,
        durationMs: 0,
        startedAt: now,
        finishedAt: now,
        outputDigest: sha256(`dep-failed:${failedDep}`),
        artifactRefs: [],
        failureDetails: [],
      };
      results.push(res);
      statusBySuite.set(planned.suiteId, 'skipped');
      continue;
    }

    if (planned.disposition === 'reuse_cache') {
      const receipt = buildReceipt({
        projectId: bundle.config.project.name,
        runId,
        suiteId: planned.suiteId,
        plan,
        environment,
        status: 'passed',
        startedAt: now,
        finishedAt: now,
        outputDigest: planned.cacheDecision?.fingerprint ?? sha256(`cache:${planned.suiteId}`),
        artifactRefs: planned.cacheDecision?.evidenceRefs ?? [],
      });
      const res: SuiteRunResult = {
        suiteId: planned.suiteId,
        executionVariant: planned.executionVariant,
        disposition: 'reuse_cache',
        status: 'passed',
        cached: true,
        durationMs: 0,
        exitCode: 0,
        startedAt: now,
        finishedAt: now,
        outputDigest: receipt.outputDigest,
        artifactRefs: [],
        failureDetails: [],
        receipt,
      };
      results.push(res);
      statusBySuite.set(planned.suiteId, 'passed');
      continue;
    }

    // Execute structured command safely
    const execOut = await runStructuredCommand({
      workspaceRoot,
      suiteId: planned.suiteId,
      framework: suiteDef.framework,
      command: suiteDef.command,
      artifactDir: logsDir,
      maxExcerptBytes,
      signal,
    });

    const finalDisposition: SuiteDisposition =
      execOut.status === 'error' || execOut.status === 'timeout' || execOut.status === 'cancelled'
        ? 'execution_failed'
        : 'execute';

    const receipt = buildReceipt({
      projectId: bundle.config.project.name,
      runId,
      suiteId: planned.suiteId,
      plan,
      environment,
      status: execOut.status,
      startedAt: execOut.startedAt,
      finishedAt: execOut.finishedAt,
      outputDigest: execOut.outputDigest,
      artifactRefs: [execOut.logArtifactPath],
    });

    const suiteResult: SuiteRunResult = {
      suiteId: planned.suiteId,
      executionVariant: planned.executionVariant,
      disposition: finalDisposition,
      status: execOut.status,
      cached: false,
      durationMs: execOut.durationMs,
      exitCode: execOut.exitCode,
      startedAt: execOut.startedAt,
      finishedAt: execOut.finishedAt,
      outputDigest: execOut.outputDigest,
      artifactRefs: [execOut.logArtifactPath],
      failureDetails: execOut.failureDetails,
      receipt,
    };

    // Phase 2: Record shadow comparison for suite_fingerprint shadow_candidates (instant revocation on mismatch)
    cacheEngine.recordShadowComparison({
      suiteId: planned.suiteId,
      cacheDecision: planned.cacheDecision,
      actualStatus: suiteResult.status,
    });

    if (suiteResult.status === 'passed') {
      const allowedEnvValues: Record<string, string> = {};
      for (const envKey of suiteDef.command.environment_allowlist ?? []) {
        if (process.env[envKey] !== undefined) {
          allowedEnvValues[envKey] = process.env[envKey]!;
        }
      }
      cacheEngine.storePassedResult({
        config: bundle.config,
        keyInput: {
          repositoryTreeHash: plan.repositoryTreeHash,
          suiteId: planned.suiteId,
          executionVariant: planned.executionVariant,
          suiteDef,
          configDigest: plan.configDigest,
          policyDigest: plan.policyDigest,
          environment,
          allowedEnvValues,
        },
        result: suiteResult,
      });
    }

    results.push(suiteResult);
    statusBySuite.set(planned.suiteId, suiteResult.status);
  }

  return results;
}

function buildReceipt(params: {
  projectId: string;
  runId: string;
  suiteId: string;
  plan: TestPlan;
  environment: ExecutionEnvironment;
  status: TestResultReceipt['status'];
  startedAt: string;
  finishedAt: string;
  outputDigest: string;
  artifactRefs: string[];
}): TestResultReceipt {
  return {
    receiptId: `rcpt-${crypto.randomBytes(6).toString('hex')}`,
    projectId: params.projectId,
    taskId: params.runId,
    attemptId: 'attempt-1',
    suiteId: params.suiteId,
    planDigest: params.plan.planDigest,
    configDigest: params.plan.configDigest,
    policyDigest: params.plan.policyDigest,
    repositoryTreeHash: params.plan.repositoryTreeHash,
    environment: params.environment,
    status: params.status,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    outputDigest: params.outputDigest,
    artifactRefs: params.artifactRefs,
  };
}
