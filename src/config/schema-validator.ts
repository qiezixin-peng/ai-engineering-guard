import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import { isSubpath } from '../domain/hash.js';
import type { AegConfig, ModulesConfig, TestsConfig } from '../domain/types.js';

export interface ValidationIssue {
  file: 'config.yaml' | 'modules.yaml' | 'tests.yaml' | 'cross-ref';
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

let cachedValidators: {
  config: ValidateFunction;
  modules: ValidateFunction;
  tests: ValidateFunction;
} | null = null;

function getValidators() {
  if (cachedValidators) return cachedValidators;

  const AjvCtor = ((Ajv as unknown as { default?: new (opts: Record<string, unknown>) => { compile: (schema: unknown) => ValidateFunction } }).default ??
    (Ajv as unknown as new (opts: Record<string, unknown>) => { compile: (schema: unknown) => ValidateFunction }));
  const ajv = new AjvCtor({ allErrors: true, allowUnionTypes: true, strict: false });

  const loadSchema = (filename: string) => {
    const schemaPath = path.join(PACKAGE_ROOT, 'schemas', filename);
    return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  };

  cachedValidators = {
    config: ajv.compile(loadSchema('config.schema.json')),
    modules: ajv.compile(loadSchema('modules.schema.json')),
    tests: ajv.compile(loadSchema('tests.schema.json')),
  };
  return cachedValidators;
}

function collectAjvIssues(
  file: 'config.yaml' | 'modules.yaml' | 'tests.yaml',
  validate: ValidateFunction,
  data: unknown,
): ValidationIssue[] {
  const ok = validate(data);
  if (ok) return [];
  return (validate.errors ?? []).map((err) => ({
    file,
    path: err.instancePath || '/',
    severity: 'error' as const,
    message: `${err.message ?? 'schema error'}${err.params ? ` (${JSON.stringify(err.params)})` : ''}`,
  }));
}

export function validateProjectConfigs(
  workspaceRoot: string,
  config: unknown,
  modules: unknown,
  tests: unknown,
): ValidationResult {
  const validators = getValidators();
  const issues: ValidationIssue[] = [
    ...collectAjvIssues('config.yaml', validators.config, config),
    ...collectAjvIssues('modules.yaml', validators.modules, modules),
    ...collectAjvIssues('tests.yaml', validators.tests, tests),
  ];

  if (issues.some((i) => i.severity === 'error')) {
    return { valid: false, issues };
  }

  const typedConfig = config as AegConfig;
  const typedModules = modules as ModulesConfig;
  const typedTests = tests as TestsConfig;
  const moduleNames = new Set(Object.keys(typedModules.modules));
  const suiteNames = new Set(Object.keys(typedTests.suites));

  // Cross-ref: protected_modules must exist
  for (const mod of typedConfig.risk?.protected_modules ?? []) {
    if (!moduleNames.has(mod)) {
      issues.push({
        file: 'cross-ref',
        path: `config.risk.protected_modules.${mod}`,
        severity: 'warning',
        message: `Protected module '${mod}' is not declared in modules.yaml`,
      });
    }
  }

  // Cross-ref: module depends_on
  for (const [modName, modDef] of Object.entries(typedModules.modules)) {
    for (const dep of modDef.depends_on ?? []) {
      if (dep === modName) {
        issues.push({
          file: 'cross-ref',
          path: `modules.${modName}.depends_on`,
          severity: 'error',
          message: `Module '${modName}' cannot depend on itself`,
        });
      } else if (!moduleNames.has(dep)) {
        issues.push({
          file: 'cross-ref',
          path: `modules.${modName}.depends_on`,
          severity: 'error',
          message: `Module '${modName}' depends on unknown module '${dep}'`,
        });
      }
    }
  }

  // Cross-ref: suite covers, depends_on, portability, command boundaries
  for (const [suiteId, suiteDef] of Object.entries(typedTests.suites)) {
    for (const mod of suiteDef.covers) {
      if (!moduleNames.has(mod)) {
        issues.push({
          file: 'cross-ref',
          path: `suites.${suiteId}.covers`,
          severity: 'error',
          message: `Suite '${suiteId}' covers unknown module '${mod}'`,
        });
      }
    }

    for (const depSuite of suiteDef.depends_on ?? []) {
      if (depSuite === suiteId) {
        issues.push({
          file: 'cross-ref',
          path: `suites.${suiteId}.depends_on`,
          severity: 'error',
          message: `Suite '${suiteId}' cannot depend on itself`,
        });
      } else if (!suiteNames.has(depSuite)) {
        issues.push({
          file: 'cross-ref',
          path: `suites.${suiteId}.depends_on`,
          severity: 'error',
          message: `Suite '${suiteId}' depends on unknown suite '${depSuite}'`,
        });
      }
    }

    // Section 11.4: execution: once_per_change requires portable: true and canonical_platform
    if (suiteDef.execution === 'once_per_change') {
      if (suiteDef.portable !== true) {
        issues.push({
          file: 'cross-ref',
          path: `suites.${suiteId}.execution`,
          severity: 'error',
          message: `Suite '${suiteId}' uses 'once_per_change' without 'portable: true'`,
        });
      }
      if (!suiteDef.canonical_platform) {
        issues.push({
          file: 'cross-ref',
          path: `suites.${suiteId}.canonical_platform`,
          severity: 'error',
          message: `Suite '${suiteId}' uses 'once_per_change' without declaring 'canonical_platform'`,
        });
      } else if (suiteDef.platforms && !suiteDef.platforms.includes(suiteDef.canonical_platform)) {
        issues.push({
          file: 'cross-ref',
          path: `suites.${suiteId}.canonical_platform`,
          severity: 'error',
          message: `Suite '${suiteId}' canonical_platform '${suiteDef.canonical_platform}' is not in platforms [${suiteDef.platforms.join(', ')}]`,
        });
      }
    }

    // Section 17.1 & 17.2: cwd and relative executable scripts must stay inside workspace
    const cwdPath = path.resolve(workspaceRoot, suiteDef.command.cwd ?? '.');
    if (!isSubpath(workspaceRoot, cwdPath)) {
      issues.push({
        file: 'cross-ref',
        path: `suites.${suiteId}.command.cwd`,
        severity: 'error',
        message: `Suite '${suiteId}' command.cwd '${suiteDef.command.cwd}' escapes workspace`,
      });
    }

    const exec = suiteDef.command.executable;
    if (exec.includes('/') || exec.includes('\\') || exec.startsWith('.')) {
      const resolvedExec = path.resolve(cwdPath, exec);
      if (!isSubpath(workspaceRoot, resolvedExec)) {
        issues.push({
          file: 'cross-ref',
          path: `suites.${suiteId}.command.executable`,
          severity: 'error',
          message: `Suite '${suiteId}' executable '${exec}' references a script outside workspace`,
        });
      }
    }
  }

  // Section 10.4.1: Suite depends_on must be a DAG (cycle fails config validation)
  const suiteCycles = detectGraphCycles(
    Object.fromEntries(
      Object.entries(typedTests.suites).map(([id, def]) => [id, def.depends_on ?? []]),
    ),
  );
  for (const cycle of suiteCycles) {
    issues.push({
      file: 'cross-ref',
      path: 'suites.depends_on',
      severity: 'error',
      message: `Cyclic suite dependency detected: ${cycle.join(' -> ')}`,
    });
  }

  // Cross-ref: regressions
  for (const reg of typedTests.regressions ?? []) {
    if (!suiteNames.has(reg.suite)) {
      issues.push({
        file: 'cross-ref',
        path: `regressions.${reg.id}.suite`,
        severity: 'error',
        message: `Regression '${reg.id}' references unknown suite '${reg.suite}'`,
      });
    }
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  };
}

export function detectGraphCycles(adj: Record<string, string[]>): string[][] {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const pathStack: string[] = [];
  const cycles: string[][] = [];

  const dfs = (node: string) => {
    visited.add(node);
    stack.add(node);
    pathStack.push(node);

    for (const next of adj[node] ?? []) {
      if (!adj[next]) continue;
      if (!visited.has(next)) {
        dfs(next);
      } else if (stack.has(next)) {
        const idx = pathStack.indexOf(next);
        if (idx >= 0) {
          cycles.push([...pathStack.slice(idx), next]);
        }
      }
    }

    stack.delete(node);
    pathStack.pop();
  };

  for (const node of Object.keys(adj)) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}
