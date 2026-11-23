import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { normalizePosixPath, sha256 } from '../../domain/hash.js';
import {
  AEG_VERSION,
  type AnalysisMode,
  type EvidenceEnvelope,
  type ImpactEvidence,
  type ImpactProvider,
  type ImpactProviderInput,
  type ImpactProviderOutput,
  type SymbolRef,
} from '../../domain/types.js';

const TS_JS_EXPORT_RE =
  /export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]*)/g;
const PY_DEF_RE = /^(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)\s*[\(:]/gm;

export class AstSymbolsProvider implements ImpactProvider {
  readonly id = 'ast-symbols';
  readonly version = AEG_VERSION;
  readonly category = 'symbol_graph' as const;
  readonly supportedModes: AnalysisMode[] = ['deep', 'release'];
  readonly estimatedCostMs = 120;
  readonly priority = 90;

  isAvailable(): boolean {
    return true;
  }

  async analyze(input: ImpactProviderInput): Promise<EvidenceEnvelope<ImpactProviderOutput>> {
    const startMs = Date.now();
    const affectedSymbols: SymbolRef[] = [];
    const affectedContracts = new Set<string>();
    const transitivelyAffected = new Set<string>();
    const evidence: ImpactEvidence[] = [];
    const unknowns: string[] = [];
    const warnings: string[] = [];

    const moduleEntries = Object.entries(input.modules.modules).map(([id, def]) => ({
      id,
      match: picomatch(def.paths, { dot: true }),
    }));
    const findMod = (p: string) => moduleEntries.find((m) => m.match(p))?.id;

    // 1. Collect exported/public symbols from changed files (TS/JS/Python)
    const exportedSymbolNames = new Map<string, { file: string; moduleId?: string }>();
    for (const file of input.changeSet.files) {
      if (file.changeType === 'deleted' || file.binary || file.large) continue;
      const absPath = path.join(input.workspaceRoot, file.path);
      if (!fs.existsSync(absPath)) continue;

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }

      const modId = findMod(file.path);
      const isPy = file.path.endsWith('.py');
      const isTsJs = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(file.path);
      if (!isPy && !isTsJs) continue;

      if (isTsJs) {
        TS_JS_EXPORT_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TS_JS_EXPORT_RE.exec(content)) !== null) {
          const kindRaw = m[1]!;
          const name = m[2]!;
          const line = content.slice(0, m.index).split(/\r?\n/).length;
          const kind: SymbolRef['kind'] =
            kindRaw === 'function' || kindRaw === 'class' || kindRaw === 'interface' || kindRaw === 'type'
              ? kindRaw
              : 'export';
          affectedSymbols.push({ name, kind, file: file.path, line });
          if (name.length >= 3) {
            exportedSymbolNames.set(name, { file: file.path, moduleId: modId });
          }
          if (kind === 'interface' || kind === 'type') {
            affectedContracts.add(`${modId ?? file.path}:${name}`);
          }
        }
      } else if (isPy) {
        PY_DEF_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PY_DEF_RE.exec(content)) !== null) {
          const kindRaw = m[1]!;
          const name = m[2]!;
          if (name.startsWith('_')) continue;
          const line = content.slice(0, m.index).split(/\r?\n/).length;
          affectedSymbols.push({
            name,
            kind: kindRaw === 'class' ? 'class' : 'function',
            file: file.path,
            line,
          });
          if (name.length >= 3) {
            exportedSymbolNames.set(name, { file: file.path, moduleId: modId });
          }
        }
      }
    }

    // 2. Bounded call-site / reference scan across workspace source files (capped for performance budget)
    if (exportedSymbolNames.size > 0) {
      const symbolRegex = new RegExp(
        `\\b(${Array.from(exportedSymbolNames.keys()).slice(0, 40).map(escapeRegExp).join('|')})\\b`,
        'g',
      );
      const workspaceFiles = collectSourceFiles(input.workspaceRoot, 500);
      let evCounter = 0;

      for (const relPath of workspaceFiles) {
        const callerMod = findMod(relPath);
        if (!callerMod) continue;
        let text: string;
        try {
          text = fs.readFileSync(path.join(input.workspaceRoot, relPath), 'utf8');
        } catch {
          continue;
        }

        const matchedNames = new Set<string>();
        symbolRegex.lastIndex = 0;
        let hit: RegExpExecArray | null;
        while ((hit = symbolRegex.exec(text)) !== null) {
          matchedNames.add(hit[1]!);
        }

        for (const symName of matchedNames) {
          const origin = exportedSymbolNames.get(symName);
          if (!origin || origin.file === relPath) continue;
          if (origin.moduleId && origin.moduleId !== callerMod) {
            transitivelyAffected.add(callerMod);
            evidence.push({
              id: `ev-sym-${++evCounter}`,
              providerId: this.id,
              kind: 'import_relation',
              source: `${origin.file}#${symName}`,
              target: callerMod,
              reason: `Symbol '${symName}' exported by '${origin.file}' is referenced in '${relPath}' (module '${callerMod}')`,
              confidence: 0.85,
            });
          }
        }
      }
    }

    return {
      providerId: this.id,
      providerVersion: this.version,
      capability: 'ast_symbol_and_call_chain',
      subjectDigest: sha256(`${input.changeSet.repositoryTreeHash}:ast-symbols`),
      confidence: 0.88,
      cost: { durationMs: Date.now() - startMs },
      freshness: new Date().toISOString(),
      warnings,
      data: {
        directlyChangedModules: [],
        transitivelyAffectedModules: Array.from(transitivelyAffected).sort(),
        affectedSymbols: affectedSymbols.slice(0, 150),
        affectedContracts: Array.from(affectedContracts).sort(),
        affectedDataModels: [],
        unclassifiedFiles: [],
        evidence: evidence.slice(0, 200),
        unknowns,
      },
    };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectSourceFiles(workspaceRoot: string, maxFiles: number): string[] {
  const results: string[] = [];
  const skip = new Set(['node_modules', '.git', '.aeg', 'dist', 'build', 'coverage', '.venv', '__pycache__']);
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);

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
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith('.')) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
        results.push(normalizePosixPath(path.relative(workspaceRoot, path.join(dir, entry.name))));
      }
    }
  };

  walk(workspaceRoot);
  return results;
}
