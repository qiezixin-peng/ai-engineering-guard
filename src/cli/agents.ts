import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../config/schema-validator.js';

export type AgentTarget = 'codex' | 'gemini' | 'deepseek' | 'claude' | 'all';

export interface AgentConfigBundle {
  aegCliPath: string;
  aegMcpPath: string;
  codex?: {
    configTomlPathHint: string;
    mcpTomlSnippet: string;
    repoInstructionFile: string;
    instructionMarkdown: string;
  };
  gemini?: {
    settingsJsonPathHint: string;
    mcpJsonSnippet: Record<string, unknown>;
    repoInstructionFile: string;
    instructionMarkdown: string;
  };
  deepseek?: {
    mcpJsonSnippet: Record<string, unknown>;
    toolsSchemaPath: string;
    nodeDispatcherPath: string;
    pythonDispatcherPath: string;
    systemPromptPath: string;
  };
  claude?: {
    cliAddCommand: string;
    repoInstructionFile: string;
    instructionMarkdown: string;
  };
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

export function generateAgentConfigBundle(agent: AgentTarget = 'all'): AgentConfigBundle {
  const aegCliPath = toForwardSlash(path.join(PACKAGE_ROOT, 'bin', 'aeg.js'));
  const aegMcpPath = toForwardSlash(path.join(PACKAGE_ROOT, 'bin', 'aeg-mcp.js'));

  const sharedInstructionBlock = [
    '<!-- AEG:START -->',
    '## AI Engineering Guard (`aeg`) — Built-in Quality & Handoff Protocol',
    '',
    '### 1. On Starting Work (Relay / Handoff Pickup)',
    '- Read `.engineering-guard/modules.yaml`, `.engineering-guard/tests.yaml` (and `HANDOFF.md` / `.env.example` if present) to understand module boundaries, dependencies, public APIs, and required env vars.',
    '- Verify the current baseline state before major edits if needed (`aeg check --format agent-summary` or `node "' + aegCliPath + '" check --format agent-summary`).',
    '',
    '### 2. During Development (Keep Project Map Synced)',
    '- Whenever you add or restructure modules, cross-module imports, public interfaces, tests, or environment variables, update `.engineering-guard/modules.yaml` (`paths`, `depends_on`, `public_api_paths`, `contracts`), `.engineering-guard/tests.yaml` (`covers`, `environment_allowlist`), and `.env.example` / `HANDOFF.md` (if used) so the next agent or merge step has accurate metadata.',
    '- NEVER edit `.engineering-guard/*.yaml` to delete existing suites, lower risk overrides, or weaken gates.',
    '',
    '### 3. Before Finishing / Handing Off (Mandatory Gate)',
    `- Always run \`node "${aegCliPath}" check --format agent-summary\` (or \`aeg.cmd check --format agent-summary\` on Windows) and resolve failures before concluding:`,
    '- For PR/delivery checks: `--mode deep --policy delivery --format agent-summary`.',
    '- `0` (`passed` + `continue`): safe to finish; include a brief handoff note (what changed, any new env vars, next TODOs).',
    '- `0` (`passed` + `require_approval`): tests passed, but L4/policy change requires human approval — stop and ask.',
    '- `1` / `2` (`failed`): inspect failures via `aeg inspect failure --format json` and `aeg inspect log <id> --lines 80`, then fix.',
    '- `3` (`CONFIG_ERROR`): fix `.engineering-guard/*.yaml` (`aeg config validate`).',
    '- `5` (`incomplete`): do NOT treat as passed; resolve unknowns, missing coverage, or blocked platforms.',
    '<!-- AEG:END -->',
  ].join('\n');

  const mcpServerEntry = {
    command: 'node',
    args: [aegMcpPath],
  };

  const bundle: AgentConfigBundle = {
    aegCliPath,
    aegMcpPath,
  };

  if (agent === 'codex' || agent === 'all') {
    bundle.codex = {
      configTomlPathHint: '~/.codex/config.toml',
      mcpTomlSnippet: [
        '[mcp_servers.ai-engineering-guard]',
        'command = "node"',
        `args = ["${aegMcpPath}"]`,
      ].join('\n'),
      repoInstructionFile: 'AGENTS.md',
      instructionMarkdown: sharedInstructionBlock,
    };
  }

  if (agent === 'gemini' || agent === 'all') {
    bundle.gemini = {
      settingsJsonPathHint: '~/.gemini/settings.json (or Antigravity MCP config)',
      mcpJsonSnippet: {
        mcpServers: {
          'ai-engineering-guard': mcpServerEntry,
        },
      },
      repoInstructionFile: 'GEMINI.md',
      instructionMarkdown: sharedInstructionBlock,
    };
  }

  if (agent === 'deepseek' || agent === 'all') {
    bundle.deepseek = {
      mcpJsonSnippet: {
        mcpServers: {
          'ai-engineering-guard': mcpServerEntry,
        },
      },
      toolsSchemaPath: toForwardSlash(path.join(PACKAGE_ROOT, 'integrations/agents/deepseek/tools.json')),
      nodeDispatcherPath: toForwardSlash(path.join(PACKAGE_ROOT, 'integrations/agents/deepseek/tool-dispatcher.mjs')),
      pythonDispatcherPath: toForwardSlash(path.join(PACKAGE_ROOT, 'integrations/agents/deepseek/tool_dispatcher.py')),
      systemPromptPath: toForwardSlash(path.join(PACKAGE_ROOT, 'integrations/agents/deepseek/system-prompt.md')),
    };
  }

  if (agent === 'claude' || agent === 'all') {
    bundle.claude = {
      cliAddCommand: `claude mcp add ai-engineering-guard -- node "${aegMcpPath}"`,
      repoInstructionFile: 'CLAUDE.md',
      instructionMarkdown: sharedInstructionBlock,
    };
  }

  return bundle;
}

export interface AgentInstallResult {
  workspaceRoot: string;
  updatedFiles: string[];
  unchangedFiles: string[];
}

const START_MARKER = '<!-- AEG:START -->';
const END_MARKER = '<!-- AEG:END -->';

/**
 * Idempotently installs or updates AEG instructions inside AGENTS.md (Codex/DeepSeek),
 * GEMINI.md (Gemini/Antigravity), and CLAUDE.md (Claude Code) in a target repository.
 */
export function installRepoAgentInstructions(params: {
  workspaceRoot: string;
  files?: string[];
}): AgentInstallResult {
  const root = path.resolve(params.workspaceRoot);
  const targets = params.files ?? ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md'];
  const block = generateAgentConfigBundle('codex').codex!.instructionMarkdown;
  const updatedFiles: string[] = [];
  const unchangedFiles: string[] = [];

  for (const filename of targets) {
    const absPath = path.join(root, filename);
    if (!fs.existsSync(absPath)) {
      fs.writeFileSync(absPath, `# ${filename}\n\n${block}\n`, 'utf8');
      updatedFiles.push(absPath);
      continue;
    }

    const existing = fs.readFileSync(absPath, 'utf8');
    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);
    let nextContent: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      nextContent =
        existing.slice(0, startIdx) +
        block +
        existing.slice(endIdx + END_MARKER.length);
    } else {
      const sep = existing.endsWith('\n') || existing.length === 0 ? '\n' : '\n\n';
      nextContent = `${existing}${sep}${block}\n`;
    }

    if (nextContent === existing) {
      unchangedFiles.push(absPath);
    } else {
      fs.writeFileSync(absPath, nextContent, 'utf8');
      updatedFiles.push(absPath);
    }
  }

  return { workspaceRoot: root, updatedFiles, unchangedFiles };
}

export function formatAgentConfigText(bundle: AgentConfigBundle): string {
  const lines: string[] = [];
  lines.push('AI Engineering Guard — Universal Multi-Agent Configuration');
  lines.push(`  CLI: node "${bundle.aegCliPath}"`);
  lines.push(`  MCP: node "${bundle.aegMcpPath}"`);

  if (bundle.codex) {
    lines.push('');
    lines.push(`=== OpenAI Codex (${bundle.codex.configTomlPathHint}) ===`);
    lines.push(bundle.codex.mcpTomlSnippet);
  }
  if (bundle.gemini) {
    lines.push('');
    lines.push(`=== Google Gemini / Antigravity (${bundle.gemini.settingsJsonPathHint}) ===`);
    lines.push(JSON.stringify(bundle.gemini.mcpJsonSnippet, null, 2));
  }
  if (bundle.deepseek) {
    lines.push('');
    lines.push('=== DeepSeek (OpenAI Function Calling + MCP) ===');
    lines.push(`  Tools JSON:        ${bundle.deepseek.toolsSchemaPath}`);
    lines.push(`  Node Dispatcher:   ${bundle.deepseek.nodeDispatcherPath}`);
    lines.push(`  Python Dispatcher: ${bundle.deepseek.pythonDispatcherPath}`);
    lines.push(`  System Prompt:     ${bundle.deepseek.systemPromptPath}`);
    lines.push('  MCP JSON:');
    lines.push(JSON.stringify(bundle.deepseek.mcpJsonSnippet, null, 2));
  }
  if (bundle.claude) {
    lines.push('');
    lines.push('=== Claude Code ===');
    lines.push(`  ${bundle.claude.cliAddCommand}`);
  }
  return lines.join('\n');
}
