import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runArchitectureAudit } from '../../src/audit/architecture-audit.js';
import { main } from '../../src/cli/index.js';
import { runQualityPipeline } from '../../src/engine.js';

const tempDirs: string[] = [];

function createGitRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'audit@example.com'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Audit Test'], { cwd: dir, windowsHide: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('Architecture Fitness & Anti-Spaghetti Audit', () => {
  it('detects oversized files, undeclared cross-module imports, frontend DOM anti-patterns, and SQL interpolation', async () => {
    const dir = createGitRepo('aeg-arch-audit-');
    fs.mkdirSync(path.join(dir, 'src/ui'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src/db'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.engineering-guard'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'arch-demo', devDependencies: { eslint: '^9.0.0' } }));
    fs.writeFileSync(
      path.join(dir, '.engineering-guard/config.yaml'),
      `schema_version: 1
project: { name: arch-demo, baseline_ref: main }
architecture:
  enabled: true
  max_file_lines: 50
  forbid_undeclared_imports: true
`,
    );
    fs.writeFileSync(
      path.join(dir, '.engineering-guard/modules.yaml'),
      `schema_version: 1
modules:
  ui: { paths: [src/ui/**], depends_on: [] }
  db: { paths: [src/db/**], depends_on: [] }
`,
    );
    fs.writeFileSync(
      path.join(dir, '.engineering-guard/tests.yaml'),
      `schema_version: 1
suites:
  ui-unit: { framework: command, command: { executable: node, args: [-e, "process.exit(0)"] }, covers: [ui], level: unit }
  db-unit: { framework: command, command: { executable: node, args: [-e, "process.exit(0)"] }, covers: [db], level: unit }
`,
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.aeg/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, windowsHide: true });

    // Create a spaghetti TSX component (imperative DOM + uncleaned listener + undeclared import of db + >50 lines)
    const manyLines = Array.from({ length: 55 }, (_, i) => `// line ${i}`).join('\n');
    fs.writeFileSync(
      path.join(dir, 'src/ui/Player.tsx'),
      `import { queryUser } from '../db/repo';
export function Player() {
  document.querySelector('#app')!.innerHTML = 'bad';
  window.addEventListener('resize', () => {});
  return queryUser('1');
}
${manyLines}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'src/db/repo.ts'),
      `export function queryUser(id: string) { return \`SELECT * FROM users WHERE id = \${id}\`; }\n`,
    );

    // 1. Incremental hints during normal `aeg check`
    const checkRes = await runQualityPipeline({ workspaceRoot: dir, mode: 'balanced', policy: 'local' });
    expect(checkRes.exitCode).toBe(0); // non-blocking by default so hotfixes aren't blocked
    const hints = checkRes.report.agentSummary.architecture_hints ?? [];
    const ruleIds = new Set(hints.map((h) => h.ruleId));
    expect(ruleIds.has('arch/oversized-file')).toBe(true);
    expect(ruleIds.has('arch/undeclared-cross-module-import')).toBe(true);
    expect(ruleIds.has('frontend/imperative-dom-in-component')).toBe(true);
    expect(ruleIds.has('frontend/uncleaned-event-listener')).toBe(true);
    expect(ruleIds.has('backend/sql-string-interpolation')).toBe(true);

    // 2. Full `aeg audit --strict` fails with exit code 2 on error-level architecture violations
    const strictCode = await main(['audit', '--cwd', dir, '--strict', '--format', 'json']);
    expect(strictCode).toBe(2);

    const directAudit = runArchitectureAudit({
      workspaceRoot: dir,
      config: { schema_version: 1, project: { name: 'arch-demo' }, architecture: { max_file_lines: 50, forbid_undeclared_imports: true } },
      modules: { modules: { ui: { paths: ['src/ui/**'] }, db: { paths: ['src/db/**'] } } },
      scope: 'full',
    });
    expect(directAudit.externalToolsDetected).toContain('eslint');
  });
});
