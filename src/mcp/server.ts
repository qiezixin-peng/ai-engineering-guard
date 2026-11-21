import fs from 'node:fs';
import path from 'node:path';
import {
  buildExecutionMatrix,
  type ExecutorDescriptor,
} from '../adapters/durable-pi/router.js';
import { GitAdapter } from '../adapters/git/git-adapter.js';
import { CoordinatorReceiptAggregator } from '../aggregate/aggregator.js';
import { evaluatePolicyContext, loadWorkingTreeConfig } from '../config/loader.js';
import {
  AEG_VERSION,
  type AnalysisMode,
  type GatePolicyName,
  type TestPlan,
  type TestResultReceipt,
} from '../domain/types.js';
import { runQualityPipeline } from '../engine.js';
import {
  inspectFailureDetail,
  loadLatestReport,
  readBoundedLogExcerpt,
} from '../report/reporter.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  // --- Read-Only Tools (Section 13) ---
  {
    name: 'analyze_changes',
    description: '[Read-only] Analyze Git diff, file classifications, impact, and policy diff without running tests.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Target repository directory' },
        base: { type: 'string', description: 'Base Git ref (e.g. origin/main)' },
        mode: { type: 'string', enum: ['fast', 'balanced', 'deep', 'release'] },
      },
    },
  },
  {
    name: 'get_impact_graph',
    description: '[Read-only] Return directly changed modules, transitively affected downstream modules, contracts, symbols, and unknowns.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        base: { type: 'string' },
        mode: { type: 'string', enum: ['fast', 'balanced', 'deep', 'release'] },
      },
    },
  },
  {
    name: 'assess_risk',
    description: '[Read-only] Compute deterministic L0-L4 risk level, contributing factors, required checks, and blocking unknowns.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        base: { type: 'string' },
        mode: { type: 'string', enum: ['fast', 'balanced', 'deep', 'release'] },
      },
    },
  },
  {
    name: 'plan_tests',
    description: '[Read-only] Generate deduplicated, cache-aware test plan without executing commands.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        base: { type: 'string' },
        mode: { type: 'string', enum: ['fast', 'balanced', 'deep', 'release'] },
        no_cache: { type: 'boolean' },
      },
    },
  },
  {
    name: 'explain_test_selection',
    description: '[Read-only] Explain why a specific test suite was selected, cached, blocked, or marked not_required.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      required: ['suite_id'],
      properties: {
        cwd: { type: 'string' },
        suite_id: { type: 'string' },
        base: { type: 'string' },
        mode: { type: 'string', enum: ['fast', 'balanced', 'deep', 'release'] },
      },
    },
  },
  {
    name: 'get_gate_status',
    description: '[Read-only] Read the gate decision and minimal agent-summary from the latest (or specified) run.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        run_id: { type: 'string' },
      },
    },
  },
  {
    name: 'get_quality_report',
    description: '[Read-only] Read the structured quality report (default view: agent-summary to minimize agent context).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        run_id: { type: 'string' },
        view: { type: 'string', enum: ['agent-summary', 'full'], default: 'agent-summary' },
      },
    },
  },
  {
    name: 'get_failure_details',
    description: '[Read-only] Progressive disclosure: retrieve structured failure details for a failed run or suite.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        run_id: { type: 'string' },
        failure_id: { type: 'string' },
      },
    },
  },
  {
    name: 'get_log_excerpt',
    description: '[Read-only] Progressive disclosure: read a bounded, secret-redacted log slice for a failure artifact.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      required: ['failure_id'],
      properties: {
        cwd: { type: 'string' },
        run_id: { type: 'string' },
        failure_id: { type: 'string' },
        start_line: { type: 'integer', default: 1 },
        max_lines: { type: 'integer', default: 80 },
        max_bytes: { type: 'integer', default: 16384 },
      },
    },
  },

  // --- Explicit Execution Tools (Section 13) ---
  {
    name: 'run_test_plan',
    description: '[Execute] Execute a generated test plan file safely using declared structured commands.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        plan_path: { type: 'string', default: '.aeg/plans/current.json' },
        policy: { type: 'string', default: 'local' },
      },
    },
  },
  {
    name: 'run_quality_gate',
    description: '[Execute] Run full AEG pipeline (analyze -> impact -> risk -> plan -> test -> gate) and return minimal agent-summary.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        base: { type: 'string' },
        mode: { type: 'string', enum: ['fast', 'balanced', 'deep', 'release'] },
        policy: { type: 'string', enum: ['local', 'commit', 'pull-request', 'delivery', 'release'] },
        no_cache: { type: 'boolean' },
      },
    },
  },
  {
    name: 'refresh_baseline',
    description: '[Read/Check] Evaluate protected baseline PolicySnapshot against current candidate configuration.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        base: { type: 'string' },
      },
    },
  },

  // --- Cross-Device Durable Pi Tools (Section 13.1) ---
  {
    name: 'get_execution_matrix',
    description: '[Cross-device] Route planned test suites across Windows/Linux/macOS executors by platform & capabilities.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      required: ['executors'],
      properties: {
        cwd: { type: 'string' },
        plan_path: { type: 'string', default: '.aeg/plans/current.json' },
        executors: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'platform', 'architecture', 'capabilities'],
            properties: {
              id: { type: 'string' },
              platform: { type: 'string', enum: ['windows', 'linux', 'macos'] },
              architecture: { type: 'string' },
              capabilities: { type: 'array', items: { type: 'string' } },
              online: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  {
    name: 'register_execution_result',
    description: '[Cross-device] Register and verify a bound TestResultReceipt from a Windows/Linux/macOS executor.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      required: ['receipt'],
      properties: {
        cwd: { type: 'string' },
        plan_path: { type: 'string', default: '.aeg/plans/current.json' },
        receipt: { type: 'object' },
        signing_secret: { type: 'string' },
      },
    },
  },
  {
    name: 'get_platform_coverage',
    description: '[Cross-device] Inspect required vs satisfied platform execution slots for a plan.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        plan_path: { type: 'string', default: '.aeg/plans/current.json' },
      },
    },
  },
  {
    name: 'aggregate_gate_results',
    description: '[Cross-device] Aggregate verified multi-platform receipts into the final Coordinator GateDecision.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        plan_path: { type: 'string', default: '.aeg/plans/current.json' },
        policy: { type: 'string', default: 'delivery' },
        signing_secret: { type: 'string' },
      },
    },
  },
];

const SUPPORTED_MCP_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export class AegMcpSession {
  private readonly aggregators = new Map<string, CoordinatorReceiptAggregator>();

  private getOrCreateAggregator(params: {
    cwd: string;
    planPath?: string;
    policy?: string;
    signingSecret?: string;
  }): CoordinatorReceiptAggregator {
    const absPlan = path.resolve(params.cwd, params.planPath ?? '.aeg/plans/current.json');
    if (!fs.existsSync(absPlan)) {
      throw new Error(`Plan file not found: ${absPlan}`);
    }
    const plan = JSON.parse(fs.readFileSync(absPlan, 'utf8')) as TestPlan;
    const key = `${absPlan}::${plan.planDigest}`;
    let agg = this.aggregators.get(key);
    if (!agg) {
      let tests;
      try {
        tests = loadWorkingTreeConfig(params.cwd).tests;
      } catch {
        tests = undefined;
      }
      agg = new CoordinatorReceiptAggregator({
        plan,
        tests,
        policy: params.policy ?? 'delivery',
        signingSecret: params.signingSecret,
      });
      this.aggregators.set(key, agg);
    }
    return agg;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
    const base = typeof args.base === 'string' ? args.base : undefined;
    const mode = typeof args.mode === 'string' ? (args.mode as AnalysisMode) : undefined;
    const policy = typeof args.policy === 'string' ? (args.policy as GatePolicyName) : undefined;

    switch (name) {
      case 'analyze_changes': {
        const { report } = await runQualityPipeline({
          workspaceRoot: cwd,
          base,
          mode,
          policy: policy ?? 'local',
          planOnly: true,
          persistArtifacts: false,
        });
        return {
          mode: report.mode,
          requestedMode: report.requestedMode,
          changeSet: report.changeSet,
          policyContext: report.policyContext,
        };
      }

      case 'get_impact_graph': {
        const { report } = await runQualityPipeline({
          workspaceRoot: cwd,
          base,
          mode,
          policy: policy ?? 'local',
          planOnly: true,
          persistArtifacts: false,
        });
        return report.impact;
      }

      case 'assess_risk': {
        const { report } = await runQualityPipeline({
          workspaceRoot: cwd,
          base,
          mode,
          policy: policy ?? 'local',
          planOnly: true,
          persistArtifacts: false,
        });
        return report.risk;
      }

      case 'plan_tests': {
        const { report } = await runQualityPipeline({
          workspaceRoot: cwd,
          base,
          mode,
          policy: policy ?? 'local',
          planOnly: true,
          disableCache: args.no_cache === true,
          persistArtifacts: true,
        });
        return report.plan;
      }

      case 'explain_test_selection': {
        const suiteId = String(args.suite_id ?? '');
        const { report } = await runQualityPipeline({
          workspaceRoot: cwd,
          base,
          mode,
          policy: 'local',
          planOnly: true,
          persistArtifacts: false,
        });
        const planned = report.plan.suites.find((s) => s.suiteId === suiteId);
        const excluded = report.plan.excludedSuites.find((s) => s.suiteId === suiteId);
        if (!planned && !excluded) {
          throw new Error(`Suite '${suiteId}' not found in configuration.`);
        }
        return planned ?? excluded;
      }

      case 'get_gate_status': {
        const report = loadLatestReport(cwd, typeof args.run_id === 'string' ? args.run_id : undefined);
        if (!report) throw new Error('No AEG run found. Call run_quality_gate first.');
        return {
          runId: report.runId,
          gate: report.gate,
          agentSummary: report.agentSummary,
        };
      }

      case 'get_quality_report': {
        const report = loadLatestReport(cwd, typeof args.run_id === 'string' ? args.run_id : undefined);
        if (!report) throw new Error('No AEG run found. Call run_quality_gate first.');
        return args.view === 'full' ? report : report.agentSummary;
      }

      case 'get_failure_details': {
        const report = loadLatestReport(cwd, typeof args.run_id === 'string' ? args.run_id : undefined);
        if (!report) throw new Error('No AEG run found.');
        return {
          runId: report.runId,
          failures: inspectFailureDetail(
            report,
            typeof args.failure_id === 'string' ? args.failure_id : undefined,
          ),
        };
      }

      case 'get_log_excerpt': {
        const report = loadLatestReport(cwd, typeof args.run_id === 'string' ? args.run_id : undefined);
        if (!report) throw new Error('No AEG run found.');
        const failureId = String(args.failure_id ?? '');
        const match = inspectFailureDetail(report, failureId)[0];
        if (!match?.artifactRef) throw new Error(`No failure artifact matched '${failureId}'.`);
        return {
          failureId: match.id,
          artifactRef: match.artifactRef,
          ...readBoundedLogExcerpt({
            logPath: match.artifactRef,
            startLine: Number(args.start_line ?? 1),
            maxLines: Number(args.max_lines ?? 80),
            maxBytes: Number(args.max_bytes ?? 16384),
          }),
        };
      }

      case 'run_test_plan': {
        const planPath = typeof args.plan_path === 'string' ? args.plan_path : '.aeg/plans/current.json';
        const { report, exitCode } = await runQualityPipeline({
          workspaceRoot: cwd,
          policy: policy ?? 'local',
          planFilePath: planPath,
          persistArtifacts: true,
        });
        return { exitCode, agentSummary: report.agentSummary };
      }

      case 'run_quality_gate': {
        const { report, exitCode } = await runQualityPipeline({
          workspaceRoot: cwd,
          base,
          mode,
          policy: policy ?? 'local',
          disableCache: args.no_cache === true,
          persistArtifacts: true,
        });
        return { exitCode, agentSummary: report.agentSummary };
      }

      case 'refresh_baseline': {
        const git = new GitAdapter(cwd);
        const ctx = evaluatePolicyContext(cwd, git, base);
        return {
          baselineStatus: ctx.baselineStatus,
          baselineRef: ctx.baseline?.sourceRef,
          baselinePolicyDigest: ctx.baseline?.policyDigest,
          candidatePolicyDigest: ctx.candidate.policyDigest,
          effectivePolicyDigest: ctx.effective.policyDigest,
          differences: ctx.differences,
          relaxations: ctx.relaxations,
          warnings: ctx.warnings,
        };
      }

      case 'get_execution_matrix': {
        const planPath = typeof args.plan_path === 'string' ? args.plan_path : '.aeg/plans/current.json';
        const absPlan = path.resolve(cwd, planPath);
        if (!fs.existsSync(absPlan)) throw new Error(`Plan file not found: ${absPlan}`);
        const plan = JSON.parse(fs.readFileSync(absPlan, 'utf8')) as TestPlan;
        const bundle = loadWorkingTreeConfig(cwd);
        return buildExecutionMatrix({
          plan,
          tests: bundle.tests,
          executors: (args.executors as ExecutorDescriptor[]) ?? [],
        });
      }

      case 'register_execution_result': {
        const agg = this.getOrCreateAggregator({
          cwd,
          planPath: typeof args.plan_path === 'string' ? args.plan_path : undefined,
          signingSecret: typeof args.signing_secret === 'string' ? args.signing_secret : undefined,
        });
        return agg.register(args.receipt as TestResultReceipt);
      }

      case 'get_platform_coverage': {
        const agg = this.getOrCreateAggregator({
          cwd,
          planPath: typeof args.plan_path === 'string' ? args.plan_path : undefined,
        });
        return { coverage: agg.getPlatformCoverage() };
      }

      case 'aggregate_gate_results': {
        const agg = this.getOrCreateAggregator({
          cwd,
          planPath: typeof args.plan_path === 'string' ? args.plan_path : undefined,
          policy,
          signingSecret: typeof args.signing_secret === 'string' ? args.signing_secret : undefined,
        });
        return agg.aggregate();
      }

      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  async handleJsonRpc(request: {
    jsonrpc?: string;
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const { id, method, params } = request;

    // Notifications (no id) require no response
    if (method === 'notifications/initialized' || (id === undefined && method.startsWith('notifications/'))) {
      return null;
    }

    try {
      if (method === 'initialize') {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
        const protocolVersion = SUPPORTED_MCP_PROTOCOLS.has(requested) ? requested : '2024-11-05';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: {
              name: 'ai-engineering-guard',
              version: AEG_VERSION,
            },
          },
        };
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'resources/list') {
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      }

      if (method === 'prompts/list') {
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: MCP_TOOLS },
        };
      }

      if (method === 'tools/call') {
        const toolName = String(params?.name ?? '');
        const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};
        try {
          const data = await this.callTool(toolName, toolArgs);
          const structured =
            data !== null && typeof data === 'object' && !Array.isArray(data)
              ? (data as Record<string, unknown>)
              : { value: data };
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
              structuredContent: structured,
              isError: false,
            },
          };
        } catch (toolErr: unknown) {
          const errObj = {
            error: toolErr instanceof Error ? toolErr.message : String(toolErr),
          };
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(errObj) }],
              structuredContent: errObj,
              isError: true,
            },
          };
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err: unknown) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

/**
 * Dual-framing stdio MCP transport:
 * Auto-detects both newline-delimited JSON-RPC (Gemini/Codex/Claude SDKs)
 * AND LSP-style `Content-Length: <bytes>\r\n\r\n<json>` framing (Python/DeepSeek bridges),
 * replying in the exact framing style used by the caller.
 */
export function startStdioMcpServer(): void {
  const session = new AegMcpSession();
  let rawBuf = Buffer.alloc(0);
  let framing: 'unknown' | 'ndjson' | 'content-length' = 'unknown';

  const sendResponse = (response: Record<string, unknown>) => {
    const json = JSON.stringify(response);
    if (framing === 'content-length') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  };

  const dispatchMessage = async (jsonText: string) => {
    try {
      const msg = JSON.parse(jsonText);
      const response = await session.handleJsonRpc(msg);
      if (response) sendResponse(response);
    } catch (err: unknown) {
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  };

  const drainBuffer = () => {
    while (rawBuf.length > 0) {
      if (framing === 'unknown') {
        const preview = rawBuf.subarray(0, 64).toString('utf8').trimStart();
        if (!preview) {
          rawBuf = Buffer.alloc(0);
          return;
        }
        if (/^Content-Length:/i.test(preview)) {
          framing = 'content-length';
        } else if (preview.startsWith('{') || preview.startsWith('[')) {
          framing = 'ndjson';
        } else if (rawBuf.length < 64) {
          return;
        } else {
          framing = 'ndjson';
        }
      }

      if (framing === 'content-length') {
        const sepIdx = rawBuf.indexOf('\r\n\r\n');
        const altSepIdx = sepIdx === -1 ? rawBuf.indexOf('\n\n') : -1;
        const headerEnd = sepIdx !== -1 ? sepIdx : altSepIdx;
        const sepLen = sepIdx !== -1 ? 4 : 2;
        if (headerEnd === -1) return;

        const headerText = rawBuf.subarray(0, headerEnd).toString('utf8');
        const match = /Content-Length:\s*(\d+)/i.exec(headerText);
        if (!match) {
          rawBuf = rawBuf.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(match[1]);
        const bodyStart = headerEnd + sepLen;
        if (rawBuf.length < bodyStart + contentLen) return;

        const body = rawBuf.subarray(bodyStart, bodyStart + contentLen).toString('utf8');
        rawBuf = rawBuf.subarray(bodyStart + contentLen);
        void dispatchMessage(body);
      } else {
        const nlIdx = rawBuf.indexOf('\n');
        if (nlIdx === -1) return;
        const line = rawBuf.subarray(0, nlIdx).toString('utf8').trim();
        rawBuf = rawBuf.subarray(nlIdx + 1);
        if (line) {
          void dispatchMessage(line);
        }
      }
    }
  };

  process.stdin.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    rawBuf = Buffer.concat([rawBuf, buf]);
    drainBuffer();
  });

  process.stdin.on('end', () => {
    const leftover = rawBuf.toString('utf8').trim();
    if (leftover && framing !== 'content-length') {
      void dispatchMessage(leftover);
    }
  });
}
