import { execFileSync } from 'node:child_process';
import type {
  ImpactProvider,
  ImpactProviderInput,
  ImpactProviderOutput,
} from '../../analyze/capability-planner.js';
import { sha256 } from '../../domain/hash.js';
import {
  AEG_VERSION,
  type AnalysisMode,
  type EvidenceEnvelope,
  type ImpactEvidence,
} from '../../domain/types.js';

/**
 * Optional user-installed GitNexus ImpactProvider (Section 10.8 & ADR).
 * AEG NEVER bundles PolyForm-licensed GitNexus code.
 * It activates ONLY when:
 *   1. User has installed `gitnexus` CLI locally, AND
 *   2. Project config enables `providers.gitnexus` (distribution: user-installed) AND
 *      environment `AEG_ENABLE_GITNEXUS=1` (or explicit `enabled: true`) confirms license acceptance.
 * When unavailable, CapabilityPlanner automatically selects `ast-symbols` for `symbol_graph`!
 */
export class GitNexusProvider implements ImpactProvider {
  readonly id = 'gitnexus';
  readonly version = AEG_VERSION;
  readonly category = 'symbol_graph' as const;
  readonly supportedModes: AnalysisMode[] = ['deep', 'release'];
  readonly estimatedCostMs = 500;
  readonly priority = 120; // Higher priority than ast-symbols when installed & authorized

  isAvailable(input: ImpactProviderInput): boolean {
    const cfg = input.config.analysis?.providers?.gitnexus;
    if (!cfg || cfg.enabled === false) return false;
    // Respect license opt-in boundary unless explicitly enabled=true or env AEG_ENABLE_GITNEXUS=1
    if (cfg.enabled === 'auto' && process.env.AEG_ENABLE_GITNEXUS !== '1') {
      return false;
    }
    try {
      execFileSync('gitnexus', ['--version'], {
        cwd: input.workspaceRoot,
        windowsHide: true,
        stdio: 'ignore',
        timeout: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async analyze(input: ImpactProviderInput): Promise<EvidenceEnvelope<ImpactProviderOutput>> {
    const startMs = Date.now();
    const changedPaths = input.changeSet.files.map((f) => f.path);
    const warnings: string[] = [];
    const evidence: ImpactEvidence[] = [];
    const transitive = new Set<string>();
    const knownModules = new Set(Object.keys(input.modules.modules));

    const stdout = execFileSync(
      'gitnexus',
      ['impact', '--json', ...changedPaths.slice(0, 50)],
      {
        cwd: input.workspaceRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const parsed = JSON.parse(stdout) as {
      affectedModules?: string[];
      blastRadius?: Array<{ source?: string; target?: string; reason?: string }>;
    };

    let idx = 0;
    for (const mod of parsed.affectedModules ?? []) {
      if (knownModules.has(mod)) transitive.add(mod);
    }
    for (const edge of parsed.blastRadius ?? []) {
      if (edge.target && knownModules.has(edge.target)) {
        transitive.add(edge.target);
      }
      evidence.push({
        id: `ev-gn-${++idx}`,
        providerId: this.id,
        kind: 'module_dependency',
        source: edge.source ?? 'gitnexus',
        target: edge.target ?? 'unknown',
        reason: edge.reason ?? 'GitNexus blast radius dependency',
        confidence: 0.92,
      });
    }

    return {
      providerId: this.id,
      providerVersion: this.version,
      capability: 'gitnexus_blast_radius',
      subjectDigest: sha256(`${input.changeSet.repositoryTreeHash}:gitnexus`),
      confidence: 0.92,
      cost: { durationMs: Date.now() - startMs },
      freshness: new Date().toISOString(),
      warnings,
      data: {
        directlyChangedModules: [],
        transitivelyAffectedModules: Array.from(transitive).sort(),
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
