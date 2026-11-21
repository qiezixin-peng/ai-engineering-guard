import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AEG_BIN = path.resolve(__dirname, '..', '..', '..', 'bin', 'aeg.js');

/**
 * Universal OpenAI/DeepSeek/Codex/Gemini tool-call dispatcher for AEG.
 * Executes AEG via structured `execFileSync(process.execPath, [AEG_BIN, ...args])` (no shell!).
 */
export function dispatchAegToolCall(name, args = {}) {
  const cliArgs = [];
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();

  switch (name) {
    case 'aeg_check':
      cliArgs.push('check', '--format', 'agent-summary', '--cwd', cwd);
      if (args.mode) cliArgs.push('--mode', String(args.mode));
      if (args.policy) cliArgs.push('--policy', String(args.policy));
      if (args.base) cliArgs.push('--base', String(args.base));
      if (args.plan_only) cliArgs.push('--plan-only');
      if (args.no_cache) cliArgs.push('--no-cache');
      break;
    case 'aeg_explain_risk':
      cliArgs.push('explain', 'risk', '--format', 'json', '--cwd', cwd);
      if (args.base) cliArgs.push('--base', String(args.base));
      if (args.mode) cliArgs.push('--mode', String(args.mode));
      break;
    case 'aeg_explain_test':
      cliArgs.push('explain', 'test', String(args.suite_id), '--format', 'json', '--cwd', cwd);
      if (args.base) cliArgs.push('--base', String(args.base));
      break;
    case 'aeg_inspect_failure':
      cliArgs.push('inspect', 'failure');
      if (args.failure_id) cliArgs.push(String(args.failure_id));
      cliArgs.push('--format', 'json', '--cwd', cwd);
      if (args.run_id) cliArgs.push('--run', String(args.run_id));
      break;
    case 'aeg_inspect_log':
      cliArgs.push('inspect', 'log', String(args.failure_id), '--format', 'json', '--cwd', cwd);
      if (args.start_line) cliArgs.push('--start', String(args.start_line));
      if (args.lines) cliArgs.push('--lines', String(args.lines));
      break;
    case 'aeg_config_validate':
      cliArgs.push('config', 'validate', '--format', 'json', '--cwd', cwd);
      break;
    default:
      throw new Error(`Unknown AEG tool call: ${name}`);
  }

  try {
    const stdout = execFileSync(process.execPath, [AEG_BIN, ...cliArgs], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, data: JSON.parse(stdout) };
  } catch (err) {
    const exitCode = typeof err.status === 'number' ? err.status : 4;
    const raw = typeof err.stdout === 'string' && err.stdout.trim() ? err.stdout : err.stderr || err.message;
    try {
      return { exitCode, data: JSON.parse(raw) };
    } catch {
      return { exitCode, data: { error: raw } };
    }
  }
}
