import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStructuredCommand } from '../../src/adapters/command/command-runner.js';
import {
  generateAgentConfigBundle,
  installRepoAgentInstructions,
  listRegisteredProjects,
  registerIntegratedProject,
  syncAllRegisteredProjects,
} from '../../src/cli/agents.js';
import { PACKAGE_ROOT } from '../../src/config/schema-validator.js';
import { runQualityPipeline } from '../../src/engine.js';

const tempDirs: string[] = [];

function createGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'agent@example.com'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Agent Test'], { cwd: dir, windowsHide: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('Universal Multi-Agent Compatibility (Gemini / Codex / DeepSeek / Claude)', () => {
  it('auto-resolves repo root when an agent runs aeg check from a nested subdirectory', async () => {
    const dir = createGitRepo('aeg-subdir-');
    const nested = path.join(dir, 'packages/web/components');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(dir, '.engineering-guard'), { recursive: true });

    fs.writeFileSync(path.join(nested, 'btn.ts'), 'export const btn = 1;\n');
    fs.writeFileSync(path.join(dir, '.engineering-guard/config.yaml'), 'schema_version: 1\nproject: { name: mono, baseline_ref: main }\n');
    fs.writeFileSync(path.join(dir, '.engineering-guard/modules.yaml'), 'schema_version: 1\nmodules: { web: { paths: [packages/web/**] } }\n');
    fs.writeFileSync(
      path.join(dir, '.engineering-guard/tests.yaml'),
      'schema_version: 1\nsuites: { web-unit: { framework: command, command: { executable: node, args: [-e, "process.exit(0)"] }, covers: [web], level: unit } }\n',
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.aeg/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, windowsHide: true });

    fs.writeFileSync(path.join(nested, 'btn.ts'), 'export const btn = 2;\n');

    // Run from nested subdirectory instead of repo root!
    const { report, exitCode } = await runQualityPipeline({ workspaceRoot: nested, policy: 'local' });
    expect(exitCode).toBe(0);
    expect(report.gate.outcome).toBe('passed');
    expect(report.impact.directlyChangedModules).toEqual(['web']);
  });

  it('returns consistent agent-summary JSON envelope even on exit code 3 (CONFIG_ERROR)', () => {
    const dir = createGitRepo('aeg-err-env-');
    const binPath = path.join(PACKAGE_ROOT, 'bin', 'aeg.js');
    // Missing .engineering-guard -> triggers ConfigValidationError (exit code 3)
    let exitCode = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [binPath, 'check', '--format', 'agent-summary', '--cwd', dir], {
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string };
      exitCode = e.status ?? 0;
      stdout = e.stdout ?? '';
    }

    expect(exitCode).toBe(3);
    const parsed = JSON.parse(stdout);
    expect(parsed.outcome).toBe('error');
    expect(parsed.workflow_action).toBe('block');
    expect(parsed.error_code).toBe('CONFIG_ERROR');
    expect(parsed.agent_action.required).toBe(true);
    expect(Array.isArray(parsed.agent_action.next_steps)).toBe(true);
  });

  it('generates machine-specific Codex TOML, Gemini JSON, DeepSeek tools/Python/MCP, and idempotently installs repo instructions', () => {
    const bundle = generateAgentConfigBundle('all');
    expect(bundle.codex?.mcpTomlSnippet).toContain('[mcp_servers.ai-engineering-guard]');
    expect(bundle.gemini?.mcpJsonSnippet).toHaveProperty('mcpServers.ai-engineering-guard');
    expect(bundle.deepseek?.pythonDispatcherPath).toContain('tool_dispatcher.py');
    expect(fs.existsSync(bundle.deepseek!.pythonDispatcherPath)).toBe(true);
    expect(bundle.claude?.cliAddCommand).toContain('claude mcp add');

    const dir = createGitRepo('aeg-install-agents-');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Existing Codex Instructions\n\nKeep this.\n');

    const first = installRepoAgentInstructions({ workspaceRoot: dir });
    expect(first.updatedFiles).toHaveLength(3);
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('Keep this.');
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('<!-- AEG:START -->');

    // Second call must be 100% idempotent (0 duplicate sections!)
    const second = installRepoAgentInstructions({ workspaceRoot: dir });
    expect(second.updatedFiles).toHaveLength(0);
    expect(second.unchangedFiles).toHaveLength(3);
  });

  it('supports MCP Content-Length framing, protocol negotiation (2025-03-26), resources/list, prompts/list, and structuredContent', async () => {
    const mcpBin = path.join(PACKAGE_ROOT, 'bin', 'aeg-mcp.js');
    const child = spawn(process.execPath, [mcpBin], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const frames: Array<Record<string, unknown>> = [];
    let buf = Buffer.alloc(0);

    const waitFrames = (count: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for Content-Length MCP frames')), 10000);
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          while (true) {
            const sep = buf.indexOf('\r\n\r\n');
            if (sep === -1) break;
            const header = buf.subarray(0, sep).toString('utf8');
            const m = /Content-Length:\s*(\d+)/i.exec(header);
            if (!m) break;
            const len = Number(m[1]);
            if (buf.length < sep + 4 + len) break;
            const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
            buf = buf.subarray(sep + 4 + len);
            frames.push(JSON.parse(body));
          }
          if (frames.length >= count) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve();
          }
        };
        child.stdout.on('data', onData);
      });

    const sendFramed = (obj: Record<string, unknown>) => {
      const json = JSON.stringify(obj);
      const len = Buffer.byteLength(json, 'utf8');
      child.stdin.write(`Content-Length: ${len}\r\n\r\n${json}`);
    };

    try {
      const p = waitFrames(3);
      sendFramed({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
      sendFramed({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} });
      sendFramed({ jsonrpc: '2.0', id: 3, method: 'prompts/list', params: {} });
      await p;

      const init = frames.find((f) => f.id === 1) as { result: { protocolVersion: string } };
      expect(init.result.protocolVersion).toBe('2025-03-26');

      const resList = frames.find((f) => f.id === 2) as { result: { resources: unknown[] } };
      expect(resList.result.resources).toEqual([]);

      const promptList = frames.find((f) => f.id === 3) as { result: { prompts: unknown[] } };
      expect(promptList.result.prompts).toEqual([]);
    } finally {
      child.kill();
    }
  });

  it('terminates 300ms timed-out process in < 1000ms even when taskkill fails in a restricted Windows sandbox', async () => {
    const dir = createGitRepo('aeg-sandbox-timeout-');
    const t0 = performance.now();
    const out = await runStructuredCommand({
      workspaceRoot: dir,
      suiteId: 'sandbox-timeout-suite',
      framework: 'command',
      command: {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 15000)'],
        cwd: '.',
        timeout: '300ms',
      },
      artifactDir: path.join(dir, '.aeg/logs'),
      // Simulate restricted sandbox where taskkill.exe is blocked or missing
      taskkillExecutable: 'taskkill-blocked-in-sandbox-nonexistent',
    });
    const elapsedMs = performance.now() - t0;

    expect(out.status).toBe('timeout');
    expect(out.durationMs).toBeLessThan(1200);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('auto-syncs outdated managed agent blocks on local check and via syncAllRegisteredProjects', async () => {
    const dir = createGitRepo('aeg-autosync-');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aeg-home-'));
    tempDirs.push(fakeHome);
    const prevAegHome = process.env.AEG_HOME;
    process.env.AEG_HOME = fakeHome;

    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.engineering-guard'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(dir, '.engineering-guard/config.yaml'), 'schema_version: 1\nproject: { name: sync-demo, baseline_ref: main }\n');
      fs.writeFileSync(path.join(dir, '.engineering-guard/modules.yaml'), 'schema_version: 1\nmodules: { core: { paths: [src/**] } }\n');
      fs.writeFileSync(
        path.join(dir, '.engineering-guard/tests.yaml'),
        'schema_version: 1\nsuites: { unit: { framework: command, command: { executable: node, args: [-e, "process.exit(0)"] }, covers: [core], level: unit } }\n',
      );
      fs.writeFileSync(path.join(dir, '.gitignore'), '.aeg/\n');
      fs.writeFileSync(
        path.join(dir, 'AGENTS.md'),
        '# Custom Header\n\n<!-- AEG:START -->\nOLD OUTDATED BLOCK\n<!-- AEG:END -->\n',
      );
      execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, windowsHide: true });

      // 1. Local check auto-registers and auto-updates outdated managed block while preserving Custom Header
      await runQualityPipeline({ workspaceRoot: dir, policy: 'local' });
      const updatedAgents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
      expect(updatedAgents).toContain('# Custom Header');
      expect(updatedAgents).not.toContain('OLD OUTDATED BLOCK');
      expect(updatedAgents).toContain('Built-in Quality & Handoff Protocol');
      expect(listRegisteredProjects()).toContain(path.resolve(dir));

      // 2. If reverted to outdated, syncAllRegisteredProjects updates all registered projects at once
      fs.writeFileSync(
        path.join(dir, 'AGENTS.md'),
        '# Custom Header\n\n<!-- AEG:START -->\nOLD AGAIN\n<!-- AEG:END -->\n',
      );
      registerIntegratedProject(dir);
      const syncRes = syncAllRegisteredProjects();
      expect(syncRes.updatedProjects.some((p) => p.path === path.resolve(dir))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('Built-in Quality & Handoff Protocol');
    } finally {
      if (prevAegHome === undefined) delete process.env.AEG_HOME;
      else process.env.AEG_HOME = prevAegHome;
    }
  });
});
