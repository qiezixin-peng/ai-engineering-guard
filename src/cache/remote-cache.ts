import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, parseDurationMs } from '../domain/hash.js';
import {
  AEG_VERSION,
  type AegConfig,
  type ExecutionEnvironment,
  type Platform,
} from '../domain/types.js';

export interface SignedRemoteCacheEntry {
  schemaVersion: 1;
  tenantId: string;
  projectId: string;
  suiteId: string;
  fingerprint: string;
  repositoryTreeHash: string;
  configDigest: string;
  policyDigest: string;
  aegVersion: string;
  platform: Platform;
  architecture: string;
  toolchainDigest: string;
  portable: boolean;
  status: 'passed';
  outputDigest: string;
  durationMs: number;
  createdAt: string;
  signature: string;
}

export interface RemoteCacheLookupResult {
  hit: boolean;
  entry?: SignedRemoteCacheEntry;
  reason: string;
}

export function signRemoteCachePayload(
  payload: Omit<SignedRemoteCacheEntry, 'signature'>,
  secret: string,
): SignedRemoteCacheEntry {
  const sig = crypto.createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
  return { ...payload, signature: sig };
}

export function verifyRemoteCacheSignature(
  entry: SignedRemoteCacheEntry,
  secret: string,
): boolean {
  if (!entry.signature) return false;
  const { signature, ...unsigned } = entry;
  const expected = crypto.createHmac('sha256', secret).update(canonicalJson(unsigned)).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sanitizeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class RemoteCacheClient {
  private readonly backend: 'local' | 'remote-dir' | 'remote-http';
  private readonly tenantId: string;
  private readonly projectId: string;
  private readonly readOnly: boolean;
  private readonly requireSignature: boolean;
  private readonly crossPlatform: boolean;
  private readonly timeoutMs: number;
  private readonly remoteDir?: string;
  private readonly remoteUrl?: string;
  private readonly signingSecret?: string;
  private readonly authToken?: string;

  constructor(params: {
    config: AegConfig;
    signingSecret?: string;
    authToken?: string;
  }) {
    const cacheCfg = params.config.cache;
    const remoteCfg = cacheCfg?.remote;
    this.backend = cacheCfg?.backend ?? 'local';
    this.tenantId = sanitizeSegment(remoteCfg?.tenant_id ?? 'default');
    this.projectId = sanitizeSegment(params.config.project.name);
    this.readOnly = remoteCfg?.read_only !== false; // Default read-only pull for untrusted branches (Section 17.3)
    this.requireSignature = remoteCfg?.require_signature !== false;
    this.crossPlatform = cacheCfg?.cross_platform === true;
    this.timeoutMs = parseDurationMs(remoteCfg?.timeout, 2000);
    this.remoteDir = remoteCfg?.directory;
    this.remoteUrl = remoteCfg?.url?.replace(/\/+$/, '');
    this.signingSecret = params.signingSecret ?? process.env.AEG_REMOTE_CACHE_SECRET;
    this.authToken = params.authToken ?? process.env.AEG_REMOTE_CACHE_TOKEN;
  }

  isEnabled(): boolean {
    if (this.backend === 'remote-dir') return Boolean(this.remoteDir);
    if (this.backend === 'remote-http') return Boolean(this.remoteUrl);
    return false;
  }

  private buildNamespacePath(platform: Platform, arch: string, fingerprint: string): string {
    return path.posix.join(
      this.tenantId,
      this.projectId,
      platform,
      sanitizeSegment(arch),
      `${sanitizeSegment(fingerprint)}.json`,
    );
  }

  async pull(params: {
    fingerprint: string;
    suiteId: string;
    portable: boolean;
    repositoryTreeHash: string;
    configDigest: string;
    policyDigest: string;
    environment: ExecutionEnvironment;
  }): Promise<RemoteCacheLookupResult> {
    if (!this.isEnabled()) {
      return { hit: false, reason: 'Remote cache not enabled.' };
    }

    if (this.requireSignature && !this.signingSecret) {
      return {
        hit: false,
        reason: 'Remote cache requires signed entries, but AEG_REMOTE_CACHE_SECRET is not configured.',
      };
    }

    const nsKey = this.buildNamespacePath(
      params.environment.platform,
      params.environment.architecture,
      params.fingerprint,
    );

    let rawEntry: SignedRemoteCacheEntry | undefined;
    try {
      if (this.backend === 'remote-dir' && this.remoteDir) {
        const fullPath = path.resolve(this.remoteDir, nsKey);
        if (!fs.existsSync(fullPath)) {
          return { hit: false, reason: 'Remote directory cache miss.' };
        }
        rawEntry = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as SignedRemoteCacheEntry;
      } else if (this.backend === 'remote-http' && this.remoteUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const headers: Record<string, string> = { Accept: 'application/json' };
          if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
          const res = await fetch(`${this.remoteUrl}/${nsKey}`, {
            method: 'GET',
            headers,
            signal: controller.signal,
          });
          if (res.status === 404) {
            return { hit: false, reason: 'Remote HTTP cache miss (404).' };
          }
          if (!res.ok) {
            return { hit: false, reason: `Remote HTTP cache error (${res.status}); falling back to execute.` };
          }
          rawEntry = (await res.json()) as SignedRemoteCacheEntry;
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err: unknown) {
      // Section 17.3: Never fail-open on remote cache outage/corruption
      return {
        hit: false,
        reason: `Remote cache unreachable or unreadable (${err instanceof Error ? err.message : String(err)}); re-executing safely.`,
      };
    }

    if (!rawEntry || rawEntry.schemaVersion !== 1 || rawEntry.status !== 'passed') {
      return { hit: false, reason: 'Remote cache payload malformed or non-passing; rejected.' };
    }

    // 1. Verify HMAC signature
    if (this.requireSignature) {
      if (!this.signingSecret || !verifyRemoteCacheSignature(rawEntry, this.signingSecret)) {
        return { hit: false, reason: 'Remote cache entry failed cryptographic signature verification; rejected.' };
      }
    }

    // 2. Verify tenant, project, tree, policy, version, and platform isolation
    if (rawEntry.tenantId !== this.tenantId || rawEntry.projectId !== this.projectId) {
      return { hit: false, reason: 'Remote cache tenant/project isolation mismatch; rejected.' };
    }
    if (
      rawEntry.suiteId !== params.suiteId ||
      rawEntry.repositoryTreeHash !== params.repositoryTreeHash ||
      rawEntry.configDigest !== params.configDigest ||
      rawEntry.policyDigest !== params.policyDigest ||
      rawEntry.aegVersion !== AEG_VERSION
    ) {
      return { hit: false, reason: 'Remote cache tree/policy/version binding mismatch; rejected.' };
    }

    const samePlatform =
      rawEntry.platform === params.environment.platform &&
      rawEntry.architecture === params.environment.architecture &&
      rawEntry.toolchainDigest === params.environment.toolchainDigest;

    if (!samePlatform) {
      if (!this.crossPlatform || !params.portable || !rawEntry.portable) {
        return {
          hit: false,
          reason: `Cross-platform remote cache reuse denied (${rawEntry.platform} -> ${params.environment.platform}).`,
        };
      }
    }

    return {
      hit: true,
      entry: rawEntry,
      reason: `Verified signed remote cache hit (${this.backend}, tenant=${this.tenantId}, platform=${rawEntry.platform}).`,
    };
  }

  async push(params: {
    fingerprint: string;
    suiteId: string;
    portable: boolean;
    repositoryTreeHash: string;
    configDigest: string;
    policyDigest: string;
    environment: ExecutionEnvironment;
    outputDigest: string;
    durationMs: number;
  }): Promise<{ pushed: boolean; reason: string }> {
    if (!this.isEnabled()) {
      return { pushed: false, reason: 'Remote cache not enabled.' };
    }

    // Section 17.3: Untrusted branches / read_only clients cannot overwrite protected remote cache
    if (this.readOnly) {
      return {
        pushed: false,
        reason: 'Remote cache is configured read_only; write skipped to protect trusted cache namespace.',
      };
    }

    if (this.requireSignature && !this.signingSecret) {
      return {
        pushed: false,
        reason: 'Cannot push unsigned entry when require_signature is true.',
      };
    }

    const unsigned: Omit<SignedRemoteCacheEntry, 'signature'> = {
      schemaVersion: 1,
      tenantId: this.tenantId,
      projectId: this.projectId,
      suiteId: params.suiteId,
      fingerprint: params.fingerprint,
      repositoryTreeHash: params.repositoryTreeHash,
      configDigest: params.configDigest,
      policyDigest: params.policyDigest,
      aegVersion: AEG_VERSION,
      platform: params.environment.platform,
      architecture: params.environment.architecture,
      toolchainDigest: params.environment.toolchainDigest,
      portable: params.portable,
      status: 'passed',
      outputDigest: params.outputDigest,
      durationMs: params.durationMs,
      createdAt: new Date().toISOString(),
    };

    const entry: SignedRemoteCacheEntry = this.signingSecret
      ? signRemoteCachePayload(unsigned, this.signingSecret)
      : { ...unsigned, signature: '' };

    const nsKey = this.buildNamespacePath(
      params.environment.platform,
      params.environment.architecture,
      params.fingerprint,
    );

    try {
      if (this.backend === 'remote-dir' && this.remoteDir) {
        const fullPath = path.resolve(this.remoteDir, nsKey);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        const tmp = `${fullPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
        fs.renameSync(tmp, fullPath);
        return { pushed: true, reason: `Stored signed remote cache entry at ${nsKey}.` };
      }

      if (this.backend === 'remote-http' && this.remoteUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
          const res = await fetch(`${this.remoteUrl}/${nsKey}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify(entry),
            signal: controller.signal,
          });
          if (!res.ok) {
            return { pushed: false, reason: `Remote HTTP PUT failed (${res.status}).` };
          }
          return { pushed: true, reason: `Uploaded signed remote cache entry (${nsKey}).` };
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err: unknown) {
      return {
        pushed: false,
        reason: `Remote cache push failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return { pushed: false, reason: 'Unsupported remote backend.' };
  }
}
