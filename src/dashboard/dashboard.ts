import fs from 'node:fs';
import path from 'node:path';
import { AEG_VERSION, type RiskLevel } from '../domain/types.js';
import { computeSuiteFailureRates, loadRunHistory, type HistoryRecord } from '../metrics/history.js';
import { loadShadowAuditSummary, type ShadowAuditSummary } from '../shadow/shadow-runner.js';

export interface ProjectDashboardSummary {
  projectName: string;
  workspacePath: string;
  totalRuns: number;
  passRate: number;
  incompleteRate: number;
  avgFeedbackMs: number;
  cacheHitRate: number;
  totalDedupSaved: number;
  policyRelaxationAlerts: number;
  avgAgentSummaryBytes: number;
  riskDistribution: Record<RiskLevel, number>;
  topFailingSuites: Array<{ suiteId: string; failureRate: number }>;
  shadowAudit: ShadowAuditSummary;
  latestRun?: HistoryRecord;
}

export interface MultiProjectDashboardData {
  generatedAt: string;
  aegVersion: string;
  projectCount: number;
  totals: {
    totalRuns: number;
    overallPassRate: number;
    overallCacheHitRate: number;
    totalDedupSaved: number;
    avgAgentSummaryBytes: number;
    totalShadowMissedFailures: number;
  };
  projects: ProjectDashboardSummary[];
}

export function collectMultiProjectDashboard(projectPaths: string[]): MultiProjectDashboardData {
  const projects: ProjectDashboardSummary[] = [];

  for (const rawPath of projectPaths) {
    const absPath = path.resolve(rawPath);
    const history = loadRunHistory(absPath);
    const failureRates = computeSuiteFailureRates(absPath);
    const shadowAudit = loadShadowAuditSummary(absPath);

    let projectName = path.basename(absPath);
    if (history.length > 0 && history.at(-1)?.project) {
      projectName = history.at(-1)!.project;
    }

    const riskDist: Record<RiskLevel, number> = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 };
    let passed = 0;
    let incomplete = 0;
    let totalMsSum = 0;
    let totalExec = 0;
    let totalCached = 0;
    let totalDedup = 0;
    let totalRelax = 0;
    let summaryBytesSum = 0;

    for (const r of history) {
      riskDist[r.riskLevel] = (riskDist[r.riskLevel] ?? 0) + 1;
      if (r.outcome === 'passed') passed += 1;
      if (r.outcome === 'incomplete') incomplete += 1;
      totalMsSum += r.totalMs;
      totalExec += r.executed;
      totalCached += r.cached;
      totalDedup += r.dedupSaved;
      totalRelax += r.relaxationCount;
      summaryBytesSum += r.agentSummaryBytes;
    }

    const totalRuns = history.length;
    const totalAttempts = totalExec + totalCached;
    const topFailingSuites = Object.entries(failureRates)
      .filter(([, rate]) => rate > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([suiteId, failureRate]) => ({ suiteId, failureRate }));

    projects.push({
      projectName,
      workspacePath: absPath,
      totalRuns,
      passRate: totalRuns > 0 ? Number((passed / totalRuns).toFixed(4)) : 0,
      incompleteRate: totalRuns > 0 ? Number((incomplete / totalRuns).toFixed(4)) : 0,
      avgFeedbackMs: totalRuns > 0 ? Math.round(totalMsSum / totalRuns) : 0,
      cacheHitRate: totalAttempts > 0 ? Number((totalCached / totalAttempts).toFixed(4)) : 0,
      totalDedupSaved: totalDedup,
      policyRelaxationAlerts: totalRelax,
      avgAgentSummaryBytes: totalRuns > 0 ? Math.round(summaryBytesSum / totalRuns) : 0,
      riskDistribution: riskDist,
      topFailingSuites,
      shadowAudit,
      latestRun: history.at(-1),
    });
  }

  const allRuns = projects.reduce((acc, p) => acc + p.totalRuns, 0);
  const weightedPass =
    allRuns > 0
      ? Number((projects.reduce((acc, p) => acc + p.passRate * p.totalRuns, 0) / allRuns).toFixed(4))
      : 0;
  const weightedCache =
    allRuns > 0
      ? Number((projects.reduce((acc, p) => acc + p.cacheHitRate * p.totalRuns, 0) / allRuns).toFixed(4))
      : 0;
  const totalDedupSaved = projects.reduce((acc, p) => acc + p.totalDedupSaved, 0);
  const avgAgentSummaryBytes =
    allRuns > 0
      ? Math.round(projects.reduce((acc, p) => acc + p.avgAgentSummaryBytes * p.totalRuns, 0) / allRuns)
      : 0;
  const totalShadowMissedFailures = projects.reduce(
    (acc, p) => acc + p.shadowAudit.totalMissedFailures,
    0,
  );

  return {
    generatedAt: new Date().toISOString(),
    aegVersion: AEG_VERSION,
    projectCount: projects.length,
    totals: {
      totalRuns: allRuns,
      overallPassRate: weightedPass,
      overallCacheHitRate: weightedCache,
      totalDedupSaved,
      avgAgentSummaryBytes,
      totalShadowMissedFailures,
    },
    projects,
  };
}

/**
 * Generates an offline, zero-CDN, self-contained HTML Multi-Project Quality Dashboard (Section 12.3 & 20.3).
 */
export function renderDashboardHtml(data: MultiProjectDashboardData): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const rows = data.projects
    .map(
      (p) => `<tr>
      <td><strong>${esc(p.projectName)}</strong><br><span class="muted">${esc(p.workspacePath)}</span></td>
      <td>${p.totalRuns}</td>
      <td class="${p.passRate >= 0.9 ? 'ok' : p.passRate >= 0.7 ? 'warn' : 'bad'}">${pct(p.passRate)}</td>
      <td>${pct(p.cacheHitRate)}</td>
      <td>${p.avgFeedbackMs} ms</td>
      <td>${p.totalDedupSaved}</td>
      <td>${p.avgAgentSummaryBytes} B</td>
      <td>L0:${p.riskDistribution.L0} L1:${p.riskDistribution.L1} L2:${p.riskDistribution.L2} L3:${p.riskDistribution.L3} L4:${p.riskDistribution.L4}</td>
      <td>${p.shadowAudit.averageRecall !== null ? pct(p.shadowAudit.averageRecall) : 'n/a'} (missed: ${p.shadowAudit.totalMissedFailures})</td>
      <td class="${p.policyRelaxationAlerts > 0 ? 'bad' : 'ok'}">${p.policyRelaxationAlerts}</td>
    </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Engineering Guard — Multi-Project Quality Dashboard</title>
  <style>
    :root { --bg:#0d1117; --card:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#58a6ff; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
    .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .card .val { font-size: 24px; font-weight: 700; margin-top: 6px; color: var(--accent); }
    table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; font-size: 13px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { background: #1f2630; color: var(--muted); font-weight: 600; }
    .muted { color: var(--muted); font-size: 11px; }
    .ok { color: var(--ok); font-weight: 600; }
    .warn { color: var(--warn); font-weight: 600; }
    .bad { color: var(--bad); font-weight: 600; }
  </style>
</head>
<body>
  <h1>AI Engineering Guard — Multi-Project Quality Dashboard</h1>
  <div class="sub">AEG v${esc(data.aegVersion)} · Generated ${esc(data.generatedAt)} · ${data.projectCount} Project(s)</div>
  <div class="grid">
    <div class="card"><div class="label">Total Quality Runs</div><div class="val">${data.totals.totalRuns}</div></div>
    <div class="card"><div class="label">Overall Pass Rate</div><div class="val">${pct(data.totals.overallPassRate)}</div></div>
    <div class="card"><div class="label">Cache Reuse Rate</div><div class="val">${pct(data.totals.overallCacheHitRate)}</div></div>
    <div class="card"><div class="label">Dedup Executions Saved</div><div class="val">${data.totals.totalDedupSaved}</div></div>
    <div class="card"><div class="label">Avg Agent Summary</div><div class="val">${data.totals.avgAgentSummaryBytes} B</div></div>
    <div class="card"><div class="label">Shadow Missed Failures</div><div class="val">${data.totals.totalShadowMissedFailures}</div></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Project</th><th>Runs</th><th>Pass Rate</th><th>Cache Hit</th><th>Avg Latency</th>
        <th>Dedup Saved</th><th>Agent Context</th><th>Risk Distribution</th><th>Shadow Recall</th><th>Policy Alerts</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="10" class="muted">No quality runs recorded yet.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}
