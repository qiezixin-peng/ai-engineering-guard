import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { GUARD_DIR } from './loader.js';
import { validateProjectConfigs } from './schema-validator.js';

export interface MigrationResult {
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  changes: string[];
  backupPaths: string[];
  dryRun: boolean;
}

/**
 * Safe Configuration Upgrade & Migration Tool (Section 19).
 * Ensures schema_version fields, default agent_context bounds, and exact_tree safety defaults
 * without ever silently weakening existing project gates.
 */
export function migrateProjectConfig(params: {
  workspaceRoot: string;
  dryRun?: boolean;
}): MigrationResult {
  const root = path.resolve(params.workspaceRoot);
  const guardDir = path.join(root, GUARD_DIR);
  const cfgPath = path.join(guardDir, 'config.yaml');
  const modPath = path.join(guardDir, 'modules.yaml');
  const testPath = path.join(guardDir, 'tests.yaml');

  if (!fs.existsSync(cfgPath) || !fs.existsSync(modPath) || !fs.existsSync(testPath)) {
    throw new Error(`Incomplete ${GUARD_DIR} directory in ${root}; run 'aeg init' first.`);
  }

  const config = YAML.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  const modules = YAML.parse(fs.readFileSync(modPath, 'utf8')) as Record<string, unknown>;
  const tests = YAML.parse(fs.readFileSync(testPath, 'utf8')) as Record<string, unknown>;

  const fromVersion = typeof config.schema_version === 'number' ? config.schema_version : 0;
  const changes: string[] = [];

  if (config.schema_version !== 1) {
    config.schema_version = 1;
    changes.push('Set config.yaml schema_version: 1');
  }
  if (modules.schema_version !== 1) {
    modules.schema_version = 1;
    changes.push('Set modules.yaml schema_version: 1');
  }
  if (tests.schema_version !== 1) {
    tests.schema_version = 1;
    changes.push('Set tests.yaml schema_version: 1');
  }
  if (!config.agent_context) {
    config.agent_context = {
      default_view: 'agent-summary',
      max_failure_excerpt_bytes: 16384,
      max_auto_expansions: 3,
    };
    changes.push('Added default agent_context progressive-disclosure budget in config.yaml');
  }
  if (!config.cache) {
    config.cache = {
      enabled: true,
      backend: 'local',
      directory: '.aeg/cache',
      cross_platform: false,
      exact_tree: true,
      suite_fingerprint: { mode: 'disabled' },
    };
    changes.push('Added safe default exact_tree local cache block in config.yaml');
  }

  const validation = validateProjectConfigs(root, config, modules, tests);
  if (!validation.valid) {
    throw new Error(
      `Migrated configuration failed validation: ${validation.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const backupPaths: string[] = [];
  if (changes.length > 0 && !params.dryRun) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    for (const [filePath, obj] of [
      [cfgPath, config],
      [modPath, modules],
      [testPath, tests],
    ] as const) {
      const backup = `${filePath}.bak-${stamp}`;
      fs.copyFileSync(filePath, backup);
      backupPaths.push(backup);
      fs.writeFileSync(filePath, YAML.stringify(obj), 'utf8');
    }
  }

  return {
    migrated: changes.length > 0,
    fromVersion,
    toVersion: 1,
    changes,
    backupPaths,
    dryRun: Boolean(params.dryRun),
  };
}
