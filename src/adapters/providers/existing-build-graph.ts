import fs from 'node:fs';
import path from 'node:path';
import type {
  ImpactProvider,
  ImpactProviderInput,
  ImpactProviderOutput,
} from '../../analyze/capability-planner.js';
import { normalizePosixPath, sha256 } from '../../domain/hash.js';
import {
  AEG_VERSION,
  type AnalysisMode,
  type EvidenceEnvelope,
  type ImpactEvidence,
} from '../../domain/types.js';

type BuildSystemKind = 'nx' | 'moon' | 'pants' | 'bazel';

interface DetectedProjectNode {
  name: string;
  root: string;
  implicitDependencies: string[];
}

export class ExistingBuildGraphProvider implements ImpactProvider {
  readonly id = 'existing-build-graph';
  readonly version = AEG_VERSION;
  readonly category = 'build_graph' as const;
  readonly supportedModes: AnalysisMode[] = ['balanced', 'deep', 'release'];
  readonly estimatedCostMs = 60;
  readonly priority = 110;

  detectBuildSystems(workspaceRoot: string, allowed?: string[]): BuildSystemKind[] {
    const allowSet = allowed && allowed.length > 0 ? new Set(allowed) : null;
    const found: BuildSystemKind[] = [];
    const check = (kind: BuildSystemKind, marker: string) => {
      if (allowSet && !allowSet.has(kind)) return;
      if (fs.existsSync(path.join(workspaceRoot, marker))) found.push(kind);
    };
    check('nx', 'nx.json');
    check('moon', '.moon');
    check('pants', 'pants.toml');
    if (!allowSet || allowSet.has('bazel')) {
      if (
        fs.existsSync(path.join(workspaceRoot, 'MODULE.bazel')) ||
        fs.existsSync(path.join(workspaceRoot, 'WORKSPACE')) ||
        fs.existsSync(path.join(workspaceRoot, 'WORKSPACE.bazel'))
      ) {
        found.push('bazel');
      }
    }
    return found;
  }

  isAvailable(input: ImpactProviderInput): boolean {
    const allowed = input.config.analysis?.providers?.[this.id]?.detects;
    return this.detectBuildSystems(input.workspaceRoot, allowed).length > 0;
  }

  async analyze(input: ImpactProviderInput): Promise<EvidenceEnvelope<ImpactProviderOutput>> {
    const startMs = Date.now();
    const allowed = input.config.analysis?.providers?.[this.id]?.detects;
    const systems = this.detectBuildSystems(input.workspaceRoot, allowed);
    const warnings: string[] = [];
    const evidence: ImpactEvidence[] = [];
    const unknowns: string[] = [];
    const direct = new Set<string>();
    const transitive = new Set<string>();

    const knownModules = new Set(Object.keys(input.modules.modules));
    let evId = 0;

    if (systems.includes('nx')) {
      const nxNodes = scanNxProjects(input.workspaceRoot);
      const revMap = new Map<string, Set<string>>();
      for (const node of nxNodes) {
        for (const dep of node.implicitDependencies) {
          if (!revMap.has(dep)) revMap.set(dep, new Set());
          revMap.get(dep)!.add(node.name);
        }
      }

      for (const file of input.changeSet.files) {
        for (const node of nxNodes) {
          const prefix = node.root === '.' ? '' : `${node.root}/`;
          if (!prefix || file.path.startsWith(prefix)) {
            if (knownModules.has(node.name)) direct.add(node.name);
            evidence.push({
              id: `ev-bg-${++evId}`,
              providerId: this.id,
              kind: 'module_dependency',
              source: file.path,
              target: node.name,
              reason: `Reused existing Nx project graph: '${file.path}' belongs to Nx project '${node.name}'`,
              confidence: 0.9,
            });
            for (const dependent of revMap.get(node.name) ?? []) {
              if (knownModules.has(dependent)) transitive.add(dependent);
              evidence.push({
                id: `ev-bg-${++evId}`,
                providerId: this.id,
                kind: 'module_dependency',
                source: node.name,
                target: dependent,
                reason: `Nx implicit dependency: '${dependent}' depends on '${node.name}'`,
                confidence: 0.88,
              });
            }
          }
        }
      }
    } else if (systems.length > 0) {
      // moon / pants / bazel detected: record build system presence without forcing migration or CLI spawns
      warnings.push(
        `Detected existing build system(s): ${systems.join(', ')}. Using lightweight project marker discovery.`,
      );
    }

    return {
      providerId: this.id,
      providerVersion: this.version,
      capability: `existing_build_graph:${systems.join(',')}`,
      subjectDigest: sha256(`${input.changeSet.repositoryTreeHash}:bg:${systems.join(',')}`),
      confidence: 0.9,
      cost: { durationMs: Date.now() - startMs },
      freshness: new Date().toISOString(),
      warnings,
      data: {
        directlyChangedModules: Array.from(direct).sort(),
        transitivelyAffectedModules: Array.from(transitive).sort(),
        affectedSymbols: [],
        affectedContracts: [],
        affectedDataModels: [],
        unclassifiedFiles: [],
        evidence,
        unknowns,
      },
    };
  }
}

function scanNxProjects(workspaceRoot: string, maxDepth = 4): DetectedProjectNode[] {
  const nodes: DetectedProjectNode[] = [];
  const skipDirs = new Set(['node_modules', '.git', '.aeg', 'dist', 'build', 'coverage']);

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'project.json') {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')) as {
            name?: string;
            implicitDependencies?: string[];
          };
          const relRoot = normalizePosixPath(path.relative(workspaceRoot, dir)) || '.';
          const name = parsed.name ?? path.basename(dir);
          nodes.push({
            name,
            root: relRoot,
            implicitDependencies: (parsed.implicitDependencies ?? []).filter((d) => !d.startsWith('!')),
          });
        } catch {
          // skip invalid project.json
        }
      } else if (entry.isDirectory() && !skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };

  walk(workspaceRoot, 0);
  return nodes;
}
