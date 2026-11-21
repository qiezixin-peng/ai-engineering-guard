import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../domain/hash.js';
import {
  AEG_VERSION,
  EXIT_CODES,
  type ExitCode,
  type GateDecision,
  type GateReason,
  type Platform,
  type TestPlan,
  type TestResultReceipt,
  type TestsConfig,
} from '../domain/types.js';

export interface ReceiptRegistrationResult {
  accepted: boolean;
  reason: string;
  receiptId: string;
}

export interface PlatformCoverageEntry {
  suiteId: string;
  platform: Platform;
  required: boolean;
  satisfied: boolean;
  status?: TestResultReceipt['status'];
  attemptId?: string;
  receiptId?: string;
  deviceId?: string;
}

export interface AggregatedGateReport {
  planId: string;
  planDigest: string;
  repositoryTreeHash: string;
  policy: string;
  acceptedReceipts: TestResultReceipt[];
  rejectedReceipts: Array<{ receiptId: string; suiteId: string; reason: string }>;
  platformCoverage: PlatformCoverageEntry[];
  missingSlots: Array<{ suiteId: string; platform: Platform }>;
  gate: GateDecision;
  exitCode: ExitCode;
}

export function signReceipt(receipt: Omit<TestResultReceipt, 'signature'>, secret: string): TestResultReceipt {
  const payload = canonicalJson(receipt);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { ...receipt, signature: sig };
}

export function verifyReceiptSignature(receipt: TestResultReceipt, secret: string): boolean {
  if (!receipt.signature) return false;
  const { signature, ...unsigned } = receipt;
  const expected = crypto.createHmac('sha256', secret).update(canonicalJson(unsigned)).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function majorVersionOf(ver: string): string {
  return ver.split('.')[0] ?? ver;
}

function parseAttemptOrder(attemptId: string): number {
  const match = /(\d+)$/.exec(attemptId.trim());
  return match ? Number(match[1]) : 0;
}

export interface AggregatorOptions {
  plan: TestPlan;
  tests?: TestsConfig;
  policy?: string;
  signingSecret?: string;
  requireSignature?: boolean;
  expectedProjectId?: string;
}

export class CoordinatorReceiptAggregator {
  private readonly plan: TestPlan;
  private readonly tests?: TestsConfig;
  private readonly policy: string;
  private readonly signingSecret?: string;
  private readonly requireSignature: boolean;
  private readonly expectedProjectId?: string;

  private readonly seenReceiptIds = new Set<string>();
  private readonly acceptedBySlot = new Map<string, TestResultReceipt>();
  private readonly rejected: Array<{ receiptId: string; suiteId: string; reason: string }> = [];

  constructor(options: AggregatorOptions) {
    this.plan = options.plan;
    this.tests = options.tests;
    this.policy = options.policy ?? 'delivery';
    this.signingSecret = options.signingSecret;
    this.requireSignature = Boolean(options.requireSignature);
    this.expectedProjectId = options.expectedProjectId;
  }

  register(receipt: TestResultReceipt): ReceiptRegistrationResult {
    const reject = (reason: string): ReceiptRegistrationResult => {
      this.rejected.push({ receiptId: receipt.receiptId, suiteId: receipt.suiteId, reason });
      return { accepted: false, reason, receiptId: receipt.receiptId };
    };

    // 1. Replay protection
    if (this.seenReceiptIds.has(receipt.receiptId)) {
      return reject(`Duplicate receipt replay rejected: '${receipt.receiptId}'.`);
    }
    this.seenReceiptIds.add(receipt.receiptId);

    // 2. Plan expiry
    if (this.plan.expiresAt && Date.now() > Date.parse(this.plan.expiresAt)) {
      return reject(`Plan '${this.plan.id}' expired at ${this.plan.expiresAt}.`);
    }

    // 3. Project binding
    if (this.expectedProjectId && receipt.projectId !== this.expectedProjectId) {
      return reject(`Project mismatch: expected '${this.expectedProjectId}', got '${receipt.projectId}'.`);
    }

    // 4. Plan / tree / config / policy digest binding (Section 9.6 & 17.4)
    if (receipt.planDigest !== this.plan.planDigest) {
      return reject(`Plan digest mismatch: expected '${this.plan.planDigest.slice(0, 12)}', got '${receipt.planDigest.slice(0, 12)}'.`);
    }
    if (receipt.repositoryTreeHash !== this.plan.repositoryTreeHash) {
      return reject(`Repository tree hash mismatch: receipt is for a different code snapshot.`);
    }
    if (receipt.configDigest !== this.plan.configDigest) {
      return reject(`Config digest mismatch.`);
    }
    if (receipt.policyDigest !== this.plan.policyDigest) {
      return reject(`Policy digest mismatch.`);
    }

    // 5. AEG major version compatibility (Section 19)
    if (majorVersionOf(receipt.environment.aegVersion) !== majorVersionOf(AEG_VERSION)) {
      return reject(
        `Incompatible AEG major version: receipt used '${receipt.environment.aegVersion}', coordinator requires '${AEG_VERSION}'.`,
      );
    }

    // 6. Signature check if required / configured
    if (this.signingSecret) {
      if (!verifyReceiptSignature(receipt, this.signingSecret)) {
        return reject(`Receipt signature verification failed.`);
      }
    } else if (this.requireSignature && !receipt.signature) {
      return reject(`Signed receipt required, but signature is missing.`);
    }

    // 7. Suite & platform membership
    const plannedSuite = this.plan.suites.find((s) => s.suiteId === receipt.suiteId);
    if (!plannedSuite) {
      return reject(`Suite '${receipt.suiteId}' is not part of plan '${this.plan.id}'.`);
    }
    if (!plannedSuite.requiredPlatforms.includes(receipt.environment.platform)) {
      return reject(
        `Platform '${receipt.environment.platform}' is not required for suite '${receipt.suiteId}'.`,
      );
    }

    // 8. Monotonic attempt fencing (Section 17.4 & Acceptance #31)
    const slotKey = `${receipt.suiteId}::${receipt.environment.platform}`;
    const existing = this.acceptedBySlot.get(slotKey);
    if (existing) {
      const existingRank = parseAttemptOrder(existing.attemptId);
      const incomingRank = parseAttemptOrder(receipt.attemptId);
      if (incomingRank < existingRank) {
        return reject(
          `Stale attempt '${receipt.attemptId}' rejected because newer attempt '${existing.attemptId}' is already recorded for ${slotKey}.`,
        );
      }
      if (incomingRank === existingRank && existing.attemptId === receipt.attemptId) {
        return reject(`Attempt '${receipt.attemptId}' already registered for ${slotKey}.`);
      }
    }

    this.acceptedBySlot.set(slotKey, receipt);
    return {
      accepted: true,
      reason: `Accepted receipt '${receipt.receiptId}' for ${slotKey} (${receipt.attemptId}, status=${receipt.status}).`,
      receiptId: receipt.receiptId,
    };
  }

  getPlatformCoverage(): PlatformCoverageEntry[] {
    const coverage: PlatformCoverageEntry[] = [];
    for (const suite of this.plan.suites) {
      const def = this.tests?.suites[suite.suiteId];
      const requiredPlatforms: Platform[] =
        def?.execution === 'once_per_change' && def.portable && def.canonical_platform
          ? [def.canonical_platform]
          : suite.requiredPlatforms;

      for (const platform of requiredPlatforms) {
        const slotKey = `${suite.suiteId}::${platform}`;
        const receipt = this.acceptedBySlot.get(slotKey);
        coverage.push({
          suiteId: suite.suiteId,
          platform,
          required: true,
          satisfied: receipt !== undefined,
          status: receipt?.status,
          attemptId: receipt?.attemptId,
          receiptId: receipt?.receiptId,
          deviceId: receipt?.environment.deviceId,
        });
      }
    }
    return coverage;
  }

  aggregate(): AggregatedGateReport {
    const coverage = this.getPlatformCoverage();
    const missingSlots = coverage
      .filter((c) => c.required && !c.satisfied)
      .map((c) => ({ suiteId: c.suiteId, platform: c.platform }));

    const acceptedReceipts = Array.from(this.acceptedBySlot.values());
    const reasons: GateReason[] = [];
    const requiredActions: string[] = [];

    const errorReceipts = acceptedReceipts.filter(
      (r) => r.status === 'error' || r.status === 'timeout' || r.status === 'cancelled',
    );
    const failedReceipts = acceptedReceipts.filter((r) => r.status === 'failed');

    if (errorReceipts.length > 0) {
      reasons.push({
        code: 'execution_error',
        severity: 'blocking',
        message: `Execution error on remote executor(s): ${errorReceipts
          .map((r) => `${r.suiteId}@${r.environment.platform}(${r.status})`)
          .join(', ')}`,
        evidenceRefs: errorReceipts.map((r) => r.receiptId),
      });
      requiredActions.push('Inspect failing executor logs and re-dispatch failed attempts.');
    }

    if (failedReceipts.length > 0) {
      reasons.push({
        code: 'test_failure',
        severity: 'blocking',
        message: `Test failures reported across platforms: ${failedReceipts
          .map((r) => `${r.suiteId}@${r.environment.platform}`)
          .join(', ')}`,
        evidenceRefs: failedReceipts.map((r) => r.receiptId),
      });
      requiredActions.push('Fix cross-platform test failures and submit updated commit.');
    }

    if (missingSlots.length > 0) {
      reasons.push({
        code: 'missing_platform_evidence',
        severity: 'blocking',
        message: `Missing required platform results: ${missingSlots
          .map((m) => `${m.suiteId}@${m.platform}`)
          .join(', ')}`,
        evidenceRefs: missingSlots.map((m) => `${m.suiteId}@${m.platform}`),
      });
      requiredActions.push('Dispatch and collect receipts from all missing platform executors.');
    }

    if (this.rejected.length > 0) {
      reasons.push({
        code: 'rejected_receipts',
        severity: 'warning',
        message: `${this.rejected.length} invalid/stale/replayed receipt(s) were rejected during aggregation.`,
        evidenceRefs: this.rejected.map((r) => r.receiptId),
      });
    }

    let outcome: GateDecision['outcome'];
    let workflowAction: GateDecision['workflowAction'];
    let exitCode: ExitCode;

    if (errorReceipts.length > 0) {
      outcome = 'error';
      workflowAction = 'block';
      exitCode = EXIT_CODES.TOOL_OR_ENV_ERROR;
    } else if (failedReceipts.length > 0) {
      outcome = 'failed';
      workflowAction = 'block';
      exitCode = EXIT_CODES.TEST_FAILED;
    } else if (missingSlots.length > 0) {
      outcome = 'incomplete';
      workflowAction = 'block';
      exitCode = EXIT_CODES.INCOMPLETE_BLOCKED;
    } else {
      outcome = 'passed';
      workflowAction = 'continue';
      exitCode = EXIT_CODES.OK;
      reasons.push({
        code: 'cross_platform_gate_passed',
        severity: 'info',
        message: `All ${coverage.length} required platform test slot(s) passed with verified receipts.`,
        evidenceRefs: acceptedReceipts.map((r) => r.receiptId),
      });
    }

    return {
      planId: this.plan.id,
      planDigest: this.plan.planDigest,
      repositoryTreeHash: this.plan.repositoryTreeHash,
      policy: this.policy,
      acceptedReceipts,
      rejectedReceipts: [...this.rejected],
      platformCoverage: coverage,
      missingSlots,
      gate: {
        outcome,
        workflowAction,
        policy: this.policy,
        reasons,
        requiredActions,
        evidenceRefs: acceptedReceipts.map((r) => r.receiptId),
      },
      exitCode,
    };
  }
}

export function loadReceiptsFromPath(targetPath: string): TestResultReceipt[] {
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Receipts path not found: ${targetPath}`);
  }
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return Array.isArray(parsed) ? (parsed as TestResultReceipt[]) : [parsed as TestResultReceipt];
  }
  const receipts: TestResultReceipt[] = [];
  for (const entry of fs.readdirSync(abs).sort()) {
    if (!entry.endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(abs, entry), 'utf8'));
    if (Array.isArray(parsed)) receipts.push(...(parsed as TestResultReceipt[]));
    else receipts.push(parsed as TestResultReceipt);
  }
  return receipts;
}
