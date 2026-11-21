import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { GUARD_DIR } from '../config/loader.js';
import { validateProjectConfigs } from '../config/schema-validator.js';
import type { AegConfig, ModulesConfig, TestsConfig } from '../domain/types.js';

export interface InitOptions {
  workspaceRoot: string;
  force?: boolean;
}

export interface InitResult {
  createdFiles: string[];
  updatedGitignore: boolean;
  detectedLanguages: string[];
  detectedModules: string[];
  detectedSuites: string[];
}

export function initProject(options: InitOptions): InitResult {
  const root = path.resolve(options.workspaceRoot);
  const guardDir = path.join(root, GUARD_DIR);

  if (fs.existsSync(guardDir) && !options.force) {
    throw new Error(
      `${GUARD_DIR} already exists in ${root}. Pass --force to overwrite existing configuration.`,
    );
  }

  let projectName = path.basename(root) || 'project';
  const languages = new Set<string>();
  const pkgPath = path.join(root, 'package.json');
  let pkgJson: {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null = null;

  if (fs.existsSync(pkgPath)) {
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkgJson?.name) projectName = pkgJson.name;
      const allDeps = { ...(pkgJson?.dependencies ?? {}), ...(pkgJson?.devDependencies ?? {}) };
      if (allDeps.typescript || fs.existsSync(path.join(root, 'tsconfig.json'))) {
        languages.add('typescript');
      } else {
        languages.add('javascript');
      }
    } catch {
      languages.add('javascript');
    }
  }

  if (
    fs.existsSync(path.join(root, 'pyproject.toml')) ||
    fs.existsSync(path.join(root, 'requirements.txt')) ||
    fs.existsSync(path.join(root, 'setup.py'))
  ) {
    languages.add('python');
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) languages.add('go');
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) languages.add('rust');
  if (languages.size === 0) languages.add('generic');

  // Auto-discover top-level modules under src/
  const modules: ModulesConfig['modules'] = {};
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    const subdirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('__'))
      .map((e) => e.name)
      .sort();

    if (subdirs.length > 0 && subdirs.length <= 20) {
      for (const dir of subdirs) {
        modules[dir] = {
          paths: [`src/${dir}/**`],
          depends_on: [],
          criticality: 'normal',
        };
      }
      const rootSrcFiles = entries.some((e) => e.isFile());
      if (rootSrcFiles) {
        modules.root = {
          paths: ['src/*'],
          depends_on: [],
          criticality: 'normal',
        };
      }
    } else {
      modules.core = {
        paths: ['src/**'],
        depends_on: [],
        criticality: 'normal',
      };
    }
  } else {
    modules.core = {
      paths: ['**/*'],
      depends_on: [],
      criticality: 'normal',
    };
  }

  const moduleNames = Object.keys(modules);

  // Auto-detect starter test suite
  const suites: TestsConfig['suites'] = {};
  const allDeps = { ...(pkgJson?.dependencies ?? {}), ...(pkgJson?.devDependencies ?? {}) };
  if (pkgJson?.scripts?.test) {
    const framework = allDeps.vitest
      ? 'vitest'
      : allDeps.jest
        ? 'jest'
        : allDeps['@playwright/test']
          ? 'playwright'
          : 'command';
    suites.unit = {
      framework,
      command: {
        executable: 'npm',
        args: ['test'],
        cwd: '.',
        timeout: '10m',
        environment_allowlist: ['CI', 'NODE_ENV'],
      },
      covers: moduleNames,
      level: 'unit',
      critical: true,
      cache: {
        enabled: true,
        cross_commit: 'disabled',
        hermetic: false,
      },
      platforms: ['windows', 'linux', 'macos'],
      execution: 'once_per_change',
      portable: true,
      canonical_platform: 'linux',
    };
  } else if (languages.has('python')) {
    suites.unit = {
      framework: 'pytest',
      command: {
        executable: 'python',
        args: ['-m', 'pytest'],
        cwd: '.',
        timeout: '10m',
        environment_allowlist: ['CI'],
      },
      covers: moduleNames,
      level: 'unit',
      critical: true,
      cache: {
        enabled: true,
        cross_commit: 'disabled',
        hermetic: false,
      },
      platforms: ['windows', 'linux', 'macos'],
      execution: 'once_per_change',
      portable: true,
      canonical_platform: 'linux',
    };
  } else {
    suites.unit = {
      framework: 'command',
      command: {
        executable: 'node',
        args: ['-e', 'console.log("Replace with your project test command")'],
        cwd: '.',
        timeout: '5m',
        environment_allowlist: ['CI'],
      },
      covers: moduleNames,
      level: 'unit',
      critical: true,
      cache: {
        enabled: true,
        cross_commit: 'disabled',
        hermetic: false,
      },
      platforms: ['windows', 'linux', 'macos'],
      execution: 'once_per_change',
      portable: true,
      canonical_platform: 'linux',
    };
  }

  const configObj: AegConfig = {
    schema_version: 1,
    project: {
      name: projectName,
      languages: Array.from(languages),
    },
    analysis: {
      default_mode: 'balanced',
      auto_escalate: true,
      budgets: {
        fast: { max_duration: '2s', max_memory: '150mb' },
        balanced: { max_duration: '5s', max_memory: '250mb' },
        deep: { max_duration: '30s', max_memory: '1gb' },
      },
      providers: {
        'builtin-module': { enabled: true },
        'import-graph': { enabled: 'auto', modes: ['balanced', 'deep', 'release'] },
      },
      minimum_confidence: 0.75,
    },
    risk: {
      default_level: 'L2',
      protected_modules: [],
      overrides: {
        database_migration: 'L4',
        public_api_change: 'L3',
      },
    },
    cache: {
      enabled: true,
      backend: 'local',
      directory: '.aeg/cache',
      cross_platform: false,
      exact_tree: true,
      suite_fingerprint: { mode: 'disabled' },
    },
    agent_context: {
      default_view: 'agent-summary',
      max_failure_excerpt_bytes: 16384,
      max_auto_expansions: 3,
    },
    gates: {
      local: { block_on: ['test_failure', 'invalid_config'] },
      commit: { block_on: ['test_failure', 'invalid_config', 'L4_unknown'] },
      'pull-request': {
        block_on: ['test_failure', 'L4_unknown', 'invalid_config', 'policy_relaxation'],
      },
      delivery: {
        require_clean_worktree: true,
        block_on: ['test_failure', 'L4_unknown', 'invalid_config', 'policy_relaxation', 'incomplete'],
      },
      release: {
        require_clean_worktree: true,
        block_on: ['test_failure', 'L4_unknown', 'invalid_config', 'policy_relaxation', 'incomplete'],
      },
    },
  };

  const modulesObj: ModulesConfig = { schema_version: 1, modules };
  const testsObj: TestsConfig = { schema_version: 1, suites, regressions: [] };

  const validation = validateProjectConfigs(root, configObj, modulesObj, testsObj);
  if (!validation.valid) {
    throw new Error(
      `Generated config failed self-validation: ${validation.issues.map((i) => i.message).join('; ')}`,
    );
  }

  fs.mkdirSync(guardDir, { recursive: true });
  const configPath = path.join(guardDir, 'config.yaml');
  const modulesPath = path.join(guardDir, 'modules.yaml');
  const testsPath = path.join(guardDir, 'tests.yaml');

  fs.writeFileSync(configPath, YAML.stringify(configObj), 'utf8');
  fs.writeFileSync(modulesPath, YAML.stringify(modulesObj), 'utf8');
  fs.writeFileSync(testsPath, YAML.stringify(testsObj), 'utf8');

  // Ensure .aeg/ is ignored in .gitignore
  let updatedGitignore = false;
  const gitignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    if (!/^\.aeg\/?$/m.test(content)) {
      const sep = content.endsWith('\n') || content.length === 0 ? '' : '\n';
      fs.writeFileSync(gitignorePath, `${content}${sep}.aeg/\n`, 'utf8');
      updatedGitignore = true;
    }
  } else {
    fs.writeFileSync(gitignorePath, '.aeg/\n', 'utf8');
    updatedGitignore = true;
  }

  return {
    createdFiles: [configPath, modulesPath, testsPath],
    updatedGitignore,
    detectedLanguages: Array.from(languages),
    detectedModules: moduleNames,
    detectedSuites: Object.keys(suites),
  };
}
