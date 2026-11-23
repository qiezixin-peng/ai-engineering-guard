import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../domain/hash.js';
import {
  AEG_VERSION,
  type AnalysisMode,
  type EvidenceEnvelope,
  type ImpactEvidence,
  type ImpactProvider,
  type ImpactProviderInput,
  type ImpactProviderOutput,
} from '../../domain/types.js';

const DESTRUCTIVE_SQL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bDROP\s+TABLE\b/i, label: 'DROP TABLE' },
  { pattern: /\bDROP\s+COLUMN\b/i, label: 'DROP COLUMN' },
  { pattern: /\bTRUNCATE\s+TABLE?\b/i, label: 'TRUNCATE' },
  { pattern: /\bALTER\s+TABLE\b[\s\S]{0,120}\bDROP\b/i, label: 'ALTER TABLE ... DROP' },
  { pattern: /\bDELETE\s+FROM\b(?![\s\S]{0,80}\bWHERE\b)/i, label: 'Unbounded DELETE FROM' },
];

export class ContractsAndDbProvider implements ImpactProvider {
  readonly id = 'contracts-db';
  readonly version = AEG_VERSION;
  readonly category = 'contract_db' as const;
  readonly supportedModes: AnalysisMode[] = ['balanced', 'deep', 'release'];
  readonly estimatedCostMs = 30;
  readonly priority = 100;

  isAvailable(input: ImpactProviderInput): boolean {
    return input.changeSet.files.some(
      (f) =>
        (f.categories ?? []).includes('db_migration') ||
        /(?:openapi|swagger).*\.(?:ya?ml|json)$/i.test(f.path) ||
        /\.graphql$/i.test(f.path) ||
        /\.proto$/i.test(f.path) ||
        /schema\.prisma$/i.test(f.path) ||
        /\.engineering-guard\/contracts\//i.test(f.path),
    );
  }

  async analyze(input: ImpactProviderInput): Promise<EvidenceEnvelope<ImpactProviderOutput>> {
    const startMs = Date.now();
    const affectedContracts = new Set<string>();
    const affectedDataModels = new Set<string>();
    const evidence: ImpactEvidence[] = [];
    const warnings: string[] = [];
    const unknowns: string[] = [];
    let evIdx = 0;

    for (const file of input.changeSet.files) {
      const absPath = path.join(input.workspaceRoot, file.path);
      const isContractFile =
        /(?:openapi|swagger).*\.(?:ya?ml|json)$/i.test(file.path) ||
        /\.graphql$/i.test(file.path) ||
        /\.proto$/i.test(file.path) ||
        /\.engineering-guard\/contracts\//i.test(file.path);

      if (isContractFile) {
        affectedContracts.add(`contract:${file.path}`);
        evidence.push({
          id: `ev-cdb-${++evIdx}`,
          providerId: this.id,
          kind: 'contract',
          source: file.path,
          target: `contract:${file.path}`,
          reason: `API contract file '${file.path}' (${file.changeType}) modified`,
          confidence: 0.96,
        });
      }

      if ((file.categories ?? []).includes('db_migration') || /schema\.prisma$/i.test(file.path)) {
        affectedDataModels.add(`db:${file.path}`);
        if (file.changeType !== 'deleted' && fs.existsSync(absPath)) {
          try {
            const content = fs.readFileSync(absPath, 'utf8');
            for (const rule of DESTRUCTIVE_SQL_PATTERNS) {
              if (rule.pattern.test(content)) {
                affectedDataModels.add(`destructive-migration:${rule.label}:${file.path}`);
                warnings.push(`Destructive SQL operation '${rule.label}' detected in '${file.path}'`);
                evidence.push({
                  id: `ev-cdb-${++evIdx}`,
                  providerId: this.id,
                  kind: 'data_model',
                  source: file.path,
                  target: `destructive:${rule.label}`,
                  reason: `Destructive database migration pattern '${rule.label}' found in '${file.path}'`,
                  confidence: 0.98,
                });
              }
            }
          } catch {
            unknowns.push(`Could not inspect database migration file: ${file.path}`);
          }
        }
      }
    }

    return {
      providerId: this.id,
      providerVersion: this.version,
      capability: 'api_contracts_and_db_migrations',
      subjectDigest: sha256(`${input.changeSet.repositoryTreeHash}:contracts-db`),
      confidence: 0.96,
      cost: { durationMs: Date.now() - startMs },
      freshness: new Date().toISOString(),
      warnings,
      data: {
        directlyChangedModules: [],
        transitivelyAffectedModules: [],
        affectedSymbols: [],
        affectedContracts: Array.from(affectedContracts).sort(),
        affectedDataModels: Array.from(affectedDataModels).sort(),
        unclassifiedFiles: [],
        evidence,
        unknowns,
      },
    };
  }
}
