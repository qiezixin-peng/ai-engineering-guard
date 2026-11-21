import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExecutionMatrix } from '../../src/adapters/durable-pi/router.js';
import {
  CoordinatorReceiptAggregator,
  signReceipt,
} from '../../src/aggregate/aggregator.js';
import { CacheEngine } from '../../src/cache/cache-engine.js';
import { main } from '../../src/cli/index.js';
import { PACKAGE_ROOT } from '../../src/config/schema-validator.js';
import { AEG_VERSION, type Platform, type TestResultReceipt } from '../../src/domain/types.js';
import { buildExecutionEnvironment, runQualityPipeline } from '../../src/engine.js';
import { formatJunitReport, formatSarifReport } from '../../src/report/sarif-junit.js';

const tempDirs: string[] = [];

function createGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'p2@example.com'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'AEG Phase2'], { cwd: dir, windowsHide: true });
  return dir;
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['commit', '-m', message], { cwd: dir, windowsHide: true });
}

function setupHeterogeneousProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'services/billing'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'services/checkout'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.engineering-guard'), { recursive: true });

  // Nx markers (existing build graph reuse)
  fs.writeFileSync(path.join(dir, 'nx.json'), JSON.stringify({ npmScope: 'acme' }));
  fs.writeFileSync(
    path.join(dir, 'services/billing/project.json'),
    JSON.stringify({ name: 'billing', implicitDependencies: [] }),
  );
  fs.writeFileSync(
    path.join(dir, 'services/checkout/project.json'),
    JSON.stringify({ name: 'checkout', implicitDependencies: ['billing'] }),
  );

  // Source files (Python + TS)
  fs.writeFileSync(
    path.join(dir, 'services/billing/invoice.ts'),
    'export interface InvoiceDTO { total: number }\nexport function computeInvoice(x: number) { return x * 1.1; }\n',
  );
  fs.writeFileSync(
    path.join(dir, 'services/checkout/handler.py'),
    'def process_checkout(amount):\n    # references computeInvoice contract\n    return amount\n',
  );
  fs.writeFileSync(path.join(dir, 'contracts/openapi.yaml'), 'openapi: 3.0.3\ninfo: { title: Billing, version: "1.0" }\n');
  fs.writeFileSync(path.join(dir, 'migrations/001_init.sql'), 'CREATE TABLE invoices (id INT PRIMARY KEY);\n');
  fs.writeFileSync(path.join(dir, 'coverage/lcov.info'), 'SF:services/billing/invoice.ts\nDA:1,1\nend_of_record\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Heterogeneous Billing Repo\n');

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/config.yaml'),
    `schema_version: 1
project:
  name: acme-billing
  languages: [typescript, python]
  baseline_ref: main
analysis:
  default_mode: balanced
  auto_escalate: true
  providers:
    builtin-module: { enabled: true }
    existing-build-graph: { enabled: auto, detects: [nx, moon, pants, bazel] }
    ast-symbols: { enabled: auto, modes: [deep, release] }
    gitnexus: { enabled: auto, modes: [deep, release], distribution: user-installed }
    coverage-impact: { enabled: auto, modes: [deep, release] }
    contracts-db: { enabled: auto, modes: [balanced, deep, release] }
risk:
  default_level: L2
  protected_modules: []
cache:
  enabled: true
  exact_tree: true
  suite_fingerprint:
    mode: shadow
gates:
  local: { block_on: [test_failure, invalid_config] }
  delivery: { require_clean_worktree: false, block_on: [test_failure, L4_unknown, invalid_config, policy_relaxation, incomplete] }
`,
  );

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/modules.yaml'),
    `schema_version: 1
modules:
  billing:
    paths: [services/billing/**]
    depends_on: []
  checkout:
    paths: [services/checkout/**]
    depends_on: []
  contracts:
    paths: [contracts/**]
    depends_on: []
`,
  );

  fs.writeFileSync(
    path.join(dir, '.engineering-guard/tests.yaml'),
    `schema_version: 1
suites:
  billing-unit:
    framework: command
    command:
      executable: node
      args: [-e, "console.log('billing ok')"]
      cwd: .
    covers: [billing, contracts]
    level: unit
    critical: true
    cache:
      enabled: true
      cross_commit: shadow
      hermetic: true
      inputs:
        - services/billing/**
    platforms: [windows, linux, macos]
    execution: once_per_change
    portable: true
    canonical_platform: linux
  checkout-e2e:
    framework: command
    command:
      executable: node
      args: [-e, "console.log('checkout ok')"]
      cwd: .
    covers: [checkout]
    level: integration
    platforms: [windows, linux, macos]
    execution: each_platform
    capabilities: [python]
regressions: []
`,
  );

  fs.writeFileSync(path.join(dir, '.gitignore'), '.aeg/\n');
  commitAll(dir, 'heterogeneous baseline');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Phase 2: Heterogeneous Project, Enhanced Providers, Shadow Cache, SARIF & JUnit', () => {
  it('reuses Nx build graph, AST symbols, coverage map, and detects destructive SQL + OpenAPI contracts', async () => {
    const dir = createGitRepo('aeg-p2-het-');
    setupHeterogeneousProject(dir);

    // Edit billing + OpenAPI + destructive SQL migration
    fs.writeFileSync(
      path.join(dir, 'services/billing/invoice.ts'),
      'export interface InvoiceDTO { total: number; currency: string }\nexport function computeInvoice(x: number) { return x * 1.2; }\n',
    );
    fs.writeFileSync(
      path.join(dir, 'contracts/openapi.yaml'),
      'openapi: 3.0.3\ninfo: { title: Billing, version: "2.0" }\n',
    );
    fs.writeFileSync(
      path.join(dir, 'migrations/002_drop.sql'),
      'ALTER TABLE invoices DROP COLUMN legacy_tax;\n',
    );

    const { report, exitCode } = await runQualityPipeline({
      workspaceRoot: dir,
      mode: 'deep',
      policy: 'local',
    });

    expect(exitCode).toBe(0);
    // Nx provider picked up implicit dependency checkout -> billing even though modules.yaml didn't declare it!
    expect(report.impact.transitivelyAffectedModules).toContain('checkout');
    // AST provider ran (GitNexus gracefully skipped since not installed/authorized)
    expect(report.impact.envelopes.some((e) => e.providerId === 'existing-build-graph')).toBe(true);
    expect(report.impact.envelopes.some((e) => e.providerId === 'ast-symbols')).toBe(true);
    expect(report.impact.envelopes.some((e) => e.providerId === 'gitnexus')).toBe(false);
    expect(report.impact.envelopes.some((e) => e.providerId === 'coverage-impact')).toBe(true);
    expect(report.impact.envelopes.some((e) => e.providerId === 'contracts-db')).toBe(true);
    // Contracts + destructive SQL detected
    expect(report.impact.affectedContracts).toContain('contract:contracts/openapi.yaml');
    expect(report.impact.affectedDataModels.some((d) => d.includes('destructive-migration:DROP COLUMN'))).toBe(true);
    expect(report.risk.level).toBe('L4');

    // SARIF 2.1.0 & JUnit XML on-demand generation
    const sarif = JSON.parse(formatSarifReport(report));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('AI Engineering Guard');

    const junit = formatJunitReport(report);
    expect(junit).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(junit).toContain('<testsuite');
    expect(junit).toContain('billing-unit');
  });

  it('validates SuiteInputFingerprint shadow mode, instant revocation on mismatch, and controlled cross-commit hit', () => {
    const dir = createGitRepo('aeg-p2-shadow-');
    setupHeterogeneousProject(dir);

    const suiteDef = {
      framework: 'command' as const,
      command: { executable: 'node', args: ['-e', 'process.exit(0)'] },
      covers: ['billing'],
      level: 'unit' as const,
      cache: {
        enabled: true,
        cross_commit: 'shadow' as const,
        hermetic: true,
        inputs: ['services/billing/**'],
      },
    };
    const shadowConfig = {
      schema_version: 1 as const,
      project: { name: 'acme-billing' },
      cache: {
        enabled: true,
        exact_tree: true,
        suite_fingerprint: { mode: 'shadow' as const },
      },
    };
    const env = buildExecutionEnvironment({
      projectRevision: 'c1',
      repositoryTreeHash: 'tree-1',
      worktreeClean: true,
    });
    const cache = new CacheEngine(dir, shadowConfig);

    const keyTree1 = {
      repositoryTreeHash: 'tree-1',
      suiteId: 'billing-unit',
      executionVariant: 'default',
      suiteDef,
      configDigest: 'cfg1',
      policyDigest: 'pol1',
      environment: env,
      allowedEnvValues: {},
    };

    // Store passing result on tree-1
    cache.storePassedResult({
      config: shadowConfig,
      keyInput: keyTree1,
      result: {
        suiteId: 'billing-unit',
        executionVariant: 'default',
        disposition: 'execute',
        status: 'passed',
        cached: false,
        durationMs: 20,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outputDigest: 'ok1',
        artifactRefs: [],
        failureDetails: [],
      },
    });

    // Different tree-2 (unrelated file changed, billing inputs unchanged!) -> shadow_candidate!
    const keyTree2 = { ...keyTree1, repositoryTreeHash: 'tree-2' };
    const shadowDecision = cache.evaluateLookup({
      config: shadowConfig,
      mode: 'balanced',
      confidence: 0.95,
      keyInput: keyTree2,
    });
    expect(shadowDecision.mode).toBe('suite_fingerprint');
    expect(shadowDecision.decision).toBe('shadow_candidate');

    // Record 1 shadow match
    const matchRes = cache.recordShadowComparison({
      suiteId: 'billing-unit',
      cacheDecision: shadowDecision,
      actualStatus: 'passed',
    });
    expect(matchRes.mismatch).toBe(false);
    expect(cache.getShadowStats('billing-unit')['billing-unit']?.matches).toBe(1);

    // If enabled (not revoked), tree-2 gets formal cross-commit HIT!
    const enabledConfig = {
      ...shadowConfig,
      cache: { ...shadowConfig.cache, suite_fingerprint: { mode: 'enabled' as const } },
    };
    const enabledSuite = {
      ...suiteDef,
      cache: { ...suiteDef.cache, cross_commit: 'enabled' as const },
    };
    const formalHit = cache.evaluateLookup({
      config: enabledConfig,
      mode: 'balanced',
      confidence: 0.95,
      keyInput: { ...keyTree2, suiteDef: enabledSuite },
    });
    expect(formalHit.mode).toBe('suite_fingerprint');
    expect(formalHit.decision).toBe('hit');

    // Simulate 1 shadow mismatch -> IMMEDIATE revocation & cache eviction!
    const mismatchRes = cache.recordShadowComparison({
      suiteId: 'billing-unit',
      cacheDecision: shadowDecision,
      actualStatus: 'failed',
    });
    expect(mismatchRes.mismatch).toBe(true);
    expect(mismatchRes.revoked).toBe(true);

    // After revocation, even enabled mode MUST reject cross-commit cache!
    const afterRevoke = cache.evaluateLookup({
      config: enabledConfig,
      mode: 'balanced',
      confidence: 0.95,
      keyInput: { ...keyTree2, suiteDef: enabledSuite },
    });
    expect(afterRevoke.decision).toBe('rejected');
  });
});

describe('Phase 3: Durable Pi Cross-Device Matrix, Receipt Aggregator & Live Stdio MCP Server', () => {
  it('routes across Win/Linux/macOS, rejects stale/replayed/forged receipts, and passes once all 3 platforms verify', async () => {
    const dir = createGitRepo('aeg-p3-xdev-');
    setupHeterogeneousProject(dir);
    fs.writeFileSync(
      path.join(dir, 'services/billing/invoice.ts'),
      'export function computeInvoice(x: number) { return x * 1.5; }\n',
    );

    const { report } = await runQualityPipeline({
      workspaceRoot: dir,
      mode: 'deep',
      policy: 'delivery',
      planOnly: true,
    });

    const executors = [
      { id: 'windows-main', platform: 'windows' as Platform, architecture: 'x64', capabilities: ['node', 'python'] },
      { id: 'linux-main', platform: 'linux' as Platform, architecture: 'x64', capabilities: ['node', 'python'] },
      { id: 'macos-main', platform: 'macos' as Platform, architecture: 'arm64', capabilities: ['node', 'python'] },
    ];

    const matrix = buildExecutionMatrix({
      plan: report.plan,
      tests: {
        suites: {
          'billing-unit': {
            framework: 'command',
            command: { executable: 'node' },
            covers: ['billing'],
            level: 'unit',
            platforms: ['windows', 'linux', 'macos'],
            execution: 'once_per_change',
            portable: true,
            canonical_platform: 'linux',
          },
          'checkout-e2e': {
            framework: 'command',
            command: { executable: 'node' },
            covers: ['checkout'],
            level: 'integration',
            platforms: ['windows', 'linux', 'macos'],
            execution: 'each_platform',
            capabilities: ['python'],
          },
        },
      },
      executors,
    });

    expect(matrix.complete).toBe(true);
    // billing-unit once_per_change -> linux-main; checkout-e2e each_platform -> all 3!
    expect(matrix.assignments.filter((a) => a.suiteId === 'billing-unit')).toHaveLength(1);
    expect(matrix.assignments.filter((a) => a.suiteId === 'checkout-e2e')).toHaveLength(3);

    // Offline macOS executor -> blocked & incomplete matrix
    const offlineMatrix = buildExecutionMatrix({
      plan: report.plan,
      tests: {
        suites: {
          'billing-unit': {
            framework: 'command',
            command: { executable: 'node' },
            covers: ['billing'],
            level: 'unit',
            platforms: ['windows', 'linux', 'macos'],
            execution: 'once_per_change',
            portable: true,
            canonical_platform: 'linux',
          },
          'checkout-e2e': {
            framework: 'command',
            command: { executable: 'node' },
            covers: ['checkout'],
            level: 'integration',
            platforms: ['windows', 'linux', 'macos'],
            execution: 'each_platform',
            capabilities: ['python'],
          },
        },
      },
      executors: executors.slice(0, 2), // macOS missing
    });
    expect(offlineMatrix.complete).toBe(false);
    expect(offlineMatrix.missingPlatforms).toContain('macos');

    // Coordinator Receipt Aggregator with HMAC signing & anti-replay/stale-attempt checks
    const secret = 'durable-pi-shared-key';
    const makeSignedReceipt = (
      id: string,
      suiteId: string,
      platform: Platform,
      attemptId: string,
      status: TestResultReceipt['status'] = 'passed',
      overrides: Partial<TestResultReceipt> = {},
    ): TestResultReceipt => {
      const base: Omit<TestResultReceipt, 'signature'> = {
        receiptId: id,
        projectId: 'acme-billing',
        taskId: 'task-100',
        attemptId,
        suiteId,
        planDigest: report.plan.planDigest,
        configDigest: report.plan.configDigest,
        policyDigest: report.plan.policyDigest,
        repositoryTreeHash: report.plan.repositoryTreeHash,
        environment: {
          deviceId: `${platform}-main`,
          platform,
          osVersion: '1.0',
          architecture: platform === 'macos' ? 'arm64' : 'x64',
          aegVersion: AEG_VERSION,
          runtimeVersions: { node: process.versions.node },
          toolchainDigest: `tc-${platform}`,
          projectRevision: report.changeSet.headRevision,
          repositoryTreeHash: report.plan.repositoryTreeHash,
          worktreeClean: true,
        },
        status,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outputDigest: `out-${id}`,
        artifactRefs: [],
        ...overrides,
      };
      return signReceipt(base, secret);
    };

    const agg = new CoordinatorReceiptAggregator({
      plan: report.plan,
      tests: {
        suites: {
          'billing-unit': {
            framework: 'command',
            command: { executable: 'node' },
            covers: ['billing'],
            level: 'unit',
            platforms: ['windows', 'linux', 'macos'],
            execution: 'once_per_change',
            portable: true,
            canonical_platform: 'linux',
          },
          'checkout-e2e': {
            framework: 'command',
            command: { executable: 'node' },
            covers: ['checkout'],
            level: 'integration',
            platforms: ['windows', 'linux', 'macos'],
            execution: 'each_platform',
          },
        },
      },
      policy: 'delivery',
      signingSecret: secret,
    });

    // Accept valid attempt-2 on windows
    const rWin2 = makeSignedReceipt('rcpt-win-2', 'checkout-e2e', 'windows', 'attempt-2', 'passed');
    expect(agg.register(rWin2).accepted).toBe(true);
    // Reject duplicate replay
    expect(agg.register(rWin2).accepted).toBe(false);
    // Reject late-arriving older attempt-1
    const rWin1 = makeSignedReceipt('rcpt-win-1', 'checkout-e2e', 'windows', 'attempt-1', 'failed');
    expect(agg.register(rWin1).accepted).toBe(false);
    // Reject mismatched tree hash
    const rBadTree = makeSignedReceipt('rcpt-bad-tree', 'checkout-e2e', 'linux', 'attempt-1', 'passed', {
      repositoryTreeHash: 'different-tree',
    });
    expect(agg.register(rBadTree).accepted).toBe(false);
    // Reject incompatible AEG major version
    const rBadVer = makeSignedReceipt('rcpt-bad-ver', 'checkout-e2e', 'linux', 'attempt-1', 'passed', {
      environment: { ...rWin2.environment, platform: 'linux', aegVersion: '9.0.0' },
    });
    expect(agg.register(rBadVer).accepted).toBe(false);
    // Reject forged signature
    const rForged = { ...makeSignedReceipt('rcpt-forged', 'checkout-e2e', 'linux', 'attempt-1'), signature: 'deadbeef' };
    expect(agg.register(rForged).accepted).toBe(false);

    // Still missing linux & macos -> MUST return incomplete (exit code 5)!
    const partial = agg.aggregate();
    expect(partial.gate.outcome).toBe('incomplete');
    expect(partial.exitCode).toBe(5);

    // Submit remaining valid receipts (billing-unit@linux, checkout-e2e@linux, checkout-e2e@macos)
    const rBillLin = makeSignedReceipt('rcpt-bill-lin', 'billing-unit', 'linux', 'attempt-1', 'passed');
    const rChkLin = makeSignedReceipt('rcpt-chk-lin', 'checkout-e2e', 'linux', 'attempt-1', 'passed');
    const rChkMac = makeSignedReceipt('rcpt-chk-mac', 'checkout-e2e', 'macos', 'attempt-1', 'passed');
    expect(agg.register(rBillLin).accepted).toBe(true);
    expect(agg.register(rChkLin).accepted).toBe(true);
    expect(agg.register(rChkMac).accepted).toBe(true);

    const finalAgg = agg.aggregate();
    expect(finalAgg.gate.outcome).toBe('passed');
    expect(finalAgg.exitCode).toBe(0);
    expect(finalAgg.missingSlots).toHaveLength(0);

    // Also test CLI `aeg aggregate` with saved receipt files
    const rcptDir = path.join(dir, '.aeg/receipts');
    fs.mkdirSync(rcptDir, { recursive: true });
    fs.writeFileSync(path.join(rcptDir, 'all.json'), JSON.stringify([rWin2, rBillLin, rChkLin, rChkMac]));
    const cliCode = await main([
      'aggregate',
      '--cwd',
      dir,
      '--plan',
      '.aeg/plans/current.json',
      '--receipts',
      '.aeg/receipts',
      '--secret',
      secret,
      '--format',
      'json',
    ]);
    expect(cliCode).toBe(0);
  });

  it('serves all 16 MCP tools over live JSON-RPC 2.0 stdio (bin/aeg-mcp.js)', async () => {
    const dir = createGitRepo('aeg-p3-mcp-');
    setupHeterogeneousProject(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# MCP check\n');

    const mcpBin = path.join(PACKAGE_ROOT, 'bin', 'aeg-mcp.js');
    const child = spawn(process.execPath, [mcpBin], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses: Array<Record<string, unknown>> = [];
    let buffer = '';
    const waitForCount = (target: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${target} MCP responses`)), 10000);
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            responses.push(JSON.parse(line));
          }
          if (responses.length >= target) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve();
          }
        };
        child.stdout.on('data', onData);
      });

    try {
      const send = (msg: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(msg)}\n`);

      const p1 = waitForCount(3);
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'run_quality_gate', arguments: { cwd: dir, mode: 'fast', policy: 'local' } },
      });
      await p1;

      const initResp = responses.find((r) => r.id === 1) as { result: { serverInfo: { name: string } } };
      expect(initResp.result.serverInfo.name).toBe('ai-engineering-guard');

      const listResp = responses.find((r) => r.id === 2) as { result: { tools: Array<{ name: string }> } };
      expect(listResp.result.tools.length).toBe(16);
      expect(listResp.result.tools.map((t) => t.name)).toContain('aggregate_gate_results');

      const gateResp = responses.find((r) => r.id === 3) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(gateResp.result.isError).toBe(false);
      const gatePayload = JSON.parse(gateResp.result.content[0]!.text);
      expect(gatePayload.exitCode).toBe(0);
      expect(gatePayload.agentSummary.outcome).toBe('passed');
      expect(gatePayload.agentSummary.risk.level).toBe('L0');
    } finally {
      child.kill();
    }
  });
});
