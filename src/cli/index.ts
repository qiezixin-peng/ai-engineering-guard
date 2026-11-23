import { AEG_VERSION, EXIT_CODES, type AnalysisMode, type ChangeSet, type OutputFormat } from '../domain/types.js';

const HELP_TEXT = `AI Engineering Guard (aeg v${AEG_VERSION})
Lightweight, high-capability adaptive engineering quality engine for developers, CI, Durable Pi, and all AI Agents (DeepSeek, Gemini, Codex, Claude).

Usage:
  aeg <command> [options]

Primary Commands:
  init                      Initialize .engineering-guard/ configuration in the repository
  check                     Run full pipeline: analyze -> impact -> risk -> plan -> test -> gate
  config validate           Validate .engineering-guard/{config,modules,tests}.yaml against JSON Schema
  config migrate            Safely upgrade .engineering-guard/*.yaml to latest schema version
  explain risk              Explain deterministic risk level and contributing factors
  explain test <suite-id>   Explain why a suite was selected, cached, blocked, or excluded

Pipeline & Inspection Commands:
  baseline                  Inspect protected baseline PolicySnapshot and candidate config diff
  analyze                   Run diff, impact, and risk analysis without executing tests
  plan-tests                Generate and print the deduplicated, cache-aware test plan
  test --plan <path>        Execute a previously generated test plan file
  gate                      Run check and enforce a named quality gate policy
  aggregate                 Aggregate multi-platform TestResultReceipts into a final Coordinator gate
  shadow-check              Run budget-controlled shadow full-run validation to measure selection recall
  audit                     Run architecture fitness & anti-spaghetti audit across the repository
  dashboard                 Generate multi-project quality observability summary (JSON or offline HTML)
  agents config             Print ready-to-use configs for Codex (TOML), Gemini, DeepSeek, and Claude
  agents install            Idempotently inject AEG instructions into repo AGENTS.md / GEMINI.md / CLAUDE.md
  agents sync-all           Sync latest AEG instructions across all integrated projects on this machine
  mcp                       Start stdio MCP Server (JSON-RPC 2.0, dual-framing, model-agnostic)
  inspect failure [id]      Show structured failure details from the latest (or --run) run
  inspect log <id>          Read a bounded, secret-redacted log excerpt for a failure artifact

Common Options:
  --mode <mode>             Analysis mode: fast | balanced (default) | deep | release
  --policy <policy>         Gate policy: local | commit | pull-request | delivery | release
  --base <ref>              Base Git revision (e.g. origin/main, HEAD~1)
  --scope <scope>           Diff scope: combined (default) | revision_range | staged | working_tree
  --format <fmt>            Output format: text | json | agent-summary | sarif | junit
  --sarif <path>            Write SARIF 2.1.0 report to file on demand
  --junit <path>            Write JUnit XML report to file on demand
  --plan-only               Run analysis and planning without executing tests
  --plan <path>             Path to test plan JSON (for 'aeg test' / 'aeg aggregate')
  --receipts <path>         Path to receipt JSON file or directory (for 'aeg aggregate')
  --secret <key>            Optional HMAC-SHA256 signing secret (for 'aeg aggregate')
  --no-cache                Bypass exact Git Tree local cache
  --cwd <dir>               Target repository directory (defaults to current directory)
  --force                   Overwrite existing config on 'aeg init'
  --strict                  Fail with exit code 2 when 'aeg audit' finds error-level architecture issues
  -v, --version             Print AEG version
  -h, --help                Show this help

Stable Exit Codes:
  0  Success / Gate passed
  1  Test failure
  2  Quality gate rejected (e.g. policy relaxation, dirty worktree)
  3  Configuration / schema validation error
  4  Tool, adapter, or runner execution error
  5  Incomplete evidence (blocked platform, missing coverage, blocking unknowns)
`;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const booleanFlags = new Set([
    'help',
    'h',
    'version',
    'v',
    'plan-only',
    'no-cache',
    'force',
    'dry-run',
    'strict',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        if (booleanFlags.has(key)) {
          flags[key] = true;
        } else {
          const next = argv[i + 1];
          if (next && !next.startsWith('-')) {
            flags[key] = next;
            i++;
          } else {
            flags[key] = true;
          }
        }
      }
    } else if (token.startsWith('-') && token.length === 2) {
      const key = token.slice(1);
      flags[key] = true;
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === 'string' ? val : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgv(argv);

  // Fast-path --help / --version BEFORE dynamically importing heavy modules (cold start budget <= 300ms)
  if (flags.v || flags.version) {
    process.stdout.write(`${AEG_VERSION}\n`);
    return EXIT_CODES.OK;
  }

  if (flags.h || flags.help || positionals.length === 0) {
    process.stdout.write(HELP_TEXT);
    return EXIT_CODES.OK;
  }

  const command = positionals[0]!;
  const subcommand = positionals[1];
  const cwd = getStringFlag(flags, 'cwd') ?? process.cwd();
  const format = (getStringFlag(flags, 'format') ?? 'text') as OutputFormat;
  const mode = getStringFlag(flags, 'mode') as AnalysisMode | undefined;
  const policy = getStringFlag(flags, 'policy');
  const base = getStringFlag(flags, 'base') ?? getStringFlag(flags, 'from');
  const scope = getStringFlag(flags, 'scope') as ChangeSet['scope'] | undefined;
  const disableCache = flags['no-cache'] === true;
  const sarifOut = getStringFlag(flags, 'sarif');
  const junitOut = getStringFlag(flags, 'junit');

  try {
    if (command === 'mcp') {
      const { startStdioMcpServer } = await import('../mcp/server.js');
      startStdioMcpServer();
      return EXIT_CODES.OK;
    }

    if (command === 'aggregate') {
      const fsMod = await import('node:fs');
      const pathMod = await import('node:path');
      const { CoordinatorReceiptAggregator, loadReceiptsFromPath } = await import(
        '../aggregate/aggregator.js'
      );
      const { loadWorkingTreeConfig } = await import('../config/loader.js');

      const planArg = getStringFlag(flags, 'plan') ?? '.aeg/plans/current.json';
      const receiptsArg = getStringFlag(flags, 'receipts');
      if (!receiptsArg) {
        process.stderr.write("Missing --receipts <file-or-dir>. Usage: aeg aggregate --plan <plan.json> --receipts <path>\n");
        return EXIT_CODES.CONFIG_ERROR;
      }

      const absPlan = pathMod.resolve(cwd, planArg);
      if (!fsMod.existsSync(absPlan)) {
        process.stderr.write(`Plan file not found: ${absPlan}\n`);
        return EXIT_CODES.CONFIG_ERROR;
      }

      const plan = JSON.parse(fsMod.readFileSync(absPlan, 'utf8'));
      let tests;
      try {
        tests = loadWorkingTreeConfig(cwd).tests;
      } catch {
        tests = undefined;
      }

      const aggregator = new CoordinatorReceiptAggregator({
        plan,
        tests,
        policy: policy ?? 'delivery',
        signingSecret: getStringFlag(flags, 'secret'),
      });

      const receipts = loadReceiptsFromPath(pathMod.resolve(cwd, receiptsArg));
      for (const rcpt of receipts) {
        aggregator.register(rcpt);
      }

      const aggregated = aggregator.aggregate();
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(aggregated, null, 2)}\n`);
      } else {
        process.stdout.write(
          `AEG Cross-Platform Aggregate (${aggregated.planId}) — Outcome: ${aggregated.gate.outcome.toUpperCase()} | Action: ${aggregated.gate.workflowAction}\n`,
        );
        process.stdout.write(
          `Accepted receipts: ${aggregated.acceptedReceipts.length} | Rejected: ${aggregated.rejectedReceipts.length} | Missing slots: ${aggregated.missingSlots.length}\n`,
        );
        for (const r of aggregated.gate.reasons) {
          process.stdout.write(`  [${r.severity}] ${r.message}\n`);
        }
      }
      return aggregated.exitCode;
    }

    if (command === 'audit') {
      const { runArchitectureAudit } = await import('../audit/architecture-audit.js');
      const { loadWorkingTreeConfig, resolveWorkspaceRoot } = await import('../config/loader.js');
      const root = resolveWorkspaceRoot(cwd);
      const bundle = loadWorkingTreeConfig(root);
      const auditRes = runArchitectureAudit({
        workspaceRoot: root,
        config: bundle.config,
        modules: bundle.modules,
        scope: 'full',
      });
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(auditRes, null, 2)}\n`);
      } else {
        process.stdout.write(
          `AEG Architecture Audit (${auditRes.scannedFiles} file(s) scanned) — errors=${auditRes.summary.errors}, warnings=${auditRes.summary.warnings}, info=${auditRes.summary.info}\n`,
        );
        if (auditRes.externalToolsDetected.length > 0) {
          process.stdout.write(`  External tools detected: ${auditRes.externalToolsDetected.join(', ')}\n`);
        }
        for (const f of auditRes.findings) {
          process.stdout.write(`  [${f.severity}/${f.ruleId}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}\n`);
          process.stdout.write(`    -> Better approach: ${f.betterApproach}\n`);
        }
      }
      if (flags.strict === true && auditRes.summary.errors > 0) {
        return EXIT_CODES.GATE_FAILED;
      }
      return EXIT_CODES.OK;
    }

    if (command === 'shadow-check') {
      const { runBudgetedShadowCheck } = await import('../shadow/shadow-runner.js');
      const res = await runBudgetedShadowCheck({
        workspaceRoot: cwd,
        base,
        forceRun: flags.force === true,
      });
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        process.stdout.write(
          `AEG Shadow Verification (${res.weekKey}) — Status: ${res.status}\n  ${res.note}\n  Recall: ${res.recall ?? 'n/a'} | Missed failures: ${res.missedFailures.length} | Budget remaining: ${Math.round(res.budgetRemainingMs / 1000)}s\n`,
        );
      }
      return res.missedFailures.length > 0 ? EXIT_CODES.GATE_FAILED : EXIT_CODES.OK;
    }

    if (command === 'dashboard') {
      const fsMod = await import('node:fs');
      const pathMod = await import('node:path');
      const { collectMultiProjectDashboard, renderDashboardHtml } = await import(
        '../dashboard/dashboard.js'
      );
      const projectsArg = getStringFlag(flags, 'projects');
      const projectPaths = projectsArg
        ? projectsArg.split(',').map((s) => s.trim()).filter(Boolean)
        : [cwd];
      const data = collectMultiProjectDashboard(projectPaths);
      const outPath = getStringFlag(flags, 'out');
      if (outPath) {
        const absOut = pathMod.resolve(cwd, outPath);
        fsMod.mkdirSync(pathMod.dirname(absOut), { recursive: true });
        fsMod.writeFileSync(absOut, renderDashboardHtml(data), 'utf8');
      }
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      } else {
        process.stdout.write(
          `AEG Multi-Project Dashboard — ${data.projectCount} project(s), ${data.totals.totalRuns} total run(s), passRate=${(data.totals.overallPassRate * 100).toFixed(1)}%, cacheHit=${(data.totals.overallCacheHitRate * 100).toFixed(1)}%, dedupSaved=${data.totals.totalDedupSaved}, avgAgentSummary=${data.totals.avgAgentSummaryBytes}B\n`,
        );
        if (outPath) {
          process.stdout.write(`HTML dashboard written to: ${pathMod.resolve(cwd, outPath)}\n`);
        }
      }
      return EXIT_CODES.OK;
    }

    if (command === 'config' && subcommand === 'migrate') {
      const { migrateProjectConfig } = await import('../config/migrator.js');
      const res = migrateProjectConfig({
        workspaceRoot: cwd,
        dryRun: flags['dry-run'] === true,
      });
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Config Migration (v${res.fromVersion} -> v${res.toVersion}, dryRun=${res.dryRun}): ${res.migrated ? `${res.changes.length} change(s)` : 'already up to date'}\n`,
        );
        for (const c of res.changes) process.stdout.write(`  - ${c}\n`);
      }
      return EXIT_CODES.OK;
    }

    if (command === 'agents') {
      const {
        formatAgentConfigText,
        generateAgentConfigBundle,
        installRepoAgentInstructions,
        registerIntegratedProject,
        syncAllRegisteredProjects,
      } = await import('./agents.js');
      if (subcommand === 'install') {
        const res = installRepoAgentInstructions({ workspaceRoot: cwd });
        registerIntegratedProject(cwd);
        if (format === 'json' || format === 'agent-summary') {
          process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          process.stdout.write(`Installed AEG instructions in ${res.workspaceRoot}:\n`);
          for (const f of res.updatedFiles) process.stdout.write(`  [updated]   ${f}\n`);
          for (const f of res.unchangedFiles) process.stdout.write(`  [unchanged] ${f}\n`);
        }
        return EXIT_CODES.OK;
      }

      if (subcommand === 'sync-all') {
        const res = syncAllRegisteredProjects();
        if (format === 'json' || format === 'agent-summary') {
          process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          process.stdout.write(
            `Synced ${res.updatedProjects.length} of ${res.totalProjects} registered project(s).\n`,
          );
          for (const p of res.updatedProjects) {
            process.stdout.write(`  [updated] ${p.path} (${p.updatedFiles.length} file(s))\n`);
          }
        }
        return EXIT_CODES.OK;
      }

      const target = (getStringFlag(flags, 'agent') ?? 'all') as
        | 'codex'
        | 'gemini'
        | 'deepseek'
        | 'claude'
        | 'all';
      const bundle = generateAgentConfigBundle(target);
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatAgentConfigText(bundle)}\n`);
      }
      return EXIT_CODES.OK;
    }

    if (command === 'init') {
      const { initProject } = await import('./init.js');
      const result = initProject({ workspaceRoot: cwd, force: flags.force === true });
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`Initialized AEG configuration in ${cwd}/.engineering-guard/\n`);
        process.stdout.write(`  Languages: ${result.detectedLanguages.join(', ')}\n`);
        process.stdout.write(`  Modules:   ${result.detectedModules.join(', ')}\n`);
        process.stdout.write(`  Suites:    ${result.detectedSuites.join(', ')}\n`);
        process.stdout.write(`Next: review .engineering-guard/*.yaml and run \`aeg check\`.\n`);
      }
      return EXIT_CODES.OK;
    }

    if (command === 'config' && subcommand === 'validate') {
      const { loadWorkingTreeConfig, resolveWorkspaceRoot } = await import('../config/loader.js');
      const bundle = loadWorkingTreeConfig(resolveWorkspaceRoot(cwd));
      const out = {
        valid: true,
        project: bundle.config.project.name,
        configDigest: bundle.configDigest,
        policyDigest: bundle.policyDigest,
        modules: Object.keys(bundle.modules.modules),
        suites: Object.keys(bundle.tests.suites),
      };
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Configuration valid (${out.project}): ${out.modules.length} module(s), ${out.suites.length} suite(s), digest=${out.configDigest.slice(0, 12)}\n`,
        );
      }
      return EXIT_CODES.OK;
    }

    if (command === 'baseline') {
      const { GitAdapter } = await import('../adapters/git/git-adapter.js');
      const { evaluatePolicyContext, resolveWorkspaceRoot } = await import('../config/loader.js');
      const root = resolveWorkspaceRoot(cwd);
      const git = new GitAdapter(root);
      const ctx = evaluatePolicyContext(root, git, base);
      const payload = {
        baselineStatus: ctx.baselineStatus,
        baselineRef: ctx.baseline?.sourceRef,
        baselinePolicyDigest: ctx.baseline?.policyDigest,
        candidatePolicyDigest: ctx.candidate.policyDigest,
        effectivePolicyDigest: ctx.effective.policyDigest,
        differences: ctx.differences,
        relaxations: ctx.relaxations,
        warnings: ctx.warnings,
      };
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Baseline Status: ${payload.baselineStatus} (ref=${payload.baselineRef ?? 'none'})\n`,
        );
        process.stdout.write(`Differences: ${payload.differences.length} | Relaxations: ${payload.relaxations.length}\n`);
        for (const d of payload.differences) {
          process.stdout.write(`  [${d.kind}] ${d.target}: ${d.reason}\n`);
        }
        for (const w of payload.warnings) {
          process.stdout.write(`  ! ${w}\n`);
        }
      }
      return ctx.relaxations.length > 0 ? EXIT_CODES.GATE_FAILED : EXIT_CODES.OK;
    }

    if (command === 'inspect') {
      const { resolveWorkspaceRoot } = await import('../config/loader.js');
      const { inspectFailureDetail, loadLatestReport, readBoundedLogExcerpt } = await import(
        '../report/reporter.js'
      );
      const runId = getStringFlag(flags, 'run');
      const report = loadLatestReport(resolveWorkspaceRoot(cwd), runId);
      if (!report) {
        process.stderr.write(`No AEG run found${runId ? ` for id '${runId}'` : ''}. Run 'aeg check' first.\n`);
        return EXIT_CODES.TOOL_OR_ENV_ERROR;
      }

      if (subcommand === 'failure') {
        const target = positionals[2];
        const details = inspectFailureDetail(report, target);
        if (format === 'json' || format === 'agent-summary') {
          process.stdout.write(`${JSON.stringify({ runId: report.runId, failures: details }, null, 2)}\n`);
        } else if (details.length === 0) {
          process.stdout.write(`No failures recorded in ${report.runId}.\n`);
        } else {
          for (const f of details) {
            process.stdout.write(`[${f.id}] suite=${f.suiteId} category=${f.category}\n`);
            process.stdout.write(`  message:  ${f.message}\n`);
            if (f.location) process.stdout.write(`  location: ${f.location}\n`);
            process.stdout.write(`  artifact: ${f.artifactRef}\n`);
            process.stdout.write(`  excerpt:\n${f.excerpt}\n\n`);
          }
        }
        return EXIT_CODES.OK;
      }

      if (subcommand === 'log') {
        const target = positionals[2];
        const details = inspectFailureDetail(report, target);
        const match = details[0];
        if (!match || !match.artifactRef) {
          process.stderr.write(`No failure log artifact matched '${target ?? ''}' in ${report.runId}.\n`);
          return EXIT_CODES.TOOL_OR_ENV_ERROR;
        }
        const startLine = Number(getStringFlag(flags, 'start') ?? 1);
        const maxLines = Number(getStringFlag(flags, 'lines') ?? 120);
        const maxBytes = Number(getStringFlag(flags, 'bytes') ?? 16384);
        const excerpt = readBoundedLogExcerpt({
          logPath: match.artifactRef,
          startLine,
          maxLines,
          maxBytes,
        });
        if (format === 'json' || format === 'agent-summary') {
          process.stdout.write(
            `${JSON.stringify({ id: match.id, artifactRef: match.artifactRef, ...excerpt }, null, 2)}\n`,
          );
        } else {
          process.stdout.write(
            `--- Log ${match.id} (${match.artifactRef}, lines ${startLine}+ of ${excerpt.totalLines}) ---\n`,
          );
          process.stdout.write(`${excerpt.content}\n`);
          if (excerpt.truncated) {
            process.stdout.write(
              `[...truncated; use --start ${startLine + maxLines} --lines ${maxLines} to continue...]\n`,
            );
          }
        }
        return EXIT_CODES.OK;
      }

      process.stderr.write(`Unknown inspect subcommand: '${subcommand ?? ''}'. Use 'failure' or 'log'.\n`);
      return EXIT_CODES.TOOL_OR_ENV_ERROR;
    }

    const { runQualityPipeline } = await import('../engine.js');
    const { formatTextReport } = await import('../report/reporter.js');

    if (command === 'explain') {
      const { report } = await runQualityPipeline({
        workspaceRoot: cwd,
        base,
        scope,
        mode,
        policy: policy ?? 'local',
        planOnly: true,
        disableCache,
        persistArtifacts: false,
      });

      if (subcommand === 'risk') {
        if (format === 'json' || format === 'agent-summary') {
          process.stdout.write(`${JSON.stringify(report.risk, null, 2)}\n`);
        } else {
          process.stdout.write(`Risk Level: ${report.risk.level}\n`);
          process.stdout.write(`Required Checks: ${report.risk.requiredChecks.join(', ') || 'none'}\n`);
          for (const f of report.risk.factors) {
            process.stdout.write(`  - [${f.level}${f.nonOverridable ? ', non-overridable' : ''}] ${f.reason}\n`);
          }
          if (report.risk.blockingUnknowns.length > 0) {
            process.stdout.write('Blocking Unknowns:\n');
            for (const u of report.risk.blockingUnknowns) process.stdout.write(`  ! ${u}\n`);
          }
        }
        return EXIT_CODES.OK;
      }

      if (subcommand === 'test') {
        const suiteId = positionals[2];
        if (!suiteId) {
          process.stderr.write("Missing <suite-id>. Usage: aeg explain test <suite-id>\n");
          return EXIT_CODES.CONFIG_ERROR;
        }
        const planned = report.plan.suites.find((s) => s.suiteId === suiteId);
        const excluded = report.plan.excludedSuites.find((s) => s.suiteId === suiteId);
        const explanation = planned ?? excluded;
        if (!explanation) {
          process.stderr.write(`Suite '${suiteId}' not found in project configuration.\n`);
          return EXIT_CODES.CONFIG_ERROR;
        }
        if (format === 'json' || format === 'agent-summary') {
          process.stdout.write(`${JSON.stringify(explanation, null, 2)}\n`);
        } else if (planned) {
          process.stdout.write(`Suite: ${planned.suiteId}\n`);
          process.stdout.write(`Disposition: ${planned.disposition}\n`);
          process.stdout.write(`Covered Modules: ${planned.coveredModules.join(', ') || 'none'}\n`);
          process.stdout.write(`Selection Reasons:\n`);
          for (const r of planned.selectionReasons) process.stdout.write(`  - ${r}\n`);
          if (planned.cacheDecision) {
            process.stdout.write(
              `Cache Decision: ${planned.cacheDecision.decision} (${planned.cacheDecision.reasons.join('; ')})\n`,
            );
          }
        } else if (excluded) {
          process.stdout.write(`Suite: ${excluded.suiteId}\n`);
          process.stdout.write(`Disposition: ${excluded.disposition}\n`);
          process.stdout.write(`Exclusion Reasons:\n`);
          for (const r of excluded.reasons) process.stdout.write(`  - ${r}\n`);
        }
        return EXIT_CODES.OK;
      }

      process.stderr.write("Usage: aeg explain risk | aeg explain test <suite-id>\n");
      return EXIT_CODES.TOOL_OR_ENV_ERROR;
    }

    if (command === 'analyze') {
      const { report } = await runQualityPipeline({
        workspaceRoot: cwd,
        base,
        scope,
        mode,
        policy: policy ?? 'local',
        planOnly: true,
        disableCache,
        persistArtifacts: false,
      });
      const out = {
        mode: report.mode,
        requestedMode: report.requestedMode,
        changeSet: report.changeSet,
        impact: report.impact,
        risk: report.risk,
        policyContext: report.policyContext,
      };
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Analyze (${report.mode}): ${report.changeSet.files.length} changed file(s), risk=${report.risk.level}, direct=[${report.impact.directlyChangedModules.join(', ')}], downstream=[${report.impact.transitivelyAffectedModules.join(', ')}]\n`,
        );
      }
      return EXIT_CODES.OK;
    }

    if (command === 'plan-tests') {
      const { report } = await runQualityPipeline({
        workspaceRoot: cwd,
        base,
        scope,
        mode,
        policy: policy ?? 'local',
        planOnly: true,
        disableCache,
        persistArtifacts: true,
      });
      if (format === 'json' || format === 'agent-summary') {
        process.stdout.write(`${JSON.stringify(report.plan, null, 2)}\n`);
      } else {
        process.stdout.write(`Test Plan ${report.plan.id} (digest=${report.plan.planDigest.slice(0, 12)})\n`);
        for (const r of report.plan.rationale) process.stdout.write(`  ${r}\n`);
        for (const s of report.plan.suites) {
          process.stdout.write(`  - ${s.suiteId} [${s.disposition}]: ${s.selectionReasons.join('; ')}\n`);
        }
      }
      return EXIT_CODES.OK;
    }

    if (command === 'test') {
      const planPath = getStringFlag(flags, 'plan');
      const { report, exitCode } = await runQualityPipeline({
        workspaceRoot: cwd,
        base,
        scope,
        mode,
        policy: policy ?? 'local',
        planFilePath: planPath,
        disableCache,
        persistArtifacts: true,
      });
      await emitReport(report, format, formatTextReport, { cwd, sarifOut, junitOut });
      return exitCode;
    }

    if (command === 'check' || command === 'gate') {
      const { report, exitCode } = await runQualityPipeline({
        workspaceRoot: cwd,
        base,
        scope,
        mode,
        policy: policy ?? (command === 'gate' ? 'pull-request' : 'local'),
        planOnly: flags['plan-only'] === true,
        disableCache,
        persistArtifacts: true,
      });
      await emitReport(report, format, formatTextReport, { cwd, sarifOut, junitOut });
      return exitCode;
    }

    process.stderr.write(`Unknown command '${command}'. Run 'aeg --help' for usage.\n`);
    return EXIT_CODES.TOOL_OR_ENV_ERROR;
  } catch (err: unknown) {
    const { ConfigValidationError } = await import('../config/loader.js');
    if (err instanceof ConfigValidationError) {
      if (format === 'agent-summary') {
        process.stdout.write(
          `${JSON.stringify(
            {
              outcome: 'error',
              workflow_action: 'block',
              error_code: 'CONFIG_ERROR',
              error_message: err.message,
              issues: err.issues,
              agent_action: {
                required: true,
                next_steps: [
                  'Fix schema or cross-reference errors in .engineering-guard/*.yaml.',
                  'Re-run `aeg config validate --format json` to confirm configuration validity.',
                ],
              },
            },
            null,
            2,
          )}\n`,
        );
      } else if (format === 'json') {
        process.stdout.write(
          `${JSON.stringify({ error: 'CONFIG_ERROR', message: err.message, issues: err.issues }, null, 2)}\n`,
        );
      } else {
        process.stderr.write(`[CONFIG ERROR] ${err.message}\n`);
        for (const issue of err.issues) {
          process.stderr.write(`  - ${issue.file} (${issue.path}): ${issue.message}\n`);
        }
      }
      return EXIT_CODES.CONFIG_ERROR;
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (format === 'agent-summary') {
      process.stdout.write(
        `${JSON.stringify(
          {
            outcome: 'error',
            workflow_action: 'block',
            error_code: 'TOOL_OR_ENV_ERROR',
            error_message: msg,
            agent_action: {
              required: true,
              next_steps: ['Inspect the error_message, verify repository path and Git/runtime environment, and retry.'],
            },
          },
          null,
          2,
        )}\n`,
      );
    } else if (format === 'json') {
      process.stdout.write(`${JSON.stringify({ error: 'TOOL_OR_ENV_ERROR', message: msg }, null, 2)}\n`);
    } else {
      process.stderr.write(`[ERROR] ${msg}\n`);
    }
    return EXIT_CODES.TOOL_OR_ENV_ERROR;
  }
}

async function emitReport(
  report: import('../domain/types.js').QualityReport,
  format: OutputFormat,
  formatTextReport: (r: import('../domain/types.js').QualityReport) => string,
  extra: { cwd: string; sarifOut?: string; junitOut?: string },
): Promise<void> {
  if (extra.sarifOut || format === 'sarif' || extra.junitOut || format === 'junit') {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const { formatJunitReport, formatSarifReport } = await import('../report/sarif-junit.js');
    if (extra.sarifOut) {
      const outPath = pathMod.resolve(extra.cwd, extra.sarifOut);
      fsMod.mkdirSync(pathMod.dirname(outPath), { recursive: true });
      fsMod.writeFileSync(outPath, formatSarifReport(report), 'utf8');
    }
    if (extra.junitOut) {
      const outPath = pathMod.resolve(extra.cwd, extra.junitOut);
      fsMod.mkdirSync(pathMod.dirname(outPath), { recursive: true });
      fsMod.writeFileSync(outPath, formatJunitReport(report), 'utf8');
    }
    if (format === 'sarif') {
      process.stdout.write(`${formatSarifReport(report)}\n`);
      return;
    }
    if (format === 'junit') {
      process.stdout.write(`${formatJunitReport(report)}\n`);
      return;
    }
  }

  if (format === 'agent-summary') {
    process.stdout.write(`${JSON.stringify(report.agentSummary, null, 2)}\n`);
  } else if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTextReport(report)}\n`);
  }
}
