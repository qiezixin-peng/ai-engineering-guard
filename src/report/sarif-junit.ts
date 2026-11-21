import { AEG_VERSION, type QualityReport } from '../domain/types.js';

/**
 * Generates SARIF 2.1.0 JSON on demand for GitHub Code Scanning / CI (Section 12.3 & 5.13).
 */
export function formatSarifReport(report: QualityReport): string {
  const results: Array<Record<string, unknown>> = [];
  const rules = new Map<string, { id: string; name: string; shortDescription: { text: string } }>();

  const ensureRule = (id: string, name: string, description: string) => {
    if (!rules.has(id)) {
      rules.set(id, { id, name, shortDescription: { text: description } });
    }
  };

  for (const r of report.gate.reasons) {
    if (r.severity === 'info') continue;
    const ruleId = `AEG/${r.code}`;
    ensureRule(ruleId, r.code, r.message);
    results.push({
      ruleId,
      level: r.severity === 'blocking' ? 'error' : 'warning',
      message: { text: r.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: '.engineering-guard/config.yaml' },
          },
        },
      ],
    });
  }

  for (const suite of report.results) {
    for (const f of suite.failureDetails) {
      const ruleId = `AEG/test-${f.category}`;
      ensureRule(ruleId, `Test ${f.category}`, `Test suite ${f.category}`);
      const locParts = f.location?.split(':') ?? [];
      const uri = locParts[0] || '.engineering-guard/tests.yaml';
      const lineNum = Number(locParts[1]) || 1;
      results.push({
        ruleId,
        level: 'error',
        message: { text: `[${f.suiteId}] ${f.message}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: uri.replace(/\\/g, '/') },
              region: { startLine: lineNum },
            },
          },
        ],
      });
    }
  }

  for (const factor of report.risk.factors) {
    if (factor.level === 'L4' || factor.nonOverridable) {
      const ruleId = `AEG/risk-${factor.category}`;
      ensureRule(ruleId, factor.category, factor.reason);
      results.push({
        ruleId,
        level: 'warning',
        message: { text: `[${factor.level}] ${factor.reason}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: factor.evidenceRefs[0]?.replace(/\\/g, '/') || '.' },
            },
          },
        ],
      });
    }
  }

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'AI Engineering Guard',
            version: AEG_VERSION,
            informationUri: 'https://ai-engineering-guard.dev',
            rules: Array.from(rules.values()),
          },
        },
        invocations: [
          {
            executionSuccessful: report.gate.outcome !== 'error',
            properties: {
              runId: report.runId,
              mode: report.mode,
              policy: report.policy,
              riskLevel: report.risk.level,
              outcome: report.gate.outcome,
              workflowAction: report.gate.workflowAction,
            },
          },
        ],
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * Generates JUnit XML on demand for legacy CI platforms (Section 12.3 & 5.13).
 */
export function formatJunitReport(report: QualityReport): string {
  const total = report.results.length;
  const failures = report.results.filter((r) => r.status === 'failed').length;
  const errors = report.results.filter(
    (r) => r.status === 'error' || r.status === 'timeout' || r.status === 'cancelled',
  ).length;
  const skipped = report.results.filter((r) => r.status === 'skipped').length;
  const totalSec = (report.timings.runMs / 1000).toFixed(3);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="AI Engineering Guard (${xmlEscape(report.policy)})" tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${totalSec}">`,
  );
  lines.push(
    `  <testsuite name="${xmlEscape(report.runId)}" tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${totalSec}">`,
  );

  for (const r of report.results) {
    const timeSec = (r.durationMs / 1000).toFixed(3);
    const attrs = `classname="aeg.${xmlEscape(r.disposition)}" name="${xmlEscape(r.suiteId)}" time="${timeSec}"`;
    if (r.status === 'passed') {
      lines.push(`    <testcase ${attrs} />`);
    } else if (r.status === 'skipped') {
      lines.push(`    <testcase ${attrs}><skipped message="disposition=${xmlEscape(r.disposition)}" /></testcase>`);
    } else if (r.status === 'failed') {
      const f = r.failureDetails[0];
      lines.push(
        `    <testcase ${attrs}><failure message="${xmlEscape(f?.message ?? 'Suite failed')}">${xmlEscape(f?.excerpt ?? '')}</failure></testcase>`,
      );
    } else {
      const f = r.failureDetails[0];
      lines.push(
        `    <testcase ${attrs}><error message="${xmlEscape(f?.message ?? r.status)}">${xmlEscape(f?.excerpt ?? '')}</error></testcase>`,
      );
    }
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return lines.join('\n');
}

function xmlEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
