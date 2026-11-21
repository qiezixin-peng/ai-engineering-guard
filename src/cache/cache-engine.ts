import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { canonicalJson, hashObject, normalizePosixPath, sha256 } from '../domain/hash.js';
import {
  AEG_VERSION,
  type AegConfig,
  type AnalysisMode,
  type CacheDecision,
  type ExecutionEnvironment,
  type SuiteRunResult,
  type TestSuiteDef,
} from '../domain/types.js';

const CACHE_INDEX_VERSION = 2;

interface CacheEntryRecord {
  mode: 'exact_tree' | 'suite_fingerprint';
  fingerprint: string;
  suiteId: string;
  repositoryTreeHash: string;
  configDigest: string;
  policyDigest: string;
  aegVersion: string;
  platform: string;
  osVersion: string;
  architecture: string;
  toolchainDigest: string;
  status: 'passed';
  outputDigest: string;
  durationMs: number;
  createdAt: string;
  lastAccessedAt: string;
  payloadHash: string;
}

export interface SuiteShadowStat {
  suiteId: string;
  matches: number;
  mismatches: number;
  revoked: boolean;
  revokedAt?: string;
  lastCheckedAt: string;
}

interface CacheIndexFile {
  version: number;
  entries: Record<string, CacheEntryRecord>;
  shadowStats: Record<string, SuiteShadowStat>;
}

export interface CacheKeyInput {
  repositoryTreeHash: string;
  suiteId: string;
  executionVariant: string;
  suiteDef: TestSuiteDef;
  configDigest: string;
  policyDigest: string;
  environment: ExecutionEnvironment;
  allowedEnvValues: Record<string, string>;
}

export class CacheEngine {
  private readonly workspaceRoot: string;
  private readonly cacheDir: string;
  private readonly indexPath: string;
  private readonly maxBytes: number;

  constructor(workspaceRoot: string, config: AegConfig) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    const dirRel = config.cache?.directory ?? '.aeg/cache';
    this.cacheDir = path.resolve(this.workspaceRoot, dirRel);
    this.indexPath = path.join(this.cacheDir, 'index.json');
    this.maxBytes = (config.cache?.max_size_mb ?? 256) * 1024 * 1024;
  }

  computeExactTreeFingerprint(input: CacheKeyInput): string {
    return hashObject({
      mode: 'exact_tree',
      repositoryTreeHash: input.repositoryTreeHash,
      suiteId: input.suiteId,
      executionVariant: input.executionVariant,
      framework: input.suiteDef.framework,
      level: input.suiteDef.level,
      command: input.suiteDef.command,
      configDigest: input.configDigest,
      policyDigest: input.policyDigest,
      aegVersion: AEG_VERSION,
      environment: {
        platform: input.environment.platform,
        osVersion: input.environment.osVersion,
        architecture: input.environment.architecture,
        runtimeVersions: input.environment.runtimeVersions,
        toolchainDigest: input.environment.toolchainDigest,
      },
      allowedEnvValues: input.allowedEnvValues,
    });
  }

  computeSuiteInputFingerprint(input: CacheKeyInput): string | undefined {
    const suiteCache = input.suiteDef.cache;
    if (typeof suiteCache !== 'object' || !suiteCache.hermetic) return undefined;
    const patterns = suiteCache.inputs ?? [];
    if (patterns.length === 0) return undefined;

    const matcher = picomatch(patterns, { dot: true });
    const matchedFileHashes: Array<{ path: string; hash: string }> = [];
    const skip = new Set(['node_modules', '.git', '.aeg', 'dist', 'build', 'coverage']);

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(full);
        } else if (entry.isFile()) {
          const rel = normalizePosixPath(path.relative(this.workspaceRoot, full));
          if (matcher(rel)) {
            matchedFileHashes.push({
              path: rel,
              hash: sha256(fs.readFileSync(full)),
            });
          }
        }
      }
    };

    walk(this.workspaceRoot);
    matchedFileHashes.sort((a, b) => a.path.localeCompare(b.path));

    return hashObject({
      mode: 'suite_fingerprint',
      suiteId: input.suiteId,
      executionVariant: input.executionVariant,
      framework: input.suiteDef.framework,
      level: input.suiteDef.level,
      command: input.suiteDef.command,
      inputs: matchedFileHashes,
      configDigest: input.configDigest,
      policyDigest: input.policyDigest,
      aegVersion: AEG_VERSION,
      environment: {
        platform: input.environment.platform,
        osVersion: input.environment.osVersion,
        architecture: input.environment.architecture,
        runtimeVersions: input.environment.runtimeVersions,
        toolchainDigest: input.environment.toolchainDigest,
      },
      allowedEnvValues: input.allowedEnvValues,
    });
  }

  private computeRecordIntegrityHash(record: Omit<CacheEntryRecord, 'payloadHash'>): string {
    return sha256(canonicalJson(record));
  }

  private readIndexSafe(): { index: CacheIndexFile; recovered: boolean } {
    if (!fs.existsSync(this.indexPath)) {
      return { index: { version: CACHE_INDEX_VERSION, entries: {}, shadowStats: {} }, recovered: false };
    }
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as CacheIndexFile;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.version !== CACHE_INDEX_VERSION ||
        typeof parsed.entries !== 'object' ||
        parsed.entries === null
      ) {
        throw new Error('Incompatible cache index schema');
      }
      if (!parsed.shadowStats || typeof parsed.shadowStats !== 'object') {
        parsed.shadowStats = {};
      }
      return { index: parsed, recovered: false };
    } catch {
      try {
        fs.rmSync(this.indexPath, { force: true });
      } catch {
        // ignore
      }
      return { index: { version: CACHE_INDEX_VERSION, entries: {}, shadowStats: {} }, recovered: true };
    }
  }

  private writeIndexAtomic(index: CacheIndexFile): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const tmpPath = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.indexPath);
  }

  getShadowStats(suiteId?: string): Record<string, SuiteShadowStat> {
    const { index } = this.readIndexSafe();
    if (suiteId) {
      return index.shadowStats[suiteId] ? { [suiteId]: index.shadowStats[suiteId]! } : {};
    }
    return index.shadowStats;
  }

  private resolveEffectiveSuiteFingerprintMode(
    config: AegConfig,
    suiteDef: TestSuiteDef,
  ): 'disabled' | 'shadow' | 'enabled' {
    const globalMode = config.cache?.suite_fingerprint?.mode ?? 'disabled';
    if (globalMode === 'disabled') return 'disabled';
    if (typeof suiteDef.cache !== 'object' || !suiteDef.cache.hermetic) return 'disabled';
    const suiteMode = suiteDef.cache.cross_commit ?? 'disabled';
    if (suiteMode === 'disabled') return 'disabled';
    if (globalMode === 'enabled' && suiteMode === 'enabled') return 'enabled';
    return 'shadow';
  }

  evaluateLookup(params: {
    config: AegConfig;
    mode: AnalysisMode;
    confidence: number;
    disableCacheFlag?: boolean;
    keyInput: CacheKeyInput;
  }): CacheDecision {
    const { config, mode, confidence, disableCacheFlag, keyInput } = params;
    const fingerprint = this.computeExactTreeFingerprint(keyInput);

    if (disableCacheFlag) {
      return {
        mode: 'disabled',
        decision: 'miss',
        fingerprint,
        reasons: ['Cache bypassed via --no-cache flag.'],
        evidenceRefs: [],
      };
    }

    if (config.cache?.enabled === false || config.cache?.exact_tree === false) {
      return {
        mode: 'disabled',
        decision: 'miss',
        fingerprint,
        reasons: ['Cache is disabled by project configuration.'],
        evidenceRefs: [],
      };
    }

    if (mode === 'release') {
      return {
        mode: 'disabled',
        decision: 'rejected',
        fingerprint,
        reasons: ['Release mode forbids reusing development cache results.'],
        evidenceRefs: [],
      };
    }

    const suiteCache = keyInput.suiteDef.cache;
    if (suiteCache === false || (typeof suiteCache === 'object' && suiteCache.enabled === false)) {
      return {
        mode: 'disabled',
        decision: 'miss',
        fingerprint,
        reasons: [`Cache explicitly disabled for suite '${keyInput.suiteId}'.`],
        evidenceRefs: [],
      };
    }

    if (
      (keyInput.suiteDef.level === 'e2e' || keyInput.suiteDef.level === 'security') &&
      suiteCache !== true &&
      !(typeof suiteCache === 'object' && suiteCache.enabled === true)
    ) {
      return {
        mode: 'disabled',
        decision: 'rejected',
        fingerprint,
        reasons: [`Cache is disabled by default for ${keyInput.suiteDef.level} suite '${keyInput.suiteId}'.`],
        evidenceRefs: [],
      };
    }

    const minConfidence = config.analysis?.minimum_confidence ?? 0.75;
    if (confidence < minConfidence) {
      return {
        mode: 'exact_tree',
        decision: 'rejected',
        fingerprint,
        reasons: [`Impact confidence (${confidence}) below threshold (${minConfidence}); cache rejected.`],
        evidenceRefs: [],
      };
    }

    const { index, recovered } = this.readIndexSafe();
    if (recovered) {
      return {
        mode: 'exact_tree',
        decision: 'miss',
        fingerprint,
        reasons: ['Cache index was corrupted and reset; re-executing suite safely.'],
        evidenceRefs: [],
      };
    }

    // 1. Check Exact Git Tree Cache first (most trustworthy)
    const exactEntry = index.entries[fingerprint];
    if (exactEntry) {
      const check = this.validateEntry(exactEntry, keyInput, 'exact_tree', index);
      if (check.valid) {
        return {
          mode: 'exact_tree',
          decision: 'hit',
          fingerprint,
          reasons: [
            `Exact Git Tree cache hit (tree=${exactEntry.repositoryTreeHash.slice(0, 12)}, platform=${exactEntry.platform}, recorded=${exactEntry.createdAt}).`,
          ],
          evidenceRefs: [`cache:${fingerprint.slice(0, 16)}`],
        };
      }
      return {
        mode: 'exact_tree',
        decision: 'rejected',
        fingerprint,
        reasons: [check.reason],
        evidenceRefs: [],
      };
    }

    // 2. Check SuiteInputFingerprint (Phase 2: shadow_candidate or controlled cross-commit hit)
    const suiteFpMode = this.resolveEffectiveSuiteFingerprintMode(config, keyInput.suiteDef);
    if (suiteFpMode !== 'disabled') {
      const stat = index.shadowStats[keyInput.suiteId];
      if (stat?.revoked) {
        return {
          mode: 'suite_fingerprint',
          decision: 'rejected',
          fingerprint,
          reasons: [
            `Suite '${keyInput.suiteId}' cross-commit cache eligibility was revoked at ${stat.revokedAt} after shadow mismatch.`,
          ],
          evidenceRefs: [],
        };
      }

      const suiteFp = this.computeSuiteInputFingerprint(keyInput);
      if (suiteFp) {
        const suiteEntry = index.entries[suiteFp];
        if (suiteEntry) {
          const check = this.validateEntry(suiteEntry, keyInput, 'suite_fingerprint', index);
          if (check.valid) {
            if (suiteFpMode === 'shadow') {
              return {
                mode: 'suite_fingerprint',
                decision: 'shadow_candidate',
                fingerprint: suiteFp,
                reasons: [
                  `SuiteInputFingerprint shadow candidate hit (fp=${suiteFp.slice(0, 12)}); executing suite to verify consistency.`,
                ],
                evidenceRefs: [`shadow-cache:${suiteFp.slice(0, 16)}`],
              };
            }
            return {
              mode: 'suite_fingerprint',
              decision: 'hit',
              fingerprint: suiteFp,
              reasons: [
                `Hermetic SuiteInputFingerprint cache hit (fp=${suiteFp.slice(0, 12)}, platform=${suiteEntry.platform}).`,
              ],
              evidenceRefs: [`suite-cache:${suiteFp.slice(0, 16)}`],
            };
          }
        }
      }
    }

    return {
      mode: 'exact_tree',
      decision: 'miss',
      fingerprint,
      reasons: ['No matching exact Git Tree cache entry found.'],
      evidenceRefs: [],
    };
  }

  private validateEntry(
    entry: CacheEntryRecord,
    keyInput: CacheKeyInput,
    expectedMode: 'exact_tree' | 'suite_fingerprint',
    index: CacheIndexFile,
  ): { valid: boolean; reason: string } {
    const { payloadHash, ...rest } = entry;
    const expectedHash = this.computeRecordIntegrityHash(rest);
    if (payloadHash !== expectedHash) {
      delete index.entries[entry.fingerprint];
      this.writeIndexAtomic(index);
      return { valid: false, reason: 'Cache entry failed integrity verification; evicted and re-executing.' };
    }

    if (
      entry.mode !== expectedMode ||
      (expectedMode === 'exact_tree' && entry.repositoryTreeHash !== keyInput.repositoryTreeHash) ||
      entry.configDigest !== keyInput.configDigest ||
      entry.policyDigest !== keyInput.policyDigest ||
      entry.aegVersion !== AEG_VERSION ||
      entry.platform !== keyInput.environment.platform ||
      entry.architecture !== keyInput.environment.architecture ||
      entry.toolchainDigest !== keyInput.environment.toolchainDigest
    ) {
      return { valid: false, reason: 'Cache entry metadata mismatch (tree/policy/platform/version); re-executing.' };
    }

    entry.lastAccessedAt = new Date().toISOString();
    const { payloadHash: _ignored, ...updatedRest } = entry;
    entry.payloadHash = this.computeRecordIntegrityHash(updatedRest);
    try {
      this.writeIndexAtomic(index);
    } catch {
      // non-fatal
    }
    return { valid: true, reason: 'ok' };
  }

  recordShadowComparison(params: {
    suiteId: string;
    cacheDecision?: CacheDecision;
    actualStatus: SuiteRunResult['status'];
  }): { mismatch: boolean; revoked: boolean } {
    if (params.cacheDecision?.decision !== 'shadow_candidate') {
      return { mismatch: false, revoked: false };
    }

    const { index } = this.readIndexSafe();
    const now = new Date().toISOString();
    const stat: SuiteShadowStat = index.shadowStats[params.suiteId] ?? {
      suiteId: params.suiteId,
      matches: 0,
      mismatches: 0,
      revoked: false,
      lastCheckedAt: now,
    };

    stat.lastCheckedAt = now;
    if (params.actualStatus === 'passed') {
      stat.matches += 1;
      index.shadowStats[params.suiteId] = stat;
      this.writeIndexAtomic(index);
      return { mismatch: false, revoked: stat.revoked };
    }

    // Section 10.6 & Acceptance #24: Single inconsistency IMMEDIATELY revokes eligibility & invalidates suite cache!
    stat.mismatches += 1;
    stat.revoked = true;
    stat.revokedAt = now;
    index.shadowStats[params.suiteId] = stat;

    for (const [key, entry] of Object.entries(index.entries)) {
      if (entry.suiteId === params.suiteId && entry.mode === 'suite_fingerprint') {
        delete index.entries[key];
      }
    }

    this.writeIndexAtomic(index);
    return { mismatch: true, revoked: true };
  }

  storePassedResult(params: {
    config: AegConfig;
    keyInput: CacheKeyInput;
    result: SuiteRunResult;
  }): void {
    if (params.result.status !== 'passed') return;
    if (params.config.cache?.enabled === false || params.config.cache?.exact_tree === false) return;
    const suiteCache = params.keyInput.suiteDef.cache;
    if (suiteCache === false || (typeof suiteCache === 'object' && suiteCache.enabled === false)) return;

    const { index } = this.readIndexSafe();
    const now = new Date().toISOString();

    const saveEntry = (mode: 'exact_tree' | 'suite_fingerprint', fp: string) => {
      const baseRecord: Omit<CacheEntryRecord, 'payloadHash'> = {
        mode,
        fingerprint: fp,
        suiteId: params.keyInput.suiteId,
        repositoryTreeHash: params.keyInput.repositoryTreeHash,
        configDigest: params.keyInput.configDigest,
        policyDigest: params.keyInput.policyDigest,
        aegVersion: AEG_VERSION,
        platform: params.keyInput.environment.platform,
        osVersion: params.keyInput.environment.osVersion,
        architecture: params.keyInput.environment.architecture,
        toolchainDigest: params.keyInput.environment.toolchainDigest,
        status: 'passed',
        outputDigest: params.result.outputDigest,
        durationMs: params.result.durationMs,
        createdAt: now,
        lastAccessedAt: now,
      };
      index.entries[fp] = {
        ...baseRecord,
        payloadHash: this.computeRecordIntegrityHash(baseRecord),
      };
    };

    // Always save Exact Git Tree entry
    saveEntry('exact_tree', this.computeExactTreeFingerprint(params.keyInput));

    // Also save SuiteInputFingerprint entry if enabled/shadow and NOT revoked
    const suiteFpMode = this.resolveEffectiveSuiteFingerprintMode(params.config, params.keyInput.suiteDef);
    if (suiteFpMode !== 'disabled' && !index.shadowStats[params.keyInput.suiteId]?.revoked) {
      const suiteFp = this.computeSuiteInputFingerprint(params.keyInput);
      if (suiteFp) {
        saveEntry('suite_fingerprint', suiteFp);
      }
    }

    this.pruneIfNeeded(index);
    this.writeIndexAtomic(index);
  }

  private pruneIfNeeded(index: CacheIndexFile): void {
    const serialized = JSON.stringify(index);
    const maxEntries = Math.max(50, Math.floor(this.maxBytes / 2048));
    const keys = Object.keys(index.entries);
    if (Buffer.byteLength(serialized, 'utf8') <= this.maxBytes && keys.length <= maxEntries) {
      return;
    }

    const sorted = Object.values(index.entries).sort((a, b) =>
      a.lastAccessedAt.localeCompare(b.lastAccessedAt),
    );
    const toRemove = Math.max(1, Math.ceil(sorted.length * 0.25));
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      delete index.entries[sorted[i]!.fingerprint];
    }
  }
}
