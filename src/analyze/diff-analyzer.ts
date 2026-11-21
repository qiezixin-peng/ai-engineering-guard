import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import YAML from 'yaml';
import { PACKAGE_ROOT } from '../config/schema-validator.js';
import type { AegConfig, ChangedFile, ChangeSet, FileCategory } from '../domain/types.js';

interface DefaultRulesFile {
  default_doc_patterns: string[];
  default_db_migration_patterns: string[];
  default_security_auth_patterns: string[];
  default_release_signing_patterns: string[];
  default_lockfile_patterns: string[];
}

let cachedDefaultRules: DefaultRulesFile | null = null;

export function loadDefaultRules(): DefaultRulesFile {
  if (cachedDefaultRules) return cachedDefaultRules;
  const rulesPath = path.join(PACKAGE_ROOT, 'rules', 'default', 'rules.yaml');
  cachedDefaultRules = YAML.parse(fs.readFileSync(rulesPath, 'utf8')) as DefaultRulesFile;
  return cachedDefaultRules;
}

const TEST_PATTERNS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  'tests/**',
  'test/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/*_test.go',
];

const CONFIG_PATTERNS = [
  'package.json',
  'tsconfig*.json',
  'vite.config.*',
  'vitest.config.*',
  'jest.config.*',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Cargo.toml',
  'go.mod',
  'Makefile',
  'Dockerfile*',
  'docker-compose*.yml',
  'docker-compose*.yaml',
  '.env*',
];

const CI_PATTERNS = [
  '.github/workflows/**',
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  '.circleci/**',
  'Jenkinsfile',
];

const GENERATED_PATTERNS = [
  '**/dist/**',
  '**/build/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.generated.*',
  '**/generated/**',
];

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
  '.rb', '.php', '.swift', '.scala', '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat',
  '.vue', '.svelte', '.html', '.css', '.scss', '.less',
]);

function makeMatcher(patterns: string[]) {
  if (patterns.length === 0) return () => false;
  return picomatch(patterns, { dot: true, nocase: false });
}

export function classifyChangeSet(changeSet: ChangeSet, config: AegConfig): ChangeSet {
  const defaults = loadDefaultRules();

  const matchGuard = makeMatcher(['.engineering-guard/**']);
  const matchDocs = makeMatcher([
    ...defaults.default_doc_patterns,
    ...(config.analysis?.doc_paths ?? []),
  ]);
  const matchDb = makeMatcher(defaults.default_db_migration_patterns);
  const matchSec = makeMatcher(defaults.default_security_auth_patterns);
  const matchRelease = makeMatcher(defaults.default_release_signing_patterns);
  const matchLock = makeMatcher(defaults.default_lockfile_patterns);
  const matchTest = makeMatcher(TEST_PATTERNS);
  const matchConfig = makeMatcher(CONFIG_PATTERNS);
  const matchCi = makeMatcher(CI_PATTERNS);
  const matchGenerated = makeMatcher(GENERATED_PATTERNS);

  const classifiedFiles: ChangedFile[] = changeSet.files.map((file) => {
    const categories: FileCategory[] = [];
    const p = file.path;

    if (matchGuard(p)) categories.push('guard_config');
    if (matchDb(p)) categories.push('db_migration');
    if (matchSec(p)) categories.push('security_auth');
    if (matchRelease(p)) categories.push('release_signing');
    if (matchCi(p)) categories.push('ci');
    if (matchLock(p)) categories.push('lockfile');
    if (matchTest(p)) categories.push('test');
    if (matchConfig(p)) categories.push('config');
    if (matchGenerated(p)) categories.push('generated');
    if (file.binary) categories.push('binary');

    if (matchDocs(p) && categories.length === 0) {
      categories.push('docs');
    }

    const ext = path.posix.extname(p).toLowerCase();
    if (CODE_EXTENSIONS.has(ext) && !categories.includes('test') && !categories.includes('docs')) {
      categories.push('code');
    }

    if (categories.length === 0) {
      categories.push('unknown');
    }

    return {
      ...file,
      categories,
    };
  });

  return {
    ...changeSet,
    files: classifiedFiles,
  };
}
