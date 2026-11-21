import {
  maxRiskLevel,
  type AegConfig,
  type ChangeSet,
  type ImpactResult,
  type ModulesConfig,
  type PolicyEvaluationContext,
  type RiskAssessment,
  type RiskFactor,
  type RiskLevel,
} from '../domain/types.js';

export function assessRisk(params: {
  changeSet: ChangeSet;
  impact: ImpactResult;
  config: AegConfig;
  modules: ModulesConfig;
  policyContext: PolicyEvaluationContext;
}): RiskAssessment {
  const { changeSet, impact, config, modules, policyContext } = params;
  const factors: RiskFactor[] = [];
  const requiredChecks = new Set<string>();
  const blockingUnknowns: string[] = [];

  let level: RiskLevel = 'L0';
  const addFactor = (factor: RiskFactor, checks: string[] = []) => {
    factors.push(factor);
    level = maxRiskLevel(level, factor.level);
    for (const c of checks) requiredChecks.add(c);
  };

  const overrideLevel = (key: string, fallback: RiskLevel): RiskLevel => {
    return config.risk?.overrides?.[key] ?? fallback;
  };

  // No changes at all
  if (changeSet.files.length === 0 && changeSet.submoduleChanges.length === 0) {
    addFactor(
      {
        id: 'no-changes',
        level: 'L0',
        category: 'no_changes',
        reason: 'No changed files detected in the selected scope.',
        evidenceRefs: [],
      },
      ['static'],
    );
  }

  const allFiles = changeSet.files;
  const onlyDocs =
    allFiles.length > 0 &&
    allFiles.every((f) => (f.categories ?? []).length === 1 && f.categories![0] === 'docs') &&
    impact.unknowns.length === 0 &&
    policyContext.relaxations.length === 0;

  if (onlyDocs) {
    addFactor(
      {
        id: 'docs-only',
        level: 'L0',
        category: 'docs_only',
        reason: 'Only trusted documentation files were modified.',
        evidenceRefs: allFiles.map((f) => f.path),
      },
      ['static'],
    );
  }

  // Non-overridable high-sensitivity changes (L4)
  const dbFiles = allFiles.filter((f) => (f.categories ?? []).includes('db_migration'));
  if (dbFiles.length > 0) {
    addFactor(
      {
        id: 'db-migration',
        level: maxRiskLevel('L4', overrideLevel('database_migration', 'L4')),
        category: 'database_migration',
        reason: `Database schema or migration files changed: ${dbFiles.map((f) => f.path).join(', ')}`,
        evidenceRefs: dbFiles.map((f) => f.path),
        nonOverridable: true,
      },
      ['unit', 'integration', 'e2e', 'security', 'manual_review'],
    );
  }

  const secFiles = allFiles.filter((f) => (f.categories ?? []).includes('security_auth'));
  if (secFiles.length > 0) {
    addFactor(
      {
        id: 'security-auth',
        level: 'L4',
        category: 'security_auth',
        reason: `Authentication, permission, or secret-related files changed: ${secFiles.map((f) => f.path).join(', ')}`,
        evidenceRefs: secFiles.map((f) => f.path),
        nonOverridable: true,
      },
      ['unit', 'integration', 'security', 'manual_review'],
    );
  }

  const relFiles = allFiles.filter(
    (f) => (f.categories ?? []).includes('release_signing') || (f.categories ?? []).includes('ci'),
  );
  if (relFiles.length > 0) {
    addFactor(
      {
        id: 'release-or-ci',
        level: 'L4',
        category: 'release_signing',
        reason: `CI or release/signing files changed: ${relFiles.map((f) => f.path).join(', ')}`,
        evidenceRefs: relFiles.map((f) => f.path),
        nonOverridable: true,
      },
      ['unit', 'integration', 'manual_review'],
    );
  }

  // Policy / .engineering-guard config changes (Section 10.7 & 17.1)
  const guardFiles = allFiles.filter((f) => (f.categories ?? []).includes('guard_config'));
  if (guardFiles.length > 0 || policyContext.relaxations.length > 0) {
    const isRelaxed = policyContext.relaxations.length > 0;
    addFactor(
      {
        id: isRelaxed ? 'policy-relaxation' : 'guard-config-change',
        level: isRelaxed ? 'L4' : 'L3',
        category: isRelaxed ? 'candidate_policy_relaxation' : 'guard_config_change',
        reason: isRelaxed
          ? `Candidate configuration attempted ${policyContext.relaxations.length} policy relaxation(s): ${policyContext.relaxations.map((r) => r.target).join(', ')}`
          : `Quality configuration (.engineering-guard) modified: ${guardFiles.map((f) => f.path).join(', ')}`,
        evidenceRefs: guardFiles.map((f) => f.path),
        nonOverridable: true,
      },
      ['unit', 'integration', 'manual_review'],
    );
  }

  // Protected or critical modules
  const protectedSet = new Set(config.risk?.protected_modules ?? []);
  const touchedModules = [
    ...impact.directlyChangedModules,
    ...impact.transitivelyAffectedModules,
  ];
  const hitProtected = touchedModules.filter(
    (m) => protectedSet.has(m) || modules.modules[m]?.criticality === 'critical',
  );
  if (hitProtected.length > 0) {
    addFactor(
      {
        id: 'protected-module',
        level: 'L4',
        category: 'protected_module',
        reason: `Protected or critical module(s) impacted: ${hitProtected.join(', ')}`,
        evidenceRefs: hitProtected,
        nonOverridable: true,
      },
      ['unit', 'integration', 'e2e', 'manual_review'],
    );
  }

  // Public API / Contract changes -> L3
  if (impact.affectedContracts.length > 0) {
    addFactor(
      {
        id: 'public-api-change',
        level: maxRiskLevel('L3', overrideLevel('public_api_change', 'L3')),
        category: 'public_api_change',
        reason: `Public interface or contract affected: ${impact.affectedContracts.join(', ')}`,
        evidenceRefs: impact.affectedContracts,
      },
      ['unit', 'integration', 'e2e'],
    );
  }

  // Cross-module / multiple downstream modules -> L3
  if (impact.transitivelyAffectedModules.length >= 2) {
    addFactor(
      {
        id: 'multi-downstream',
        level: 'L3',
        category: 'cross_module',
        reason: `Multiple downstream modules affected (${impact.transitivelyAffectedModules.join(', ')})`,
        evidenceRefs: impact.transitivelyAffectedModules,
      },
      ['unit', 'integration', 'e2e'],
    );
  } else if (impact.transitivelyAffectedModules.length === 1 || impact.directlyChangedModules.length > 1) {
    addFactor(
      {
        id: 'multi-module',
        level: 'L2',
        category: 'multi_module',
        reason: `Changes span multiple modules (${touchedModules.join(', ')})`,
        evidenceRefs: touchedModules,
      },
      ['unit', 'integration'],
    );
  } else if (impact.directlyChangedModules.length === 1 && !onlyDocs) {
    const mod = impact.directlyChangedModules[0]!;
    const crit = modules.modules[mod]?.criticality ?? 'normal';
    if (crit === 'high') {
      addFactor(
        {
          id: 'high-criticality-module',
          level: 'L2',
          category: 'high_criticality_module',
          reason: `High-criticality module '${mod}' modified.`,
          evidenceRefs: [mod],
        },
        ['unit', 'integration'],
      );
    } else {
      addFactor(
        {
          id: 'local-module-change',
          level: 'L1',
          category: 'local_change',
          reason: `Localized change inside single module '${mod}'.`,
          evidenceRefs: [mod],
        },
        ['unit'],
      );
    }
  }

  // Lockfile or build config changes
  const lockOrConfig = allFiles.filter(
    (f) => (f.categories ?? []).includes('lockfile') || (f.categories ?? []).includes('config'),
  );
  if (lockOrConfig.length > 0) {
    addFactor(
      {
        id: 'dependency-or-build-config',
        level: 'L3',
        category: 'dependency_or_build_config',
        reason: `Dependency lockfile or build configuration changed: ${lockOrConfig.map((f) => f.path).join(', ')}`,
        evidenceRefs: lockOrConfig.map((f) => f.path),
      },
      ['unit', 'integration'],
    );
  }

  // Missing tests for runtime code changes (informational / L2 bump for larger code edits)
  const hasCodeChanges = allFiles.some((f) => (f.categories ?? []).includes('code'));
  const hasTestChanges = allFiles.some((f) => (f.categories ?? []).includes('test'));
  const totalCodeLines = allFiles
    .filter((f) => (f.categories ?? []).includes('code'))
    .reduce((acc, f) => acc + f.additions + f.deletions, 0);
  if (hasCodeChanges && !hasTestChanges && totalCodeLines >= 30) {
    addFactor(
      {
        id: 'missing-new-tests',
        level: 'L2',
        category: 'missing_tests',
        reason: `Runtime code modified (${totalCodeLines} lines) without accompanying test updates.`,
        evidenceRefs: allFiles.filter((f) => (f.categories ?? []).includes('code')).map((f) => f.path),
      },
      ['unit', 'integration'],
    );
  }

  // Unknowns / low confidence -> blockingUnknowns & risk elevation (Section 5.4, 5.9, 10.3)
  const minConf = config.analysis?.minimum_confidence ?? 0.75;
  if (impact.confidence < minConf) {
    const msg = `Impact analysis confidence (${impact.confidence}) is below minimum threshold (${minConf}).`;
    blockingUnknowns.push(msg);
    addFactor(
      {
        id: 'low-confidence',
        level: 'L3',
        category: 'low_confidence',
        reason: msg,
        evidenceRefs: [],
      },
      ['unit', 'integration'],
    );
  }

  for (const u of impact.unknowns) {
    if (
      u.includes('failed') ||
      u.includes('Cyclic') ||
      u.includes('Submodule') ||
      u.includes('No impact analysis provider')
    ) {
      blockingUnknowns.push(u);
    }
  }

  if (impact.unclassifiedFiles.length > 0) {
    addFactor(
      {
        id: 'unclassified-files',
        level: maxRiskLevel('L2', config.risk?.default_level ?? 'L2'),
        category: 'unclassified_files',
        reason: `Unclassified files changed (fallback verification required): ${impact.unclassifiedFiles.join(', ')}`,
        evidenceRefs: impact.unclassifiedFiles,
      },
      ['unit', 'integration'],
    );
  }

  if (allFiles.length > 0 && factors.length === 0) {
    addFactor(
      {
        id: 'default-risk',
        level: config.risk?.default_level ?? 'L2',
        category: 'default',
        reason: 'Applied project default risk level.',
        evidenceRefs: allFiles.map((f) => f.path),
      },
      ['unit'],
    );
  }

  return {
    level,
    factors,
    requiredChecks: Array.from(requiredChecks),
    blockingUnknowns: Array.from(new Set(blockingUnknowns)),
  };
}
