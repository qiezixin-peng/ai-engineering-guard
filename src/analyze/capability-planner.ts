import type {
  AegConfig,
  AnalysisMode,
  ChangeSet,
  EvidenceCategory,
  FileCategory,
  ImpactProvider,
  ImpactProviderInput,
  ModulesConfig,
} from '../domain/types.js';

export type {
  EvidenceCategory,
  ImpactProvider,
  ImpactProviderInput,
  ImpactProviderOutput,
} from '../domain/types.js';

export interface CapabilitySelection {
  requestedMode: AnalysisMode;
  effectiveMode: AnalysisMode;
  escalated: boolean;
  escalationReasons: string[];
  selectedProviders: ImpactProvider[];
  skippedProviders: Array<{ id: string; reason: string }>;
}

const HIGH_SENSITIVITY_CATEGORIES: FileCategory[] = [
  'db_migration',
  'security_auth',
  'release_signing',
  'guard_config',
  'ci',
];

const MODE_ORDER: Record<AnalysisMode, number> = {
  fast: 0,
  balanced: 1,
  deep: 2,
  release: 3,
};

export class CapabilityPlanner {
  private readonly providers: ImpactProvider[] = [];

  register(provider: ImpactProvider): void {
    this.providers.push(provider);
  }

  getProviders(): ImpactProvider[] {
    return [...this.providers];
  }

  plan(input: {
    requestedMode: AnalysisMode;
    changeSet: ChangeSet;
    config: AegConfig;
    modules: ModulesConfig;
    workspaceRoot: string;
    hasPolicyRelaxation?: boolean;
  }): CapabilitySelection {
    const autoEscalate = input.config.analysis?.auto_escalate !== false;
    let effectiveMode: AnalysisMode = input.requestedMode;
    const escalationReasons: string[] = [];

    if (autoEscalate && MODE_ORDER[effectiveMode] < MODE_ORDER.deep) {
      const sensitiveHits = input.changeSet.files.filter((f) =>
        (f.categories ?? []).some((c) => HIGH_SENSITIVITY_CATEGORIES.includes(c)),
      );
      if (sensitiveHits.length > 0) {
        effectiveMode = 'deep';
        escalationReasons.push(
          `Auto-escalated from '${input.requestedMode}' to 'deep' due to high-sensitivity changes: ${sensitiveHits
            .slice(0, 5)
            .map((f) => f.path)
            .join(', ')}`,
        );
      } else if (input.hasPolicyRelaxation) {
        effectiveMode = 'deep';
        escalationReasons.push(
          `Auto-escalated from '${input.requestedMode}' to 'deep' due to candidate policy relaxation.`,
        );
      } else if (input.changeSet.submoduleChanges.length > 0) {
        effectiveMode = 'deep';
        escalationReasons.push(
          `Auto-escalated from '${input.requestedMode}' to 'deep' due to submodule changes.`,
        );
      }
    }

    const providerInput: ImpactProviderInput = {
      workspaceRoot: input.workspaceRoot,
      changeSet: input.changeSet,
      config: input.config,
      modules: input.modules,
      mode: effectiveMode,
    };

    const byCategory = new Map<EvidenceCategory, ImpactProvider[]>();
    const skippedProviders: Array<{ id: string; reason: string }> = [];

    for (const provider of this.providers) {
      const cfg = input.config.analysis?.providers?.[provider.id];
      if (cfg && cfg.enabled === false) {
        skippedProviders.push({ id: provider.id, reason: 'disabled in project config' });
        continue;
      }

      const allowedModes = cfg?.modes ?? provider.supportedModes;
      if (!allowedModes.includes(effectiveMode)) {
        skippedProviders.push({
          id: provider.id,
          reason: `not selected for mode '${effectiveMode}'`,
        });
        continue;
      }

      if (!provider.isAvailable(providerInput)) {
        skippedProviders.push({ id: provider.id, reason: 'provider unavailable in current environment' });
        continue;
      }

      const list = byCategory.get(provider.category) ?? [];
      list.push(provider);
      byCategory.set(provider.category, list);
    }

    // Section 5.13: Choose only ONE authoritative provider per evidence category by default
    const selectedProviders: ImpactProvider[] = [];
    for (const [category, candidates] of byCategory.entries()) {
      candidates.sort((a, b) => b.priority - a.priority || a.estimatedCostMs - b.estimatedCostMs);
      const chosen = candidates[0]!;
      selectedProviders.push(chosen);
      for (const redundant of candidates.slice(1)) {
        skippedProviders.push({
          id: redundant.id,
          reason: `superseded by authoritative '${chosen.id}' for category '${category}'`,
        });
      }
    }

    selectedProviders.sort((a, b) => a.estimatedCostMs - b.estimatedCostMs);

    return {
      requestedMode: input.requestedMode,
      effectiveMode,
      escalated: effectiveMode !== input.requestedMode,
      escalationReasons,
      selectedProviders,
      skippedProviders,
    };
  }
}
