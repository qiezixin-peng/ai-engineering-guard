import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisMode, GateDecision, QualityReport, RiskLevel } from '../domain/types.js';

export interface HistoryRecord {
  runId: string;
  timestamp: string;
  project: string;
  mode: AnalysisMode;
  policy: string;
  riskLevel: RiskLevel;
  outcome: GateDecision['outcome'];
  workflowAction: GateDecision['workflowAction'];
  totalMs: number;
  runMs: number;
  executed: number;
  cached: number;
  notRequired: number;
  blocked: number;
  failed: number;
  executionFailed: number;
  dedupSaved: number;
  relaxationCount: number;
  unknownCount: number;
  agentSummaryBytes: number;
  suiteOutcomes: Record<string, 'passed' | 'failed' | 'error' | 'timeout' | 'cancelled' | 'skipped'>;
}

const MAX_HISTORY_LINES = 1000;

export function getHistoryFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.aeg', 'metrics', 'history.jsonl');
}

export function appendRunHistory(workspaceRoot: string, report: QualityReport, projectName: string): void {
  const filePath = getHistoryFilePath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const s = report.agentSummary;
  const suiteOutcomes: HistoryRecord['suiteOutcomes'] = {};
  for (const res of report.results) {
    suiteOutcomes[res.suiteId] = res.status;
  }

  const record: HistoryRecord = {
    runId: report.runId,
    timestamp: report.createdAt,
    project: projectName,
    mode: report.mode,
    policy: report.policy,
    riskLevel: report.risk.level,
    outcome: report.gate.outcome,
    workflowAction: report.gate.workflowAction,
    totalMs: report.timings.totalMs,
    runMs: report.timings.runMs,
    executed: s.tests.executed,
    cached: s.tests.cached,
    notRequired: s.tests.not_required,
    blocked: s.tests.blocked,
    failed: s.tests.failed,
    executionFailed: s.tests.execution_failed,
    dedupSaved: s.tests.dedup_saved,
    relaxationCount: report.policyContext.relaxations.length,
    unknownCount: s.unknowns.length,
    agentSummaryBytes: Buffer.byteLength(JSON.stringify(s), 'utf8'),
    suiteOutcomes,
  };

  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');

  // Keep file bounded so local storage never grows unbounded
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_HISTORY_LINES) {
      fs.writeFileSync(filePath, `${lines.slice(-MAX_HISTORY_LINES).join('\n')}\n`, 'utf8');
    }
  } catch {
    // non-fatal
  }
}

export function loadRunHistory(workspaceRoot: string): HistoryRecord[] {
  const filePath = getHistoryFilePath(workspaceRoot);
  if (!fs.existsSync(filePath)) return [];
  const records: HistoryRecord[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as HistoryRecord);
    } catch {
      // skip corrupted line
    }
  }
  return records;
}

/**
 * Computes per-suite historical failure rate in [0, 1] for fail-fast test prioritization (Section 15 & 20.3).
 */
export function computeSuiteFailureRates(workspaceRoot: string): Record<string, number> {
  const history = loadRunHistory(workspaceRoot);
  const counts = new Map<string, { total: number; failed: number }>();

  for (const rec of history) {
    for (const [suiteId, status] of Object.entries(rec.suiteOutcomes ?? {})) {
      if (status === 'skipped') continue;
      const c = counts.get(suiteId) ?? { total: 0, failed: 0 };
      c.total += 1;
      if (status === 'failed' || status === 'error' || status === 'timeout') {
        c.failed += 1;
      }
      counts.set(suiteId, c);
    }
  }

  const rates: Record<string, number> = {};
  for (const [suiteId, c] of counts.entries()) {
    if (c.total > 0) {
      rates[suiteId] = Number((c.failed / c.total).toFixed(4));
    }
  }
  return rates;
}

export type ShadowAuditSummary = {
  totalShadowRuns: number;
  totalMissedFailures: number;
  averageRecall: number | null;
};

export function loadShadowAuditSummary(workspaceRoot: string): ShadowAuditSummary {
  const p = path.join(workspaceRoot, '.aeg', 'metrics', 'shadow-audit.jsonl');
  if (!fs.existsSync(p)) {
    return { totalShadowRuns: 0, totalMissedFailures: 0, averageRecall: null };
  }
  let runs = 0;
  let missed = 0;
  let recallSum = 0;
  let recallCount = 0;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { missedFailures?: unknown[]; recall?: number | null };
      runs += 1;
      missed += rec.missedFailures?.length ?? 0;
      if (typeof rec.recall === 'number') {
        recallSum += rec.recall;
        recallCount += 1;
      }
    } catch {
      // skip
    }
  }
  return {
    totalShadowRuns: runs,
    totalMissedFailures: missed,
    averageRecall: recallCount > 0 ? Number((recallSum / recallCount).toFixed(4)) : null,
  };
}
