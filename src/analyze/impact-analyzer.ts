import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { detectGraphCycles } from '../config/schema-validator.js';
import { normalizePosixPath, sha256 } from '../domain/hash.js';
import {
  AEG_VERSION,
  type AnalysisMode,
  type EvidenceEnvelope,
  type ImpactEvidence,
  type ImpactResult,
  type ModulesConfig,
  type SymbolRef,
} from '../domain/types.js';
import type {
  CapabilityPlanner,
  ImpactProvider,
  ImpactProviderInput,
  ImpactProviderOutput,
} from './capability-planner.js';

export function buildReverseDependencyGraph(modules: ModulesConfig): Map<string, Set<string>> {
  // Section 10.2: `A depends_on B` means A uses B.
  // When B changes, follow reverse edges B -> A to find all downstream dependents.
  const reverse = new Map<string, Set<string>>();
  for (const modName of Object.keys(modules.modules)) {
    reverse.set(modName, new Set());
  }
  for (const [modName, def] of Object.entries(modules.modules)) {
    for (const dep of def.depends_on ?? []) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep)!.add(modName);
    }
  }
  return reverse;
}

export function computeTransitiveDownstream(
  directModules: string[],
  reverseGraph: Map<string, Set<string>>,
): Array<{ moduleId: string; via: string }> {
  const visited = new Set<string>(directModules);
  const queue = [...directModules];
  const downstream: Array<{ moduleId: string; via: string }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of reverseGraph.get(current) ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        downstream.push({ moduleId: dependent, via: current });
        queue.push(dependent);
      }
    }
  }

  return downstream;
}

export class BuiltinModuleImpactProvider implements ImpactProvider {
  readonly id = 'builtin-module';
  readonly version = AEG_VERSION;
  readonly category = 'module_graph' as const;
  readonly supportedModes: AnalysisMode[] = ['fast', 'balanced', 'deep', 'release'];
  readonly estimatedCostMs = 15;
  readonly priority = 100;

  isAvailable(): boolean {
    return true;
  }

  async analyze(input: ImpactProviderInput): Promise<EvidenceEnvelope<ImpactProviderOutput>> {
    const startMs = Date.now();
    const evidence: ImpactEvidence[] = [];
    const unknowns: string[] = [];
    const directSet = new Set<string>();
    const contractSet = new Set<string>();
    const dataModelSet = new Set<string>();
    const unclassifiedFiles: string[] = [];

    const moduleEntries = Object.entries(input.modules.modules).map(([id, def]) => ({
      id,
      def,
      matchPaths: picomatch(def.paths, { dot: true }),
      matchPublicApi:
        def.public_api_paths && def.public_api_paths.length > 0
          ? picomatch(def.public_api_paths, { dot: true })
          : () => false,
    }));

    // Detect cycles in module dependency graph -> record in unknowns (Section 10.2)
    const moduleCycles = detectGraphCycles(
      Object.fromEntries(
        Object.entries(input.modules.modules).map(([id, def]) => [id, def.depends_on ?? []]),
      ),
    );
    for (const cycle of moduleCycles) {
      unknowns.push(`Cyclic module dependency in modules.yaml: ${cycle.join(' -> ')}`);
    }

    const ignoreMatcher =
      input.config.analysis?.ignore_paths && input.config.analysis.ignore_paths.length > 0
        ? picomatch(input.config.analysis.ignore_paths, { dot: true })
        : () => false;

    let evidenceCounter = 0;
    const nextEvidenceId = () => `ev-mod-${++evidenceCounter}`;

    for (const file of input.changeSet.files) {
      if (ignoreMatcher(file.path)) continue;

      const matchedModules: string[] = [];
      for (const entry of moduleEntries) {
        if (entry.matchPaths(file.path) || (file.previousPath && entry.matchPaths(file.previousPath))) {
          matchedModules.push(entry.id);
          directSet.add(entry.id);
          evidence.push({
            id: nextEvidenceId(),
            providerId: this.id,
            kind: 'file_to_module',
            source: file.path,
            target: entry.id,
            reason: `File '${file.path}' (${file.changeType}) matches module '${entry.id}'`,
            confidence: 0.95,
          });

          if (entry.matchPublicApi(file.path)) {
            for (const c of entry.def.contracts ?? [`${entry.id}:public-api`]) {
              contractSet.add(c);
            }
            evidence.push({
              id: nextEvidenceId(),
              providerId: this.id,
              kind: 'public_api',
              source: file.path,
              target: entry.id,
              reason: `File '${file.path}' matches public_api_paths of module '${entry.id}'`,
              confidence: 0.95,
            });
          }

          if ((file.categories ?? []).includes('db_migration') || (entry.def.data_models?.length ?? 0) > 0) {
            for (const dm of entry.def.data_models ?? []) {
              dataModelSet.add(dm);
            }
          }
        }
      }

      if ((file.categories ?? []).includes('db_migration')) {
        dataModelSet.add(`migration:${file.path}`);
        evidence.push({
          id: nextEvidenceId(),
          providerId: this.id,
          kind: 'data_model',
          source: file.path,
          target: 'database',
          reason: `Database migration file '${file.path}' changed`,
          confidence: 0.98,
        });
      }

      if (matchedModules.length === 0) {
        const cats = file.categories ?? [];
        const nonModuleAcceptable =
          cats.length === 1 && cats[0] === 'docs';
        const isMeta =
          cats.includes('guard_config') ||
          cats.includes('lockfile') ||
          cats.includes('ci') ||
          cats.includes('test');

        if (!nonModuleAcceptable && !isMeta) {
          unclassifiedFiles.push(file.path);
          unknowns.push(`Unclassified file not mapped to any module: ${file.path}`);
        }
      }
    }

    const directModules = Array.from(directSet).sort();
    const reverseGraph = buildReverseDependencyGraph(input.modules);
    const downstream = computeTransitiveDownstream(directModules, reverseGraph);

    for (const item of downstream) {
      evidence.push({
        id: nextEvidenceId(),
        providerId: this.id,
        kind: 'module_dependency',
        source: item.via,
        target: item.moduleId,
        reason: `Module '${item.moduleId}' depends on '${item.via}' (transitive downstream impact)`,
        confidence: 0.9,
      });
    }

    if (input.changeSet.submoduleChanges.length > 0) {
      for (const sub of input.changeSet.submoduleChanges) {
        unknowns.push(`Submodule '${sub.path}' changed; internal submodule impact cannot be statically proven.`);
      }
    }

    const confidence =
      unknowns.length === 0
        ? 0.95
        : Math.max(0.4, Number((0.9 - unknowns.length * 0.12).toFixed(2)));

    return {
      providerId: this.id,
      providerVersion: this.version,
      capability: 'file_and_module_graph',
      subjectDigest: input.changeSet.repositoryTreeHash,
      confidence,
      cost: { durationMs: Date.now() - startMs },
      freshness: new Date().toISOString(),
      warnings: [],
      data: {
        directlyChangedModules: directModules,
        transitivelyAffectedModules: downstream.map((d) => d.moduleId).sort(),
        affectedSymbols: [],
        affectedContracts: Array.from(contractSet).sort(),
        affectedDataModels: Array.from(dataModelSet).sort(),
        unclassifiedFiles: unclassifiedFiles.sort(),
        evidence,
        unknowns,
      },
    };
  }
}

const IMPORT_RE =
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|from\s+(\.[.\w]*)\s+import)/g;

const EXPORT_SYMBOL_RE =
  /export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/g;

export class LightweightImportProvider implements ImpactProvider {
  readonly id = 'import-graph';
  readonly version = AEG_VERSION;
  readonly category = 'import_relation' as const;
  readonly supportedModes: AnalysisMode[] = ['balanced', 'deep', 'release'];
  readonly estimatedCostMs = 45;
  readonly priority = 80;

  isAvailable(): boolean {
    return true;
  }

  async analyze(input: ImpactProviderInput): Promise<EvidenceEnvelope<ImpactProviderOutput>> {
    const startMs = Date.now();
    const evidence: ImpactEvidence[] = [];
    const unknowns: string[] = [];
    const affectedSymbols: SymbolRef[] = [];
    const transitivelyAffected = new Set<string>();

    const moduleMatchers = Object.entries(input.modules.modules).map(([id, def]) => ({
      id,
      match: picomatch(def.paths, { dot: true }),
    }));

    const findModuleForPath = (posixRel: string): string | undefined => {
      for (const m of moduleMatchers) {
        if (m.match(posixRel)) return m.id;
      }
      return undefined;
    };

    let counter = 0;
    for (const file of input.changeSet.files) {
      if (file.changeType === 'deleted' || file.binary || file.large) continue;
      if (!/\.(?:ts|tsx|mts|js|jsx|mjs|cjs|py)$/i.test(file.path)) continue;

      const absPath = path.join(input.workspaceRoot, file.path);
      if (!fs.existsSync(absPath)) continue;

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }

      // Extract exported symbols from changed file for explainability
      EXPORT_SYMBOL_RE.lastIndex = 0;
      let symMatch: RegExpExecArray | null;
      while ((symMatch = EXPORT_SYMBOL_RE.exec(content)) !== null) {
        const kindRaw = symMatch[1]!;
        const name = symMatch[2]!;
        const kind: SymbolRef['kind'] =
          kindRaw === 'function' || kindRaw === 'class' || kindRaw === 'interface' || kindRaw === 'type'
            ? kindRaw
            : 'export';
        affectedSymbols.push({ name, kind, file: file.path });
      }

      // Inspect relative imports to detect undeclared cross-module edges
      const sourceModule = findModuleForPath(file.path);
      IMPORT_RE.lastIndex = 0;
      let impMatch: RegExpExecArray | null;
      while ((impMatch = IMPORT_RE.exec(content)) !== null) {
        const rawSpec = impMatch[1] ?? impMatch[2] ?? impMatch[3] ?? impMatch[4];
        if (!rawSpec || !rawSpec.startsWith('.')) continue;

        const dir = path.posix.dirname(file.path);
        const resolved = normalizePosixPath(path.posix.normalize(path.posix.join(dir, rawSpec)));
        const targetMod =
          findModuleForPath(resolved) ??
          findModuleForPath(`${resolved}.ts`) ??
          findModuleForPath(`${resolved}.js`) ??
          findModuleForPath(`${resolved}/index.ts`);

        if (targetMod && sourceModule && targetMod !== sourceModule) {
          const declaredDeps = input.modules.modules[sourceModule]?.depends_on ?? [];
          if (!declaredDeps.includes(targetMod)) {
            transitivelyAffected.add(targetMod);
            evidence.push({
              id: `ev-imp-${++counter}`,
              providerId: this.id,
              kind: 'import_relation',
              source: file.path,
              target: targetMod,
              reason: `File '${file.path}' imports '${rawSpec}' in module '${targetMod}', which is not declared in modules.${sourceModule}.depends_on`,
              confidence: 0.8,
            });
            unknowns.push(
              `Module graph drift: '${sourceModule}' (${file.path}) imports '${targetMod}' without declaring it in modules.yaml`,
            );
          }
        }
      }
    }

    return {
      providerId: this.id,
      providerVersion: this.version,
      capability: 'lightweight_import_and_export_scan',
      subjectDigest: sha256(input.changeSet.repositoryTreeHash + ':imports'),
      confidence: 0.85,
      cost: { durationMs: Date.now() - startMs },
      freshness: new Date().toISOString(),
      warnings: [],
      data: {
        directlyChangedModules: [],
        transitivelyAffectedModules: Array.from(transitivelyAffected).sort(),
        affectedSymbols: affectedSymbols.slice(0, 100),
        affectedContracts: [],
        affectedDataModels: [],
        unclassifiedFiles: [],
        evidence,
        unknowns,
      },
    };
  }
}

export async function runImpactAnalysis(params: {
  planner: CapabilityPlanner;
  input: ImpactProviderInput;
  hasPolicyRelaxation?: boolean;
}): Promise<{ impact: ImpactResult; effectiveMode: AnalysisMode; escalationReasons: string[] }> {
  const selection = params.planner.plan({
    requestedMode: params.input.mode,
    changeSet: params.input.changeSet,
    config: params.input.config,
    modules: params.input.modules,
    workspaceRoot: params.input.workspaceRoot,
    hasPolicyRelaxation: params.hasPolicyRelaxation,
  });

  const providerInput: ImpactProviderInput = {
    ...params.input,
    mode: selection.effectiveMode,
  };

  const direct = new Set<string>();
  const transitive = new Set<string>();
  const symbols: SymbolRef[] = [];
  const contracts = new Set<string>();
  const dataModels = new Set<string>();
  const unclassified = new Set<string>();
  const evidence: ImpactEvidence[] = [];
  const envelopes: EvidenceEnvelope<unknown>[] = [];
  const unknowns: string[] = [];
  let minConfidence = 1.0;

  const providerTimeoutMs =
    selection.effectiveMode === 'fast'
      ? 2000
      : selection.effectiveMode === 'balanced'
        ? 5000
        : 30000;

  for (const provider of selection.selectedProviders) {
    try {
      const env = await withTimeout(
        provider.analyze(providerInput),
        providerTimeoutMs,
        `Impact provider '${provider.id}' timed out after ${providerTimeoutMs}ms`,
      );
      envelopes.push(env);
      minConfidence = Math.min(minConfidence, env.confidence);

      for (const m of env.data.directlyChangedModules) direct.add(m);
      for (const m of env.data.transitivelyAffectedModules) {
        if (!direct.has(m)) transitive.add(m);
      }
      symbols.push(...env.data.affectedSymbols);
      for (const c of env.data.affectedContracts) contracts.add(c);
      for (const d of env.data.affectedDataModels) dataModels.add(d);
      for (const u of env.data.unclassifiedFiles) unclassified.add(u);
      evidence.push(...env.data.evidence);
      unknowns.push(...env.data.unknowns);
    } catch (err: unknown) {
      // Section 5.9 & 10.4: Provider failure NEVER means "no impact" — record unknown and fall back
      const msg = err instanceof Error ? err.message : String(err);
      unknowns.push(`Impact provider '${provider.id}' failed: ${msg}`);
      minConfidence = Math.min(minConfidence, 0.5);
    }
  }

  if (envelopes.length === 0) {
    unknowns.push('No impact analysis provider succeeded; impact scope is unknown.');
    minConfidence = 0;
  }

  // Remove any direct module from transitive set
  for (const d of direct) transitive.delete(d);

  return {
    effectiveMode: selection.effectiveMode,
    escalationReasons: selection.escalationReasons,
    impact: {
      directlyChangedModules: Array.from(direct).sort(),
      transitivelyAffectedModules: Array.from(transitive).sort(),
      affectedSymbols: symbols,
      affectedContracts: Array.from(contracts).sort(),
      affectedDataModels: Array.from(dataModels).sort(),
      unclassifiedFiles: Array.from(unclassified).sort(),
      confidence: Number(minConfidence.toFixed(2)),
      evidence,
      envelopes,
      unknowns: Array.from(new Set(unknowns)),
      escalatedMode: selection.escalated ? selection.effectiveMode : undefined,
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
