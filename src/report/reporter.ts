import fs from 'node:fs';
import path from 'node:path';
import { redactSensitiveText } from '../adapters/command/command-runner.js';
import type {
  AgentSummary,
  AnalysisMode,
  ArchitectureAuditResult,
  FailureDetail,
  GateDecision,
  ImpactResult,
  PolicyEvaluationContext,
  QualityReport,
  RiskAssessment,
  SuiteRunResult,
  TestPlan,
} from '../domain/types.js';

export function buildAgentSummary(params: {
  runId: string;
  mode: AnalysisMode;
  policy: string;
  impact: ImpactResult;
  risk: RiskAssessment;
  plan: TestPlan;
  results: SuiteRunResult[];
  gate: GateDecision;
  policyContext: PolicyEvaluationContext;
  architectureAudit?: ArchitectureAuditResult;
  maxFailureExcerptBytes?: number;
}): AgentSummary {
  const { runId, mode, policy, impact, risk, plan, results, gate, policyContext, architectureAudit } = params;
  const maxExcerpt = params.maxFailureExcerptBytes ?? 4096;

  const executed = results.filter((r) => r.disposition === 'execute').length;
  const cached = results.filter((r) => r.disposition === 'reuse_cache').length;
  const blocked =
    results.length > 0
      ? results.filter((r) => r.disposition === 'blocked').length
      : plan.suites.filter((s) => s.disposition === 'blocked').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const executionFailed = results.filter((r) => r.disposition === 'execution_failed').length;
  const notRequired = plan.excludedSuites.length;

  const matchedRegs = new Set<string>();
  const passedRegs = new Set<string>();
  const statusMap = new Map(results.map((r) => [r.suiteId, r.status]));
  for (const s of plan.suites) {
    for (const reg of s.matchedRegressions) {
      matchedRegs.add(reg);
      if (statusMap.get(s.suiteId) === 'passed') {
        passedRegs.add(reg);
      }
    }
  }

  // Section 13.1: Do NOT inject logs on pass; on failure return only bounded excerpts + artifact_ref
  // Enforce BOTH per-failure cap and TOTAL byte budget across all failures to protect agent context windows!
  const failures: AgentSummary['failures'] = [];
  const artifactRefs: string[] = [];
  const totalExcerptBudget = Math.max(512, maxExcerpt);
  let usedExcerptBytes = 0;

  for (const res of results) {
    if (res.status !== 'passed' && res.status !== 'skipped') {
      for (const f of res.failureDetails) {
        const remaining = Math.max(0, totalExcerptBudget - usedExcerptBytes);
        const perCap = Math.min(remaining, Math.max(512, Math.floor(totalExcerptBudget / 2)));
        let excerpt: string;
        if (remaining < 128) {
          excerpt = `[omitted due to agent_context byte budget; run \`aeg inspect log ${f.id} --lines 80\`]`;
        } else if (Buffer.byteLength(f.excerpt, 'utf8') > perCap) {
          excerpt = `${f.excerpt.slice(0, perCap)}\n[...truncated; run \`aeg inspect log ${f.id} --lines 80\`]`;
        } else {
          excerpt = f.excerpt;
        }
        const cleanExcerpt = redactSensitiveText(excerpt);
        usedExcerptBytes += Buffer.byteLength(cleanExcerpt, 'utf8');
        failures.push({
          id: f.id,
          suite_id: f.suiteId,
          category: f.category,
          message: redactSensitiveText(f.message),
          location: f.location,
          excerpt: cleanExcerpt,
          artifact_ref: f.artifactRef,
        });
        if (f.artifactRef) artifactRefs.push(f.artifactRef);
      }
    }
  }

  const actionRequired = gate.outcome !== 'passed' || gate.workflowAction !== 'continue';

  return {
    run_id: runId,
    outcome: gate.outcome,
    workflow_action: gate.workflowAction,
    mode,
    policy,
    changed_modules: impact.directlyChangedModules,
    affected_modules: Array.from(
      new Set([...impact.directlyChangedModules, ...impact.transitivelyAffectedModules]),
    ).sort(),
    risk: {
      level: risk.level,
      reasons: risk.factors.map((f) => f.reason),
    },
    tests: {
      executed,
      cached,
      not_required: notRequired,
      blocked,
      failed,
      execution_failed: executionFailed,
      dedup_saved: plan.dedupStats.savedExecutions,
    },
    regressions: {
      matched: matchedRegs.size,
      passed: passedRegs.size,
    },
    unknowns: Array.from(new Set([...impact.unknowns, ...plan.unknowns])),
    policy_relaxations: policyContext.relaxations.map((r) => `${r.target}: ${r.reason}`),
    ...(architectureAudit && architectureAudit.findings.length > 0
      ? { architecture_hints: architectureAudit.findings }
      : {}),
    failures,
    agent_action: {
      required: actionRequired,
      next_steps: actionRequired ? gate.requiredActions : [],
    },
    artifact_refs: Array.from(new Set(artifactRefs)),
  };
}

export function persistRunArtifacts(workspaceRoot: string, report: QualityReport): {
  runDir: string;
  reportPath: string;
  summaryPath: string;
  planPath: string;
} {
  const aegDir = path.join(workspaceRoot, '.aeg');
  const runDir = path.join(aegDir, 'runs', report.runId);
  const plansDir = path.join(aegDir, 'plans');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(plansDir, { recursive: true });

  const reportPath = path.join(runDir, 'report.json');
  const summaryPath = path.join(runDir, 'agent-summary.json');
  const planPath = path.join(plansDir, `${report.plan.id}.json`);
  const currentPlanPath = path.join(plansDir, 'current.json');
  const latestRunPath = path.join(aegDir, 'runs', 'latest.json');

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(summaryPath, JSON.stringify(report.agentSummary, null, 2), 'utf8');
  fs.writeFileSync(planPath, JSON.stringify(report.plan, null, 2), 'utf8');
  fs.writeFileSync(currentPlanPath, JSON.stringify(report.plan, null, 2), 'utf8');
  fs.writeFileSync(
    latestRunPath,
    JSON.stringify({ runId: report.runId, reportPath, summaryPath, planPath, createdAt: report.createdAt }, null, 2),
    'utf8',
  );

  return { runDir, reportPath, summaryPath, planPath };
}

export function loadLatestReport(workspaceRoot: string, runId?: string): QualityReport | undefined {
  const runsDir = path.join(workspaceRoot, '.aeg', 'runs');
  if (runId) {
    const p = path.join(runsDir, runId, 'report.json');
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as QualityReport) : undefined;
  }
  const latestPath = path.join(runsDir, 'latest.json');
  if (!fs.existsSync(latestPath)) return undefined;
  try {
    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as { reportPath?: string };
    if (latest.reportPath && fs.existsSync(latest.reportPath)) {
      return JSON.parse(fs.readFileSync(latest.reportPath, 'utf8')) as QualityReport;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function inspectFailureDetail(
  report: QualityReport,
  failureOrSuiteId?: string,
): FailureDetail[] {
  const all = report.results.flatMap((r) => r.failureDetails);
  if (!failureOrSuiteId) return all;
  return all.filter((f) => f.id === failureOrSuiteId || f.suiteId === failureOrSuiteId);
}

export function readBoundedLogExcerpt(params: {
  logPath: string;
  startLine?: number;
  maxLines?: number;
  maxBytes?: number;
}): { content: string; totalLines: number; truncated: boolean } {
  if (!fs.existsSync(params.logPath)) {
    return { content: `Log artifact not found: ${params.logPath}`, totalLines: 0, truncated: false };
  }
  const raw = redactSensitiveText(fs.readFileSync(params.logPath, 'utf8'));
  const lines = raw.split(/\r?\n/);
  const start = Math.max(1, params.startLine ?? 1);
  const maxLines = Math.min(500, Math.max(1, params.maxLines ?? 120));
  const maxBytes = Math.min(65536, Math.max(256, params.maxBytes ?? 16384));

  const slice = lines.slice(start - 1, start - 1 + maxLines);
  let out = slice.join('\n');
  let truncated = start - 1 + maxLines < lines.length;
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, maxBytes);
    truncated = true;
  }
  return { content: out, totalLines: lines.length, truncated };
}

export function formatTextReport(report: QualityReport): string {
  const lines: string[] = [];
  const s = report.agentSummary;

  lines.push(`AI Engineering Guard (aeg v${report.aegVersion}) — ${report.runId}`);
  lines.push(
    `Outcome: ${s.outcome.toUpperCase()} | Action: ${s.workflow_action} | Risk: ${s.risk.level} | Mode: ${report.mode}${report.mode !== report.requestedMode ? ` (escalated from ${report.requestedMode})` : ''} | Policy: ${report.policy}`,
  );
  lines.push(
    `Changed files: ${report.changeSet.files.length} | Direct modules: [${s.changed_modules.join(', ') || 'none'}] | Affected modules: [${s.affected_modules.join(', ') || 'none'}]`,
  );
  lines.push(
    `Tests: executed=${s.tests.executed}, cached=${s.tests.cached}, not_required=${s.tests.not_required}, blocked=${s.tests.blocked}, failed=${s.tests.failed}, exec_failed=${s.tests.execution_failed}, dedup_saved=${s.tests.dedup_saved}`,
  );

  if (s.risk.reasons.length > 0) {
    lines.push('');
    lines.push('Risk Reasons:');
    for (const r of s.risk.reasons) lines.push(`  - ${r}`);
  }

  if (s.policy_relaxations.length > 0) {
    lines.push('');
    lines.push('Policy Relaxations Detected (Blocked / Baseline Enforced):');
    for (const r of s.policy_relaxations) lines.push(`  ! ${r}`);
  }

  if (s.unknowns.length > 0) {
    lines.push('');
    lines.push('Unknowns / Fallbacks:');
    for (const u of s.unknowns) lines.push(`  ? ${u}`);
  }

  if (s.architecture_hints && s.architecture_hints.length > 0) {
    lines.push('');
    lines.push('Architecture & Maintainability Hints (avoid spaghetti debt):');
    for (const h of s.architecture_hints) {
      lines.push(`  * [${h.severity}/${h.ruleId}] ${h.file}${h.line ? `:${h.line}` : ''} — ${h.message}`);
      lines.push(`    Better approach: ${h.betterApproach}`);
    }
  }

  if (report.plan.suites.length > 0) {
    lines.push('');
    lines.push('Planned Suites:');
    const resMap = new Map(report.results.map((r) => [r.suiteId, r]));
    for (const suite of report.plan.suites) {
      const res = resMap.get(suite.suiteId);
      const statusStr = res ? `${res.status} (${res.durationMs}ms)` : suite.disposition;
      lines.push(`  - ${suite.suiteId} [${suite.disposition} -> ${statusStr}]: ${suite.selectionReasons.join('; ')}`);
    }
  }

  if (s.failures.length > 0) {
    lines.push('');
    lines.push('Failures (bounded excerpt; run `aeg inspect log <id>` for more):');
    for (const f of s.failures) {
      lines.push(`  x [${f.id}] (${f.category}) ${f.message}${f.location ? ` @ ${f.location}` : ''}`);
      lines.push(`    artifact: ${f.artifact_ref}`);
    }
  }

  if (s.agent_action.required && s.agent_action.next_steps.length > 0) {
    lines.push('');
    lines.push('Required Actions:');
    for (const step of s.agent_action.next_steps) lines.push(`  -> ${step}`);
  }

  lines.push('');
  lines.push(
    `Timings: total=${report.timings.totalMs}ms (diff=${report.timings.diffMs}ms, impact=${report.timings.impactMs}ms, plan=${report.timings.planMs}ms, run=${report.timings.runMs}ms)`,
  );

  return lines.join('\n');
}
