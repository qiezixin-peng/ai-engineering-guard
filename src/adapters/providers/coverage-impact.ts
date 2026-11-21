import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
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

const COVERAGE_CANDIDATES = [
  'coverage/coverage-final.json',
  'coverage/lcov.info',
  'lcov.info',
];

export class CoverageImpactProvider implements ImpactProvider {
  readonly id = 'coverage-impact';
  readonly version = AEG_VERSION;
  readonly category = 'coverage_map' as const;
  readonly supportedModes: AnalysisMode[] = ['deep', 'release'];
  readonly estimatedCostMs = 80;
  readonly priority = 90;

  private findCoverageFile(workspaceRoot: string): string | undefined {
    for (const rel of COVERAGE_CANDIDATES) {
      const full = path.join(workspaceRoot, rel);
      if (fs.existsSync(full)) return full;
    }
    return undefined;
  }

  isAvailable(input: ImpactProviderInput): boolean {
    return this.findCoverageFile(input.workspaceRoot) !== undefined;
  }

  async analyze(input: ImpactProviderInput): Promise<EvidenceEnvelope<ImpactProviderOutput>> {
    const startMs = Date.now();
    const covPath = this.findCoverageFile(input.workspaceRoot);
    const evidence: ImpactEvidence[] = [];
    const warnings: string[] = [];
    const coveredChangedModules = new Set<string>();

    if (!covPath) {
      return {
        providerId: this.id,
        providerVersion: this.version,
        capability: 'coverage_impact_map',
        subjectDigest: sha256(`${input.changeSet.repositoryTreeHash}:cov:none`),
        confidence: 0.75,
        cost: { durationMs: Date.now() - startMs },
        freshness: new Date().toISOString(),
        warnings: ['No coverage artifact found.'],
        data: {
          directlyChangedModules: [],
          transitivelyAffectedModules: [],
          affectedSymbols: [],
          affectedContracts: [],
          affectedDataModels: [],
          unclassifiedFiles: [],
          evidence: [],
          unknowns: [],
        },
      };
    }

    const coveredFiles = new Set<string>();
    const raw = fs.readFileSync(covPath, 'utf8');
    if (covPath.endsWith('.json')) {
      const parsed = JSON.parse(raw) as Record<string, { path?: string }>;
      for (const [k, entry] of Object.entries(parsed)) {
        const filePath = entry?.path ?? k;
        const rel = path.isAbsolute(filePath)
          ? normalizePosixPath(path.relative(input.workspaceRoot, filePath))
          : normalizePosixPath(filePath);
        coveredFiles.add(rel);
      }
    } else {
      // LCOV format: SF:<filepath>
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('SF:')) {
          const rawPath = line.slice(3).trim();
          const rel = path.isAbsolute(rawPath)
            ? normalizePosixPath(path.relative(input.workspaceRoot, rawPath))
            : normalizePosixPath(rawPath);
          coveredFiles.add(rel);
        }
      }
    }

    const moduleEntries = Object.entries(input.modules.modules).map(([id, def]) => ({
      id,
      match: picomatch(def.paths, { dot: true }),
    }));

    let evIdx = 0;
    for (const file of input.changeSet.files) {
      if (coveredFiles.has(file.path)) {
        const mod = moduleEntries.find((m) => m.match(file.path))?.id;
        if (mod) coveredChangedModules.add(mod);
        evidence.push({
          id: `ev-cov-${++evIdx}`,
          providerId: this.id,
          kind: 'file_to_module',
          source: file.path,
          target: mod ?? file.path,
          reason: `Coverage map confirms '${file.path}' is exercised by existing test coverage`,
          confidence: 0.9,
        });
      }
    }

    const stat = fs.statSync(covPath);
    return {
      providerId: this.id,
      providerVersion: this.version,
      capability: 'coverage_impact_map',
      subjectDigest: sha256(`${input.changeSet.repositoryTreeHash}:cov:${stat.mtimeMs}`),
      confidence: 0.9,
      cost: { durationMs: Date.now() - startMs },
      freshness: stat.mtime.toISOString(),
      warnings,
      data: {
        directlyChangedModules: Array.from(coveredChangedModules).sort(),
        transitivelyAffectedModules: [],
        affectedSymbols: [],
        affectedContracts: [],
        affectedDataModels: [],
        unclassifiedFiles: [],
        evidence,
        unknowns: [],
      },
    };
  }
}
