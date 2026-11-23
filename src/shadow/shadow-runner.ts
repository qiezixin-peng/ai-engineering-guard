import fs from 'node:fs';
import path from 'node:path';
import { runStructuredCommand } from '../adapters/command/command-runner.js';
import { parseDurationMs } from '../domain/hash.js';
import type { QualityReport } from '../domain/types.js';
import { runQualityPipeline } from '../engine.js';

export interface ShadowBudgetState {
  weekKey: string;
  usedMs: number;
  runsCompleted: number;
  runsDeferred: number;
  totalMissedFailures: number;
  lastRunAt: string;
}

export interface ShadowCheckResult {
  status: 'completed' | 'deferred_budget_exhausted' | 'skipped_sampling';
  runId?: string;
  selectedSuites: string[];
  excludedCheckedSuites: string[];
  missedFailures: Array<{ suiteId: string; status: string; message?: string }>;
  recall: number | null;
  durationMs: number;
  budgetRemainingMs: number;
  weekKey: string;
  note: string;
}

function getIsoWeekKey(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function budgetStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.aeg', 'metrics', 'shadow-budget.json');
}

export function loadShadowBudgetState(workspaceRoot: string): ShadowBudgetState {
  const weekKey = getIsoWeekKey();
  const p = budgetStatePath(workspaceRoot);
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as ShadowBudgetState;
      if (parsed.weekKey === weekKey) {
        return parsed;
      }
    } catch {
      // reset on corrupt state
    }
  }
  return {
    weekKey,
    usedMs: 0,
    runsCompleted: 0,
    runsDeferred: 0,
    totalMissedFailures: 0,
    lastRunAt: new Date().toISOString(),
  };
}

function saveShadowBudgetState(workspaceRoot: string, state: ShadowBudgetState): void {
  const p = budgetStatePath(workspaceRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Budget-controlled Shadow Full-Run Verification (Section 15 & Acceptance #23).
 * Compares AEG's intelligent test selection against executing excluded (`not_required`) suites
 * within weekly and per-run duration budgets, measuring recall and detecting missed regressions.
 */
export async function runBudgetedShadowCheck(params: {
  workspaceRoot: string;
  base?: string;
  forceRun?: boolean;
}): Promise<ShadowCheckResult> {
  const workspaceRoot = path.resolve(params.workspaceRoot);
  const startMs = Date.now();

  // First run standard planning + execution in balanced mode
  const { report } = await runQualityPipeline({
    workspaceRoot,
    base: params.base,
    mode: 'balanced',
    policy: 'local',
    persistArtifacts: true,
  });

  const shadowCfg = report.policyContext.baselineStatus !== 'unparseable'
    ? (await import('../config/loader.js')).loadWorkingTreeConfig(workspaceRoot).config.shadow_tests
    : undefined;

  const weeklyBudgetMs = parseDurationMs(shadowCfg?.weekly_budget, 6 * 3_600_000);
  const maxDurationMs = parseDurationMs(shadowCfg?.max_duration, 60 * 60_000);
  const sampleRate = shadowCfg?.sample_rate ?? 1.0;

  const state = loadShadowBudgetState(workspaceRoot);
  const remainingBefore = Math.max(0, weeklyBudgetMs - state.usedMs);

  if (remainingBefore <= 0) {
    state.runsDeferred += 1;
    state.lastRunAt = new Date().toISOString();
    saveShadowBudgetState(workspaceRoot, state);
    return {
      status: 'deferred_budget_exhausted',
      runId: report.runId,
      selectedSuites: report.plan.suites.map((s) => s.suiteId),
      excludedCheckedSuites: [],
      missedFailures: [],
      recall: null,
      durationMs: Date.now() - startMs,
      budgetRemainingMs: 0,
      weekKey: state.weekKey,
      note: 'Weekly shadow budget exhausted; deferred non-blocking shadow verification and recorded coverage gap.',
    };
  }

  if (!params.forceRun && sampleRate < 1.0 && Math.random() > sampleRate) {
    return {
      status: 'skipped_sampling',
      runId: report.runId,
      selectedSuites: report.plan.suites.map((s) => s.suiteId),
      excludedCheckedSuites: [],
      missedFailures: [],
      recall: null,
      durationMs: Date.now() - startMs,
      budgetRemainingMs: remainingBefore,
      weekKey: state.weekKey,
      note: `Skipped by configured shadow sample_rate (${sampleRate}). Pass --force to run immediately.`,
    };
  }

  const { loadWorkingTreeConfig } = await import('../config/loader.js');
  const bundle = loadWorkingTreeConfig(workspaceRoot);
  const logsDir = path.join(workspaceRoot, '.aeg', 'runs', report.runId, 'shadow-logs');
  const excludedIds = report.plan.excludedSuites.map((e) => e.suiteId);
  const excludedChecked: string[] = [];
  const missedFailures: Array<{ suiteId: string; status: string; message?: string }> = [];

  const shadowStart = Date.now();
  for (const suiteId of excludedIds) {
    const elapsed = Date.now() - shadowStart;
    if (elapsed >= maxDurationMs || state.usedMs + elapsed >= weeklyBudgetMs) {
      break;
    }
    const def = bundle.tests.suites[suiteId];
    if (!def) continue;

    excludedChecked.push(suiteId);
    const out = await runStructuredCommand({
      workspaceRoot,
      suiteId: `shadow-${suiteId}`,
      framework: def.framework,
      command: def.command,
      artifactDir: logsDir,
    });
    if (out.status !== 'passed') {
      missedFailures.push({
        suiteId,
        status: out.status,
        message: out.failureDetails[0]?.message,
      });
    }
  }

  const shadowDurationMs = Date.now() - shadowStart;
  const selectedFailures = report.results.filter((r) => r.status === 'failed').length;
  const totalActualFailures = selectedFailures + missedFailures.length;
  const recall =
    totalActualFailures === 0
      ? 1.0
      : Number((selectedFailures / totalActualFailures).toFixed(4));

  state.usedMs += shadowDurationMs;
  state.runsCompleted += 1;
  state.totalMissedFailures += missedFailures.length;
  state.lastRunAt = new Date().toISOString();
  saveShadowBudgetState(workspaceRoot, state);

  // Append shadow audit record
  const shadowAuditPath = path.join(workspaceRoot, '.aeg', 'metrics', 'shadow-audit.jsonl');
  fs.mkdirSync(path.dirname(shadowAuditPath), { recursive: true });
  fs.appendFileSync(
    shadowAuditPath,
    `${JSON.stringify({
      timestamp: state.lastRunAt,
      runId: report.runId,
      selectedSuites: report.plan.suites.map((s) => s.suiteId),
      excludedCheckedSuites: excludedChecked,
      missedFailures,
      recall,
      shadowDurationMs,
    })}\n`,
    'utf8',
  );

  return {
    status: 'completed',
    runId: report.runId,
    selectedSuites: report.plan.suites.map((s) => s.suiteId),
    excludedCheckedSuites: excludedChecked,
    missedFailures,
    recall,
    durationMs: Date.now() - startMs,
    budgetRemainingMs: Math.max(0, weeklyBudgetMs - state.usedMs),
    weekKey: state.weekKey,
    note:
      missedFailures.length > 0
        ? `ALERT: Shadow run detected ${missedFailures.length} missed failure(s) in excluded suites: ${missedFailures.map((m) => m.suiteId).join(', ')}.`
        : `Shadow verification passed with 0 missed failures across ${excludedChecked.length} excluded suite(s).`,
  };
}

export type { QualityReport };
