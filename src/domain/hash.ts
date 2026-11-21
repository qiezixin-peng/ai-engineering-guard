import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Platform } from './types.js';

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) {
      sorted[key] = canonicalize(v);
    }
  }
  return sorted;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function currentPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

export function getDeviceId(): string {
  return sha256(`${os.hostname()}:${os.platform()}:${os.arch()}`).slice(0, 16);
}

export function parseDurationMs(input: string | undefined, fallbackMs: number): number {
  if (!input) return fallbackMs;
  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(trimmed);
  if (!match) return fallbackMs;
  const num = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'ms':
      return Math.round(num);
    case 's':
      return Math.round(num * 1000);
    case 'm':
      return Math.round(num * 60_000);
    case 'h':
      return Math.round(num * 3_600_000);
    default:
      return fallbackMs;
  }
}

export function parseMemoryMb(input: string | undefined, fallbackMb: number): number {
  if (!input) return fallbackMb;
  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(kb|mb|gb)$/.exec(trimmed);
  if (!match) return fallbackMb;
  const num = Number(match[1]);
  switch (match[2]) {
    case 'kb':
      return num / 1024;
    case 'mb':
      return num;
    case 'gb':
      return num * 1024;
    default:
      return fallbackMb;
  }
}

export function isSubpath(parentDir: string, candidatePath: string): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const rel = path.relative(resolvedParent, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(4).toString('hex');
  return `run-${ts}-${rand}`;
}
