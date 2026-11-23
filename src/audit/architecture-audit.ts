import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { detectGraphCycles } from '../config/schema-validator.js';
import { normalizePosixPath } from '../domain/hash.js';
import type {
  AegConfig,
  ArchitectureAuditResult,
  ArchitectureFinding,
  ModulesConfig,
} from '../domain/types.js';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.vue', '.svelte']);
const FRONTEND_EXTS = new Set(['.tsx', '.jsx', '.vue', '.svelte']);
const TEST_FILE_MATCHER = picomatch(
  ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'tests/**', 'test/**', '**/test_*.py', '**/*_test.py'],
  { dot: true },
);
const SKIP_DIRS = new Set(['node_modules', '.git', '.aeg', 'dist', 'build', 'coverage', '.venv', '__pycache__']);

const REL_IMPORT_RE =
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;
const EXPORT_RE =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum)\b/g;

export interface AuditOptions {
  workspaceRoot: string;
  config: AegConfig;
  modules: ModulesConfig;
  scope: 'incremental' | 'full';
  targetFiles?: string[];
  maxFiles?: number;
}

export function detectExternalArchitectureTools(workspaceRoot: string): string[] {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const candidates = [
      ['@biomejs/biome', 'biome'],
      ['eslint', 'eslint'],
      ['eslint-plugin-boundaries', 'eslint-plugin-boundaries'],
      ['dependency-cruiser', 'dependency-cruiser'],
      ['knip', 'knip'],
    ] as const;
    return candidates.filter(([pkgName]) => Boolean(deps[pkgName])).map(([, label]) => label);
  } catch {
    return [];
  }
}

export function runArchitectureAudit(options: AuditOptions): ArchitectureAuditResult {
  const { workspaceRoot, config, modules, scope } = options;
  const archCfg = config.architecture ?? {};
  const maxFileLines = archCfg.max_file_lines ?? 450;
  const maxExports = archCfg.max_exports_per_file ?? 18;
  const checkFrontend = archCfg.rules?.frontend_antipatterns !== false;
  const checkBackend = archCfg.rules?.backend_antipatterns !== false;
  const forbidUndeclared = archCfg.forbid_undeclared_imports === true;
  const forbidCycles = archCfg.forbid_cycles !== false;

  const findings: ArchitectureFinding[] = [];
  const externalToolsDetected = detectExternalArchitectureTools(workspaceRoot);

  // 1. Module dependency graph cycle check
  if (forbidCycles) {
    const cycles = detectGraphCycles(
      Object.fromEntries(Object.entries(modules.modules).map(([id, def]) => [id, def.depends_on ?? []])),
    );
    for (const cycle of cycles) {
      findings.push({
        ruleId: 'arch/module-cycle',
        severity: 'error',
        category: 'boundary',
        file: '.engineering-guard/modules.yaml',
        message: `Circular module dependency detected: ${cycle.join(' -> ')}`,
        betterApproach:
          'Extract shared types/utilities into a lower-level module (e.g. shared/domain) to restore a strict DAG.',
      });
    }
  }

  // 2. Collect candidate source files (skipping tests & generated build output)
  const ignoreMatcher =
    config.analysis?.ignore_paths && config.analysis.ignore_paths.length > 0
      ? picomatch(config.analysis.ignore_paths, { dot: true })
      : () => false;

  const filesToScan =
    scope === 'incremental'
      ? (options.targetFiles ?? []).filter((f) => isAuditableSourceFile(f, ignoreMatcher))
      : collectAllSourceFiles(workspaceRoot, options.maxFiles ?? 600, ignoreMatcher);

  const moduleMatchers = Object.entries(modules.modules).map(([id, def]) => ({
    id,
    dependsOn: new Set(def.depends_on ?? []),
    match: picomatch(def.paths, { dot: true }),
  }));

  const findModule = (posixPath: string) => moduleMatchers.find((m) => m.match(posixPath));

  for (const relPath of filesToScan) {
    const absPath = path.join(workspaceRoot, relPath);
    if (!fs.existsSync(absPath)) continue;

    let content: string;
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile() || stat.size > 512 * 1024) continue;
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);

    // 2a. Oversized / God file check
    if (lines.length > maxFileLines) {
      findings.push({
        ruleId: 'arch/oversized-file',
        severity: 'warning',
        category: 'bloat',
        file: relPath,
        line: lines.length,
        message: `File has ${lines.length} lines (threshold: ${maxFileLines}); growing into a monolithic file.`,
        betterApproach:
          'Split into cohesive single-responsibility modules/components (e.g. separate state/hooks, domain logic, and presentation/routes).',
      });
    }

    // 2b. Too many exports in a single file
    const exportMatches = content.match(EXPORT_RE);
    if (exportMatches && exportMatches.length > maxExports) {
      findings.push({
        ruleId: 'arch/god-module-exports',
        severity: 'warning',
        category: 'bloat',
        file: relPath,
        message: `File exports ${exportMatches.length} symbols (threshold: ${maxExports}); indicates mixed responsibilities.`,
        betterApproach:
          'Decompose into focused submodules by feature or layer instead of dumping helpers into one barrel/god file.',
      });
    }

    // 2c. Cross-module import boundary check
    const sourceMod = findModule(relPath);
    if (sourceMod && /\.(?:ts|tsx|mts|js|jsx|mjs|cjs)$/i.test(relPath)) {
      REL_IMPORT_RE.lastIndex = 0;
      let imp: RegExpExecArray | null;
      while ((imp = REL_IMPORT_RE.exec(content)) !== null) {
        const spec = imp[1] ?? imp[2] ?? imp[3];
        if (!spec || !spec.startsWith('.')) continue;
        const resolved = normalizePosixPath(path.posix.normalize(path.posix.join(path.posix.dirname(relPath), spec)));
        const targetMod =
          findModule(resolved) ??
          findModule(`${resolved}.ts`) ??
          findModule(`${resolved}.tsx`) ??
          findModule(`${resolved}.js`) ??
          findModule(`${resolved}/index.ts`);
        if (targetMod && targetMod.id !== sourceMod.id && !sourceMod.dependsOn.has(targetMod.id)) {
          findings.push({
            ruleId: 'arch/undeclared-cross-module-import',
            severity: forbidUndeclared ? 'error' : 'warning',
            category: 'boundary',
            file: relPath,
            line: lineAt(content, imp.index),
            message: `Module '${sourceMod.id}' imports '${targetMod.id}' ('${spec}') without declaring it in modules.yaml.`,
            betterApproach:
              `Either invert/decouple the dependency via a shared interface/event, or explicitly declare '${targetMod.id}' in modules.${sourceMod.id}.depends_on if intentional.`,
          });
        }
      }
    }

    // 2d. Frontend anti-patterns (aligned with Web Frontend Handbook)
    const ext = path.posix.extname(relPath).toLowerCase();
    if (checkFrontend && FRONTEND_EXTS.has(ext)) {
      scanFrontendAntipatterns(relPath, content, findings);
    }

    // 2e. Backend / general maintainability anti-patterns
    if (checkBackend && !FRONTEND_EXTS.has(ext)) {
      scanBackendAntipatterns(relPath, content, findings);
    }
  }

  // Cap findings in incremental mode to protect agent context
  const capped = scope === 'incremental' ? findings.slice(0, 12) : findings.slice(0, 100);
  return {
    scope,
    scannedFiles: filesToScan.length,
    findings: capped,
    externalToolsDetected,
    summary: {
      errors: capped.filter((f) => f.severity === 'error').length,
      warnings: capped.filter((f) => f.severity === 'warning').length,
      info: capped.filter((f) => f.severity === 'info').length,
    },
    handbookRefs: archCfg.handbook_refs ?? [],
  };
}

function scanFrontendAntipatterns(
  relPath: string,
  content: string,
  findings: ArchitectureFinding[],
): void {
  const domMatch = /\bdocument\.(?:querySelector|querySelectorAll|getElementById)\b|\.innerHTML\s*=/.exec(content);
  if (domMatch) {
    findings.push({
      ruleId: 'frontend/imperative-dom-in-component',
      severity: 'warning',
      category: 'frontend',
      file: relPath,
      line: lineAt(content, domMatch.index),
      message: `Imperative DOM manipulation ('${domMatch[0]}') detected inside a declarative component file.`,
      betterApproach:
        'Replace querySelector/innerHTML with declarative component state, JSX rendering, or framework refs (useRef).',
    });
  }

  const listenerMatch = /\baddEventListener\s*\(/.exec(content);
  if (listenerMatch && !/\bremoveEventListener\b|\bAbortController\b|\bsignal\s*:/.test(content)) {
    findings.push({
      ruleId: 'frontend/uncleaned-event-listener',
      severity: 'warning',
      category: 'frontend',
      file: relPath,
      line: lineAt(content, listenerMatch.index),
      message: `Manual 'addEventListener' without matching 'removeEventListener' or 'AbortController' cleanup.`,
      betterApproach:
        'Use declarative JSX event props (onClick/onChange) or clean up listeners in useEffect cleanup / AbortController.',
    });
  }

  const fetchMatch = /\bfetch\s*\(/.exec(content);
  if (fetchMatch && !/\bAbortController\b|\bsignal\b|useQuery|createQuery/.test(content)) {
    findings.push({
      ruleId: 'frontend/raw-fetch-no-cancellation',
      severity: 'info',
      category: 'frontend',
      file: relPath,
      line: lineAt(content, fetchMatch.index),
      message: `Raw 'fetch()' in UI component without AbortController cancellation or query-cache layer.`,
      betterApproach:
        'Consider passing an AbortController signal in effect cleanup or adopting a query layer (e.g. TanStack Query) to avoid race conditions.',
    });
  }
}

function scanBackendAntipatterns(
  relPath: string,
  content: string,
  findings: ArchitectureFinding[],
): void {
  const sqlInterp = /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^\n`]*\$\{[^}]+\}/i.exec(content);
  if (sqlInterp) {
    findings.push({
      ruleId: 'backend/sql-string-interpolation',
      severity: 'error',
      category: 'backend',
      file: relPath,
      line: lineAt(content, sqlInterp.index),
      message: `Potential SQL string interpolation detected ('${sqlInterp[0].slice(0, 60)}...').`,
      betterApproach:
        'Use parameterized queries / prepared statements or a typed query builder instead of template interpolation.',
    });
  }

  const serverFetch = /\bfetch\s*\(/.exec(content);
  if (serverFetch && !/\bsignal\b|\bAbortController\b|\bAbortSignal\.timeout\b/.test(content)) {
    findings.push({
      ruleId: 'backend/http-call-without-timeout',
      severity: 'info',
      category: 'backend',
      file: relPath,
      line: lineAt(content, serverFetch.index),
      message: `Outbound 'fetch()' without explicit AbortSignal.timeout / cancellation signal.`,
      betterApproach:
        'Pass `signal: AbortSignal.timeout(...)` or wrap in a shared HTTP client with bounded retries and timeouts.',
    });
  }
}

function isAuditableSourceFile(posixPath: string, ignoreMatcher: (p: string) => boolean): boolean {
  if (ignoreMatcher(posixPath)) return false;
  if (TEST_FILE_MATCHER(posixPath)) return false;
  const ext = path.posix.extname(posixPath).toLowerCase();
  return SOURCE_EXTS.has(ext);
}

function collectAllSourceFiles(
  workspaceRoot: string,
  maxFiles: number,
  ignoreMatcher: (p: string) => boolean,
): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.isFile()) {
        const rel = normalizePosixPath(path.relative(workspaceRoot, full));
        if (isAuditableSourceFile(rel, ignoreMatcher)) {
          results.push(rel);
        }
      }
    }
  };
  walk(workspaceRoot);
  return results.sort();
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}
