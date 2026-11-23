export const AEG_VERSION = '0.0.1';
export const REPORT_SCHEMA_VERSION = 1;

export type Platform = 'windows' | 'linux' | 'macos';
export type AnalysisMode = 'fast' | 'balanced' | 'deep' | 'release';
export type GatePolicyName = 'local' | 'commit' | 'pull-request' | 'delivery' | 'release' | string;
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type OutputFormat = 'text' | 'json' | 'agent-summary' | 'sarif' | 'junit';

export const EXIT_CODES = {
  OK: 0,
  TEST_FAILED: 1,
  GATE_FAILED: 2,
  CONFIG_ERROR: 3,
  TOOL_OR_ENV_ERROR: 4,
  INCOMPLETE_BLOCKED: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const RISK_ORDER: Record<RiskLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

export function maxRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

// --- Configuration Types ---

export interface BudgetConfig {
  max_duration?: string;
  max_memory?: string;
}

export interface ProviderConfig {
  enabled?: boolean | 'auto';
  modes?: AnalysisMode[];
  detects?: string[];
  distribution?: 'builtin' | 'user-installed' | 'optional-package';
}

export interface GateRuleConfig {
  block_on?: string[];
  require_clean_worktree?: boolean;
  require_approval_on?: string[];
}

export interface AegConfig {
  schema_version: 1;
  project: {
    name: string;
    languages?: string[];
    baseline_ref?: string;
  };
  analysis?: {
    default_mode?: AnalysisMode;
    auto_escalate?: boolean;
    budgets?: Partial<Record<AnalysisMode, BudgetConfig>>;
    providers?: Record<string, ProviderConfig>;
    minimum_confidence?: number;
    doc_paths?: string[];
    ignore_paths?: string[];
  };
  risk?: {
    default_level?: RiskLevel;
    protected_modules?: string[];
    overrides?: Record<string, RiskLevel>;
  };
  cache?: {
    enabled?: boolean;
    backend?: 'local' | 'remote-dir' | 'remote-http';
    directory?: string;
    cross_platform?: boolean;
    exact_tree?: boolean;
    max_size_mb?: number;
    suite_fingerprint?: {
      mode?: 'disabled' | 'shadow' | 'enabled';
    };
    remote?: {
      url?: string;
      directory?: string;
      tenant_id?: string;
      read_only?: boolean;
      require_signature?: boolean;
      timeout?: string;
    };
  };
  shadow_tests?: {
    schedule?: string;
    sample_rate?: number;
    max_duration?: string;
    weekly_budget?: string;
  };
  agent_context?: {
    default_view?: 'agent-summary' | 'failure-details' | 'full-artifact';
    max_failure_excerpt_bytes?: number;
    max_auto_expansions?: number;
  };
  gates?: Record<string, GateRuleConfig>;
  architecture?: {
    enabled?: boolean;
    max_file_lines?: number;
    max_exports_per_file?: number;
    forbid_undeclared_imports?: boolean;
    forbid_cycles?: boolean;
    rules?: {
      frontend_antipatterns?: boolean;
      backend_antipatterns?: boolean;
    };
    handbook_refs?: string[];
  };
}

export interface ModuleDef {
  paths: string[];
  depends_on?: string[];
  criticality?: 'low' | 'normal' | 'high' | 'critical';
  public_api_paths?: string[];
  contracts?: string[];
  data_models?: string[];
  owner?: string;
}

export interface ModulesConfig {
  schema_version?: 1;
  modules: Record<string, ModuleDef>;
}

export interface StructuredCommand {
  executable: string;
  args?: string[];
  cwd?: string;
  timeout?: string;
  shell?: boolean;
  environment_allowlist?: string[];
}

export interface SuiteCacheConfig {
  enabled?: boolean;
  cross_commit?: 'disabled' | 'shadow' | 'enabled';
  hermetic?: boolean;
  inputs?: string[];
}

export type TestFramework =
  | 'vitest'
  | 'jest'
  | 'pytest'
  | 'playwright'
  | 'node-test'
  | 'go-test'
  | 'cargo-test'
  | 'command';

export type TestLevel = 'static' | 'unit' | 'integration' | 'e2e' | 'security' | 'full';

export interface TestSuiteDef {
  framework: TestFramework;
  command: StructuredCommand;
  covers: string[];
  level: TestLevel;
  critical?: boolean;
  depends_on?: string[];
  execution_variant?: string;
  estimated_duration?: string;
  cache?: boolean | SuiteCacheConfig;
  platforms?: Platform[];
  execution?: 'once_per_change' | 'each_platform';
  portable?: boolean;
  canonical_platform?: Platform;
  capabilities?: string[];
}

export interface RegressionDef {
  id: string;
  suite: string;
  description?: string;
  trigger_paths: string[];
}

export interface TestsConfig {
  schema_version?: 1;
  suites: Record<string, TestSuiteDef>;
  regressions?: RegressionDef[];
}

export interface ProjectConfigBundle {
  config: AegConfig;
  modules: ModulesConfig;
  tests: TestsConfig;
  configDigest: string;
  policyDigest: string;
  source: 'working_tree' | 'protected_baseline';
  sourceRef?: string;
}

export interface PolicyDifference {
  kind: 'relaxation' | 'tightening' | 'modification';
  category:
    | 'suite_deleted'
    | 'suite_command_changed'
    | 'suite_covers_reduced'
    | 'protected_module_removed'
    | 'regression_removed'
    | 'risk_override_lowered'
    | 'cache_expanded'
    | 'gate_rule_relaxed'
    | 'module_removed'
    | 'config_tightened'
    | 'other';
  target: string;
  reason: string;
  baselineValue?: unknown;
  candidateValue?: unknown;
}

export interface PolicyEvaluationContext {
  baseline?: ProjectConfigBundle;
  candidate: ProjectConfigBundle;
  effective: ProjectConfigBundle;
  baselineStatus: 'verified' | 'missing' | 'unparseable' | 'same_as_candidate';
  differences: PolicyDifference[];
  relaxations: PolicyDifference[];
  warnings: string[];
}

// --- Core Domain Models (Section 7 & 9) ---

export interface EvidenceEnvelope<T> {
  providerId: string;
  providerVersion: string;
  capability: string;
  subjectDigest: string;
  confidence: number;
  cost: { durationMs: number; peakMemoryMb?: number };
  freshness: string;
  data: T;
  warnings: string[];
}

export type EvidenceCategory =
  | 'module_graph'
  | 'build_graph'
  | 'import_relation'
  | 'symbol_graph'
  | 'coverage_map'
  | 'contract_db';

export interface ImpactProviderInput {
  workspaceRoot: string;
  changeSet: ChangeSet;
  config: AegConfig;
  modules: ModulesConfig;
  mode: AnalysisMode;
}

export interface ImpactProviderOutput {
  directlyChangedModules: string[];
  transitivelyAffectedModules: string[];
  affectedSymbols: SymbolRef[];
  affectedContracts: string[];
  affectedDataModels: string[];
  unclassifiedFiles: string[];
  evidence: ImpactEvidence[];
  unknowns: string[];
}

export interface ImpactProvider {
  readonly id: string;
  readonly version: string;
  readonly category: EvidenceCategory;
  readonly supportedModes: AnalysisMode[];
  readonly estimatedCostMs: number;
  readonly priority: number;
  isAvailable(input: ImpactProviderInput): boolean;
  analyze(input: ImpactProviderInput): Promise<EvidenceEnvelope<ImpactProviderOutput>>;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header?: string;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author?: string;
  date?: string;
}

export interface SubmoduleChange {
  path: string;
  previousCommit?: string;
  currentCommit?: string;
}

export type FileCategory =
  | 'docs'
  | 'code'
  | 'test'
  | 'config'
  | 'lockfile'
  | 'db_migration'
  | 'security_auth'
  | 'release_signing'
  | 'ci'
  | 'guard_config'
  | 'generated'
  | 'binary'
  | 'unknown';

export interface ChangedFile {
  path: string;
  previousPath?: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary?: boolean;
  large?: boolean;
  categories?: FileCategory[];
}

export interface ChangeSet {
  repositoryId: string;
  baseRevision: string;
  headRevision: string;
  scope: 'revision_range' | 'staged' | 'working_tree' | 'combined';
  repositoryTreeHash: string;
  files: ChangedFile[];
  commits: CommitInfo[];
  workingTreeDirty: boolean;
  untrackedFiles: string[];
  submoduleChanges: SubmoduleChange[];
  analysisWarnings: string[];
}

export interface SymbolRef {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'export' | 'symbol';
  file: string;
  line?: number;
}

export interface ImpactEvidence {
  id: string;
  providerId: string;
  kind:
    | 'file_to_module'
    | 'module_dependency'
    | 'import_relation'
    | 'public_api'
    | 'contract'
    | 'data_model'
    | 'regression'
    | 'fallback';
  source: string;
  target: string;
  reason: string;
  confidence: number;
}

export interface ImpactResult {
  directlyChangedModules: string[];
  transitivelyAffectedModules: string[];
  affectedSymbols: SymbolRef[];
  affectedContracts: string[];
  affectedDataModels: string[];
  unclassifiedFiles: string[];
  confidence: number;
  evidence: ImpactEvidence[];
  envelopes: EvidenceEnvelope<unknown>[];
  unknowns: string[];
  escalatedMode?: AnalysisMode;
}

export interface RiskFactor {
  id: string;
  level: RiskLevel;
  category: string;
  reason: string;
  evidenceRefs: string[];
  nonOverridable?: boolean;
}

export interface RiskAssessment {
  level: RiskLevel;
  factors: RiskFactor[];
  requiredChecks: string[];
  blockingUnknowns: string[];
}

export type SuiteDisposition =
  | 'execute'
  | 'reuse_cache'
  | 'not_required'
  | 'blocked'
  | 'execution_failed';

export interface CacheDecision {
  mode: 'exact_tree' | 'suite_fingerprint' | 'disabled';
  decision: 'hit' | 'miss' | 'shadow_candidate' | 'rejected';
  fingerprint: string;
  reasons: string[];
  evidenceRefs: string[];
}

export interface PlannedTestSuite {
  suiteId: string;
  executionVariant: string;
  disposition: SuiteDisposition;
  coveredModules: string[];
  selectionReasons: string[];
  evidenceRefs: string[];
  dependencySuiteIds: string[];
  matchedRegressions: string[];
  requiredPlatforms: Platform[];
  requiredCapabilities: string[];
  level: TestLevel;
  cacheDecision?: CacheDecision;
}

export interface CacheCandidate {
  suiteId: string;
  fingerprint: string;
  mode: 'exact_tree' | 'suite_fingerprint';
  eligible: boolean;
  reason: string;
}

export interface ExcludedTestSuite {
  suiteId: string;
  disposition: 'not_required';
  reasons: string[];
  evidenceRefs: string[];
}

export interface CoverageRequirement {
  moduleId: string;
  covered: boolean;
  suiteIds: string[];
}

export interface PlatformRequirement {
  platform: Platform;
  suiteIds: string[];
  mode: 'once_per_change' | 'each_platform';
}

export interface DedupStats {
  candidatesBeforeDedup: number;
  suitesAfterDedup: number;
  savedExecutions: number;
}

export interface TestPlan {
  id: string;
  planDigest: string;
  repositoryTreeHash: string;
  configDigest: string;
  policyDigest: string;
  createdAt: string;
  expiresAt?: string;
  suites: PlannedTestSuite[];
  cacheCandidates: CacheCandidate[];
  excludedSuites: ExcludedTestSuite[];
  requiredCoverage: CoverageRequirement[];
  requiredPlatforms: PlatformRequirement[];
  requiredCapabilities: string[];
  dedupStats: DedupStats;
  fallbackActions: string[];
  rationale: string[];
  unknowns: string[];
}

export interface ExecutionEnvironment {
  deviceId: string;
  platform: Platform;
  osVersion: string;
  architecture: string;
  aegVersion: string;
  runtimeVersions: Record<string, string>;
  toolchainDigest: string;
  projectRevision: string;
  repositoryTreeHash: string;
  worktreeClean: boolean;
}

export interface FailureDetail {
  id: string;
  suiteId: string;
  category: 'assertion' | 'runtime_error' | 'timeout' | 'spawn_error' | 'non_zero_exit' | 'cancelled';
  message: string;
  location?: string;
  excerpt: string;
  artifactRef: string;
}

export interface SuiteRunResult {
  suiteId: string;
  executionVariant: string;
  disposition: SuiteDisposition;
  status: 'passed' | 'failed' | 'error' | 'timeout' | 'cancelled' | 'skipped';
  cached: boolean;
  durationMs: number;
  exitCode?: number;
  startedAt: string;
  finishedAt: string;
  outputDigest: string;
  artifactRefs: string[];
  failureDetails: FailureDetail[];
  receipt?: TestResultReceipt;
}

export interface TestResultReceipt {
  receiptId: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  suiteId: string;
  planDigest: string;
  configDigest: string;
  policyDigest: string;
  repositoryTreeHash: string;
  environment: ExecutionEnvironment;
  status: 'passed' | 'failed' | 'error' | 'timeout' | 'cancelled' | 'skipped';
  startedAt: string;
  finishedAt: string;
  outputDigest: string;
  artifactRefs: string[];
  signature?: string;
}

export interface GateReason {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  evidenceRefs: string[];
}

export interface GateDecision {
  outcome: 'passed' | 'failed' | 'incomplete' | 'error';
  workflowAction: 'continue' | 'require_approval' | 'block';
  policy: string;
  reasons: GateReason[];
  requiredActions: string[];
  evidenceRefs: string[];
}

export interface ArchitectureFinding {
  ruleId: string;
  severity: 'info' | 'warning' | 'error';
  category: 'boundary' | 'bloat' | 'frontend' | 'backend' | 'maintainability';
  file: string;
  line?: number;
  message: string;
  betterApproach: string;
}

export interface ArchitectureAuditResult {
  scope: 'incremental' | 'full';
  scannedFiles: number;
  findings: ArchitectureFinding[];
  externalToolsDetected: string[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  handbookRefs: string[];
}

export interface AgentSummary {
  run_id: string;
  outcome: GateDecision['outcome'];
  workflow_action: GateDecision['workflowAction'];
  mode: AnalysisMode;
  policy: string;
  changed_modules: string[];
  affected_modules: string[];
  risk: {
    level: RiskLevel;
    reasons: string[];
  };
  tests: {
    executed: number;
    cached: number;
    not_required: number;
    blocked: number;
    failed: number;
    execution_failed: number;
    dedup_saved: number;
  };
  regressions: {
    matched: number;
    passed: number;
  };
  unknowns: string[];
  policy_relaxations: string[];
  architecture_hints?: ArchitectureFinding[];
  failures: Array<{
    id: string;
    suite_id: string;
    category: FailureDetail['category'];
    message: string;
    location?: string;
    excerpt: string;
    artifact_ref: string;
  }>;
  agent_action: {
    required: boolean;
    next_steps: string[];
  };
  artifact_refs: string[];
}

export interface QualityReport {
  schemaVersion: 1;
  runId: string;
  aegVersion: string;
  createdAt: string;
  mode: AnalysisMode;
  requestedMode: AnalysisMode;
  policy: string;
  timings: {
    totalMs: number;
    diffMs: number;
    impactMs: number;
    riskMs: number;
    planMs: number;
    runMs: number;
    gateMs: number;
  };
  environment: ExecutionEnvironment;
  policyContext: {
    baselineStatus: PolicyEvaluationContext['baselineStatus'];
    baselineRef?: string;
    configDigest: string;
    policyDigest: string;
    differences: PolicyDifference[];
    relaxations: PolicyDifference[];
    warnings: string[];
  };
  changeSet: ChangeSet;
  impact: ImpactResult;
  risk: RiskAssessment;
  plan: TestPlan;
  results: SuiteRunResult[];
  architectureAudit?: ArchitectureAuditResult;
  gate: GateDecision;
  agentSummary: AgentSummary;
}
