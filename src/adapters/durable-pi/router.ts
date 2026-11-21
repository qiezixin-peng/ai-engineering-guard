import type { Platform, TestPlan, TestsConfig } from '../../domain/types.js';

export interface ExecutorDescriptor {
  id: string;
  platform: Platform;
  architecture: string;
  capabilities: string[];
  online?: boolean;
}

export interface MatrixAssignment {
  suiteId: string;
  executionVariant: string;
  targetPlatform: Platform;
  executionMode: 'once_per_change' | 'each_platform';
  requiredCapabilities: string[];
  executorId?: string;
  status: 'assigned' | 'reuse_cache' | 'blocked';
  reason: string;
}

export interface ExecutionMatrix {
  planId: string;
  planDigest: string;
  repositoryTreeHash: string;
  assignments: MatrixAssignment[];
  missingPlatforms: Platform[];
  missingCapabilities: string[];
  complete: boolean;
}

export function buildExecutionMatrix(params: {
  plan: TestPlan;
  tests: TestsConfig;
  executors: ExecutorDescriptor[];
}): ExecutionMatrix {
  const { plan, tests, executors } = params;
  const onlineExecutors = executors.filter((e) => e.online !== false);
  const assignments: MatrixAssignment[] = [];
  const missingPlatforms = new Set<Platform>();
  const missingCapabilities = new Set<string>();

  const findExecutor = (platform: Platform, caps: string[]): ExecutorDescriptor | undefined => {
    return onlineExecutors.find(
      (ex) => ex.platform === platform && caps.every((c) => ex.capabilities.includes(c)),
    );
  };

  for (const planned of plan.suites) {
    const def = tests.suites[planned.suiteId];
    const execMode = def?.execution ?? 'each_platform';
    const caps = planned.requiredCapabilities;
    const platforms = planned.requiredPlatforms;

    if (planned.disposition === 'reuse_cache' && execMode === 'once_per_change') {
      assignments.push({
        suiteId: planned.suiteId,
        executionVariant: planned.executionVariant,
        targetPlatform: def?.canonical_platform ?? platforms[0] ?? 'linux',
        executionMode: execMode,
        requiredCapabilities: caps,
        status: 'reuse_cache',
        reason: 'Valid local exact-tree cache hit for portable once_per_change suite.',
      });
      continue;
    }

    if (execMode === 'once_per_change' && def?.portable && def.canonical_platform) {
      const targetPlatform = def.canonical_platform;
      const ex = findExecutor(targetPlatform, caps);
      if (ex) {
        assignments.push({
          suiteId: planned.suiteId,
          executionVariant: planned.executionVariant,
          targetPlatform,
          executionMode: execMode,
          requiredCapabilities: caps,
          executorId: ex.id,
          status: 'assigned',
          reason: `Routed portable suite to canonical platform executor '${ex.id}' (${targetPlatform}).`,
        });
      } else {
        missingPlatforms.add(targetPlatform);
        for (const c of caps) missingCapabilities.add(`${targetPlatform}:${c}`);
        assignments.push({
          suiteId: planned.suiteId,
          executionVariant: planned.executionVariant,
          targetPlatform,
          executionMode: execMode,
          requiredCapabilities: caps,
          status: 'blocked',
          reason: `No online executor on '${targetPlatform}' satisfies capabilities [${caps.join(', ')}].`,
        });
      }
      continue;
    }

    // each_platform: every required platform MUST execute on its true OS executor
    for (const platform of platforms) {
      const ex = findExecutor(platform, caps);
      if (ex) {
        assignments.push({
          suiteId: planned.suiteId,
          executionVariant: planned.executionVariant,
          targetPlatform: platform,
          executionMode: 'each_platform',
          requiredCapabilities: caps,
          executorId: ex.id,
          status: 'assigned',
          reason: `Routed platform-verified suite to '${ex.id}' (${platform}/${ex.architecture}).`,
        });
      } else {
        missingPlatforms.add(platform);
        for (const c of caps) missingCapabilities.add(`${platform}:${c}`);
        assignments.push({
          suiteId: planned.suiteId,
          executionVariant: planned.executionVariant,
          targetPlatform: platform,
          executionMode: 'each_platform',
          requiredCapabilities: caps,
          status: 'blocked',
          reason: `No online executor on '${platform}' satisfies capabilities [${caps.join(', ')}].`,
        });
      }
    }
  }

  return {
    planId: plan.id,
    planDigest: plan.planDigest,
    repositoryTreeHash: plan.repositoryTreeHash,
    assignments,
    missingPlatforms: Array.from(missingPlatforms).sort(),
    missingCapabilities: Array.from(missingCapabilities).sort(),
    complete: assignments.every((a) => a.status !== 'blocked'),
  };
}
