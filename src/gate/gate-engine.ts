import {
  EXIT_CODES,
  type ChangeSet,
  type ExitCode,
  type GateDecision,
  type GatePolicyName,
  type GateReason,
  type ImpactResult,
  type PolicyEvaluationContext,
  type RiskAssessment,
  type SuiteRunResult,
  type TestPlan,
} from '../domain/types.js';

const STRICT_POLICIES = new Set(['pull-request', 'delivery', 'release']);

export function evaluateQualityGate(params: {
  policy: GatePolicyName;
  policyContext: PolicyEvaluationContext;
  changeSet: ChangeSet;
  impact: ImpactResult;
  risk: RiskAssessment;
  plan: TestPlan;
  results: SuiteRunResult[];
  planOnly?: boolean;
}): GateDecision {
  const { policy, policyContext, changeSet, risk, plan, results, planOnly } = params;
  const gateCfg = policyContext.effective.config.gates?.[policy] ?? {};
  const blockOn = new Set(gateCfg.block_on ?? ['test_failure', 'invalid_config']);
  const reasons: GateReason[] = [];
  const requiredActions: string[] = [];
  const evidenceRefs: string[] = [];

  const isStrict = STRICT_POLICIES.has(policy);
  const hasRunnerErrors = results.some((r) => r.disposition === 'execution_failed');
  const failedSuites = results.filter((r) => r.status === 'failed');
  const blockedSuites =
    results.length > 0
      ? results.filter((r) => r.disposition === 'blocked')
      : plan.suites.filter((s) => s.disposition === 'blocked');
  const uncoveredModules = plan.requiredCoverage.filter((c) => !c.covered);

  // 1. Runner / tool execution errors
  if (hasRunnerErrors) {
    const errSuites = results.filter((r) => r.disposition === 'execution_failed');
    reasons.push({
      code: 'execution_error',
      severity: 'blocking',
      message: `Test runner encountered execution/timeout/spawn errors in: ${errSuites.map((s) => s.suiteId).join(', ')}`,
      evidenceRefs: errSuites.flatMap((s) => s.artifactRefs),
    });
    requiredActions.push('Inspect execution error logs with `aeg inspect failure` and fix environment or timeout.');
    evidenceRefs.push(...errSuites.flatMap((s) => s.artifactRefs));
  }

  // 2. Test failures
  if (failedSuites.length > 0) {
    reasons.push({
      code: 'test_failure',
      severity: 'blocking',
      message: `${failedSuites.length} required test suite(s) failed: ${failedSuites.map((s) => s.suiteId).join(', ')}`,
      evidenceRefs: failedSuites.flatMap((s) => s.artifactRefs),
    });
    requiredActions.push(
      `Fix failing test suite(s): ${failedSuites.map((s) => s.suiteId).join(', ')} (use \`aeg inspect failure\` for details).`,
    );
    evidenceRefs.push(...failedSuites.flatMap((s) => s.artifactRefs));
  }

  // 3. Policy relaxation attempts (Section 10.7 & 17.1)
  if (policyContext.relaxations.length > 0) {
    const blocking = isStrict || blockOn.has('policy_relaxation');
    reasons.push({
      code: 'policy_relaxation',
      severity: blocking ? 'blocking' : 'warning',
      message: `Candidate branch attempted ${policyContext.relaxations.length} quality policy relaxation(s): ${policyContext.relaxations.map((r) => r.target).join(', ')}`,
      evidenceRefs: policyContext.relaxations.map((r) => r.target),
    });
    requiredActions.push('Revert unauthorized policy relaxations or obtain authorized approval to update baseline PolicySnapshot.');
  }

  // 4. Clean worktree requirement (delivery / release)
  if (gateCfg.require_clean_worktree && changeSet.workingTreeDirty) {
    reasons.push({
      code: 'dirty_worktree',
      severity: 'blocking',
      message: `Policy '${policy}' requires a clean Git working tree, but uncommitted changes exist.`,
      evidenceRefs: ['git:working_tree'],
    });
    requiredActions.push('Commit or clean uncommitted working tree files before running delivery/release gate.');
  }

  // 5. Missing protected baseline in strict policies
  if (isStrict && policyContext.baselineStatus === 'unparseable') {
    reasons.push({
      code: 'baseline_unparseable',
      severity: 'blocking',
      message: 'Protected baseline PolicySnapshot is unreadable or invalid; cannot verify policy integrity.',
      evidenceRefs: ['policy:baseline'],
    });
    requiredActions.push('Repair .engineering-guard configuration on the protected baseline branch.');
  }

  // 6. Incomplete evidence: blocked suites, uncovered affected modules, blocking unknowns
  const incompleteSignals: string[] = [];
  if (blockedSuites.length > 0) {
    incompleteSignals.push(
      `Blocked suite(s) unable to execute on current host: ${blockedSuites.map((s) => s.suiteId).join(', ')}`,
    );
  }
  if (uncoveredModules.length > 0) {
    incompleteSignals.push(
      `Affected module(s) have zero test coverage declared: ${uncoveredModules.map((c) => c.moduleId).join(', ')}`,
    );
  }
  if (risk.blockingUnknowns.length > 0) {
    incompleteSignals.push(...risk.blockingUnknowns);
  }
  if (planOnly && plan.suites.some((s) => s.disposition === 'execute')) {
    incompleteSignals.push('Plan-only mode requested; required test suites have not yet been executed.');
  }

  if (incompleteSignals.length > 0) {
    const blocksOnIncomplete =
      isStrict ||
      blockOn.has('incomplete') ||
      (risk.level === 'L4' && blockOn.has('L4_unknown')) ||
      uncoveredModules.length > 0 ||
      blockedSuites.length > 0 ||
      risk.blockingUnknowns.length > 0;

    reasons.push({
      code: 'incomplete_evidence',
      severity: blocksOnIncomplete ? 'blocking' : 'warning',
      message: incompleteSignals.join(' | '),
      evidenceRefs: ['plan:unknowns'],
    });
    requiredActions.push(
      planOnly
        ? 'Execute the generated test plan with `aeg test --plan <plan-file>` or run `aeg check`.'
        : 'Resolve missing coverage, missing platform executors, or analysis unknowns before proceeding.',
    );
  }

  // 7. Manual approval requirement for L4 / protected / guard-config changes
  const needsApproval =
    risk.level === 'L4' ||
    risk.requiredChecks.includes('manual_review') ||
    policyContext.relaxations.length > 0;

  // Determine final outcome vs workflowAction (Section 9.7: keep them strictly separated!)
  let outcome: GateDecision['outcome'];
  let workflowAction: GateDecision['workflowAction'];

  if (hasRunnerErrors) {
    outcome = 'error';
    workflowAction = 'block';
  } else if (failedSuites.length > 0) {
    outcome = 'failed';
    workflowAction = 'block';
  } else if (
    reasons.some(
      (r) =>
        r.severity === 'blocking' &&
        (r.code === 'incomplete_evidence' || r.code === 'baseline_unparseable'),
    )
  ) {
    outcome = 'incomplete';
    workflowAction = 'block';
  } else if (reasons.some((r) => r.severity === 'blocking')) {
    outcome = 'failed';
    workflowAction = 'block';
  } else if (incompleteSignals.length > 0) {
    outcome = 'incomplete';
    workflowAction = 'require_approval';
  } else {
    outcome = 'passed';
    if (needsApproval) {
      workflowAction = 'require_approval';
      reasons.push({
        code: 'manual_approval_required',
        severity: 'warning',
        message: `All automated checks passed, but risk level ${risk.level} requires human review/approval.`,
        evidenceRefs: risk.factors.filter((f) => f.level === 'L4').map((f) => f.id),
      });
      requiredActions.push('Obtain human reviewer approval for high-risk (L4) or policy change.');
    } else {
      workflowAction = 'continue';
      reasons.push({
        code: 'gate_passed',
        severity: 'info',
        message: `Quality gate '${policy}' passed with risk ${risk.level}.`,
        evidenceRefs: [`plan:${plan.id}`],
      });
    }
  }

  return {
    outcome,
    workflowAction,
    policy,
    reasons,
    requiredActions: Array.from(new Set(requiredActions)),
    evidenceRefs: Array.from(new Set(evidenceRefs)),
  };
}

export function mapGateToExitCode(gate: GateDecision, results: SuiteRunResult[]): ExitCode {
  if (gate.outcome === 'error') {
    return EXIT_CODES.TOOL_OR_ENV_ERROR;
  }
  if (results.some((r) => r.status === 'failed')) {
    return EXIT_CODES.TEST_FAILED;
  }
  if (gate.outcome === 'incomplete') {
    return gate.workflowAction === 'block' ? EXIT_CODES.INCOMPLETE_BLOCKED : EXIT_CODES.OK;
  }
  if (gate.outcome === 'failed') {
    return EXIT_CODES.GATE_FAILED;
  }
  return EXIT_CODES.OK;
}
