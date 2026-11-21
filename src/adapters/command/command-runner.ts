import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isSubpath, parseDurationMs, sha256 } from '../../domain/hash.js';
import type { FailureDetail, StructuredCommand, TestFramework } from '../../domain/types.js';

const BASELINE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'WINDIR',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|token|password|passwd|authorization|bearer)\s*[:=]\s*['"]?[A-Za-z0-9._\-/+]{8,}['"]?/gi,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
];

export function redactSensitiveText(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

export interface CommandRunOptions {
  workspaceRoot: string;
  suiteId: string;
  framework: TestFramework;
  command: StructuredCommand;
  artifactDir: string;
  maxExcerptBytes?: number;
  maxLogBytes?: number;
  signal?: AbortSignal;
}

export interface CommandExecutionOutput {
  status: 'passed' | 'failed' | 'error' | 'timeout' | 'cancelled';
  exitCode?: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  outputDigest: string;
  logArtifactPath: string;
  failureDetails: FailureDetail[];
}

export function buildSanitizedEnv(allowlist: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set([...BASELINE_ENV_KEYS, ...allowlist]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (allowed.has(key) || (process.platform === 'win32' && allowed.has(key.toUpperCase()))) {
      env[key] = value;
    }
  }
  return env;
}

export function resolveCommandForPlatform(
  executable: string,
  args: string[],
  shell: boolean,
): { command: string; args: string[]; shell: boolean } {
  if (shell || process.platform !== 'win32') {
    return { command: executable, args, shell };
  }

  const lower = executable.toLowerCase();
  if (lower === 'npm' || lower === 'npm.cmd') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCli)) {
      return { command: process.execPath, args: [npmCli, ...args], shell: false };
    }
  }
  if (lower === 'npx' || lower === 'npx.cmd') {
    const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (fs.existsSync(npxCli)) {
      return { command: process.execPath, args: [npxCli, ...args], shell: false };
    }
  }

  return { command: executable, args, shell: false };
}

export function killProcessTree(pid: number): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already dead
          }
        }
      }, 250).unref();
    }
  } catch {
    // process may have already exited
  }
}

export async function runStructuredCommand(options: CommandRunOptions): Promise<CommandExecutionOutput> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const cwdRel = options.command.cwd ?? '.';
  const resolvedCwd = path.resolve(options.workspaceRoot, cwdRel);

  fs.mkdirSync(options.artifactDir, { recursive: true });
  const logFileName = `${options.suiteId.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`;
  const logArtifactPath = path.join(options.artifactDir, logFileName);

  if (!isSubpath(options.workspaceRoot, resolvedCwd)) {
    const finishedAt = new Date().toISOString();
    const message = `Command cwd escapes workspace boundary: ${cwdRel}`;
    fs.writeFileSync(logArtifactPath, `${message}\n`, 'utf8');
    return {
      status: 'error',
      durationMs: Date.now() - startedMs,
      startedAt,
      finishedAt,
      outputDigest: sha256(message),
      logArtifactPath,
      failureDetails: [
        {
          id: `${options.suiteId}:cwd-escape`,
          suiteId: options.suiteId,
          category: 'spawn_error',
          message,
          excerpt: message,
          artifactRef: logArtifactPath,
        },
      ],
    };
  }

  const timeoutMs = parseDurationMs(options.command.timeout, 10 * 60_000);
  const maxLogBytes = options.maxLogBytes ?? 2 * 1024 * 1024;
  const maxExcerptBytes = options.maxExcerptBytes ?? 16_384;
  const shell = options.command.shell === true;
  const resolved = resolveCommandForPlatform(
    options.command.executable,
    options.command.args ?? [],
    shell,
  );
  const env = buildSanitizedEnv(options.command.environment_allowlist ?? []);

  return new Promise<CommandExecutionOutput>((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let spawnErr: Error | undefined;
    let capturedBytes = 0;
    let truncated = false;
    const chunks: string[] = [];

    const appendChunk = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (capturedBytes >= maxLogBytes) {
        truncated = true;
        return;
      }
      const remaining = maxLogBytes - capturedBytes;
      if (Buffer.byteLength(text, 'utf8') > remaining) {
        chunks.push(text.slice(0, remaining));
        capturedBytes = maxLogBytes;
        truncated = true;
      } else {
        chunks.push(text);
        capturedBytes += Buffer.byteLength(text, 'utf8');
      }
    };

    const child = spawn(resolved.command, resolved.args, {
      cwd: resolvedCwd,
      env,
      shell: resolved.shell,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', appendChunk);
    child.stderr?.on('data', appendChunk);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killProcessTree(child.pid);
      }
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      if (child.pid) {
        killProcessTree(child.pid);
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('error', (err) => {
      spawnErr = err;
      appendChunk(`\n[AEG SPAWN ERROR] ${err.message}\n`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);

      const finishedMs = Date.now();
      const finishedAt = new Date(finishedMs).toISOString();
      const durationMs = finishedMs - startedMs;

      let fullOutput = chunks.join('');
      if (truncated) {
        fullOutput += '\n[AEG] Output truncated due to max log byte budget.\n';
      }
      const redactedOutput = redactSensitiveText(fullOutput);
      fs.writeFileSync(logArtifactPath, redactedOutput, 'utf8');
      const outputDigest = sha256(redactedOutput);

      let status: CommandExecutionOutput['status'];
      if (spawnErr) {
        status = 'error';
      } else if (timedOut) {
        status = 'timeout';
      } else if (cancelled) {
        status = 'cancelled';
      } else if (code === 0) {
        status = 'passed';
      } else {
        status = 'failed';
      }

      const failureDetails: FailureDetail[] =
        status === 'passed'
          ? []
          : extractFailureDetails({
              suiteId: options.suiteId,
              framework: options.framework,
              status,
              exitCode: code ?? undefined,
              output: redactedOutput,
              maxExcerptBytes,
              artifactRef: logArtifactPath,
              spawnError: spawnErr?.message,
            });

      resolve({
        status,
        exitCode: code ?? undefined,
        durationMs,
        startedAt,
        finishedAt,
        outputDigest,
        logArtifactPath,
        failureDetails,
      });
    });
  });
}

function extractFailureDetails(params: {
  suiteId: string;
  framework: TestFramework;
  status: CommandExecutionOutput['status'];
  exitCode?: number;
  output: string;
  maxExcerptBytes: number;
  artifactRef: string;
  spawnError?: string;
}): FailureDetail[] {
  const { suiteId, status, exitCode, output, maxExcerptBytes, artifactRef, spawnError } = params;
  const excerpt = buildBoundedExcerpt(output, maxExcerptBytes);
  const location = extractFirstLocation(output);

  if (status === 'timeout') {
    return [
      {
        id: `${suiteId}:timeout`,
        suiteId,
        category: 'timeout',
        message: `Suite '${suiteId}' timed out and process tree was terminated.`,
        location,
        excerpt,
        artifactRef,
      },
    ];
  }

  if (status === 'cancelled') {
    return [
      {
        id: `${suiteId}:cancelled`,
        suiteId,
        category: 'cancelled',
        message: `Suite '${suiteId}' execution was cancelled.`,
        location,
        excerpt,
        artifactRef,
      },
    ];
  }

  if (status === 'error') {
    return [
      {
        id: `${suiteId}:spawn`,
        suiteId,
        category: 'spawn_error',
        message: spawnError ?? `Failed to start suite '${suiteId}'.`,
        location,
        excerpt,
        artifactRef,
      },
    ];
  }

  const isAssertion =
    /AssertionError|expect\(|Expected:|Received:|FAIL\s+|FAILED\s+/i.test(output);
  const summaryLine = extractHeadline(output) ?? `Suite '${suiteId}' exited with code ${exitCode ?? 'unknown'}.`;

  return [
    {
      id: `${suiteId}:failure-1`,
      suiteId,
      category: isAssertion ? 'assertion' : 'non_zero_exit',
      message: summaryLine,
      location,
      excerpt,
      artifactRef,
    },
  ];
}

function buildBoundedExcerpt(output: string, maxBytes: number): string {
  const trimmed = output.trim();
  if (!trimmed) return '(no output)';
  if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) {
    return trimmed;
  }
  // Keep tail because test failure summaries & stack traces usually appear near the end
  const slice = trimmed.slice(-Math.max(256, Math.floor(maxBytes * 0.9)));
  return `[...truncated, showing tail...]\n${slice}`;
}

function extractFirstLocation(output: string): string | undefined {
  const match = /([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs)):(\d+)(?::(\d+))?/.exec(output);
  if (!match) return undefined;
  return match[3] ? `${match[1]}:${match[2]}:${match[3]}` : `${match[1]}:${match[2]}`;
}

function extractHeadline(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^(FAIL|FAILED|AssertionError|Error:|TypeError:|ReferenceError:|×|✕)/i.test(line)) {
      return line.slice(0, 240);
    }
  }
  return lines.at(-1)?.slice(0, 240);
}
