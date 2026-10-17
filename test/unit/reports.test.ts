import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/diff/snapshot-diff.ts';
import {
  formatDiffAnnotations,
  formatDiffJson,
  formatDiffMarkdown,
  formatDiffText,
} from '../../src/report/diff-report.ts';
import { formatAnnotation, markdownCell, markdownCode } from '../../src/report/github.ts';
import { createStyle, shouldColor } from '../../src/report/style.ts';
import {
  formatTestAnnotations,
  formatTestJson,
  formatTestMarkdown,
  formatTestText,
} from '../../src/report/test-report.ts';
import type { ScenarioResult } from '../../src/scenarios/run.ts';
import { ContractViolationError, expectNoBreakingChanges } from '../../src/testing.ts';
import { VERSION } from '../../src/version.ts';
import { snapshotOf, tool } from '../helpers/snapshots.ts';

const before = snapshotOf({
  tools: [
    tool('search', {
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', maximum: 100 } } },
    }),
    tool('legacy'),
  ],
});
const after = snapshotOf({
  tools: [
    tool('search', {
      description: 'Search | everything',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', maximum: 50 } } },
    }),
  ],
});
const result = diffSnapshots(before, after);
const empty = diffSnapshots(before, before);

describe('text report', () => {
  it('groups changes by element and ends with a verdict', () => {
    expect(formatDiffText(result)).toBe(
      [
        '3 changes: 2 breaking, 0 unknown, 1 non-breaking.',
        '',
        'tool legacy',
        '  BREAKING      tool removed; agents that call it will get an error',
        '',
        'tool search',
        '  NON-BREAKING  description added',
        '  BREAKING      inputSchema $.limit: upper bound tightened from <= 100 to <= 50; arguments that were valid before can now be rejected',
        '',
        'FAIL: 2 changes at or above the fail-on threshold (unknown)',
        '',
      ].join('\n'),
    );
  });

  it('passes when nothing reaches the threshold', () => {
    expect(formatDiffText(empty)).toBe('No changes.\n\nPASS (fail-on: unknown)\n');
    expect(
      formatDiffText(diffSnapshots(after, snapshotOf({ tools: [tool('search')] })), {
        failOn: 'breaking',
      }),
    ).toContain('PASS (fail-on: breaking)');
  });

  it('colors only when asked', () => {
    expect(formatDiffText(result)).not.toContain('\u001B[');
    const colored = formatDiffText(result, { color: true });
    expect(colored).toContain('\u001B[31m\u001B[1mBREAKING');
    expect(colored).toContain('\u001B[32mNON-BREAKING');
  });
});

describe('json report', () => {
  it('has a stable, documented shape', () => {
    const report = JSON.parse(formatDiffJson(result, { failOn: 'breaking' })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(report)).toEqual(['passed', 'failOn', 'summary', 'changes']);
    expect(report).toMatchObject({
      passed: false,
      failOn: 'breaking',
      summary: { breaking: 2, unknown: 0, nonBreaking: 1 },
    });
    expect((report.changes as unknown[])[2]).toEqual({
      severity: 'breaking',
      code: 'constraint-tightened',
      entity: 'tool',
      name: 'search',
      location: 'inputSchema',
      path: '$.limit',
      message:
        'upper bound tightened from <= 100 to <= 50; arguments that were valid before can now be rejected',
    });
  });
});

describe('github output', () => {
  it('writes one annotation per change, escaped per the workflow command rules', () => {
    const lines = formatDiffAnnotations(result, { file: 'mcp-contract.snapshot.json' })
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      '::error file=mcp-contract.snapshot.json,title=BREAKING tool legacy::tool removed; agents that call it will get an error',
    );
    expect(lines[1]).toMatch(/^::notice /);
    expect(formatAnnotation({ level: 'warning', title: 'a:b,c', message: '100%\nnext\r' })).toBe(
      '::warning title=a%3Ab%2Cc::100%25%0Anext%0D',
    );
  });

  it('renders a Markdown table that survives pipes and backticks', () => {
    const markdown = formatDiffMarkdown(result);
    expect(markdown).toContain(
      '### mcp-contract: 3 changes: 2 breaking, 0 unknown, 1 non-breaking.',
    );
    expect(markdown).toContain('| BREAKING | tool `search` | `inputSchema $.limit` |');
    expect(markdown).toContain('**FAIL: 2 changes at or above the fail-on threshold (unknown)**');
    expect(formatDiffMarkdown(empty)).not.toContain('| Severity');
    expect(markdownCell('a|b\nc')).toBe('a\\|b<br>c');
    expect(markdownCode('a`b')).toBe('``a`b``');
    expect(markdownCode('`x')).toBe('`` `x ``');
  });
});

const results: ScenarioResult[] = [
  { name: 'works', tool: 'search', passed: true, failures: [], durationMs: 12.4 },
  {
    name: 'breaks',
    tool: 'create',
    passed: false,
    failures: ['expected isError: true, but the tool succeeded'],
    durationMs: 3,
  },
];

describe('scenario reports', () => {
  it('formats text with and without durations', () => {
    expect(formatTestText(results, { durations: false })).toBe(
      [
        'PASS  works [search]',
        'FAIL  breaks [create]',
        '      expected isError: true, but the tool succeeded',
        '',
        '2 scenarios: 1 passed, 1 failed',
        '',
      ].join('\n'),
    );
    expect(formatTestText(results)).toContain('[search] (12 ms)');
    expect(formatTestText(results.slice(0, 1), { color: true })).toContain('\u001B[32mPASS');
  });

  it('formats JSON, Markdown and annotations', () => {
    expect(JSON.parse(formatTestJson(results))).toMatchObject({
      passed: false,
      summary: { passed: 1, failed: 1 },
    });
    const markdown = formatTestMarkdown(results, { durations: false });
    expect(markdown).toContain(
      '| FAIL | breaks | create | expected isError: true, but the tool succeeded |',
    );
    expect(formatTestAnnotations(results, { file: 's.yaml' })).toBe(
      '::error file=s.yaml,title=Scenario failed%3A breaks::expected isError: true, but the tool succeeded\n',
    );
  });
});

describe('color detection', () => {
  it('follows flags, NO_COLOR, FORCE_COLOR and the terminal, in that order', () => {
    expect(shouldColor({ flag: false, env: { FORCE_COLOR: '1' }, isTTY: true })).toBe(false);
    expect(shouldColor({ env: { NO_COLOR: '1', FORCE_COLOR: '1' }, isTTY: true })).toBe(false);
    expect(shouldColor({ env: { NO_COLOR: '' }, isTTY: true })).toBe(true);
    expect(shouldColor({ env: { FORCE_COLOR: '1' }, isTTY: false })).toBe(true);
    expect(shouldColor({ env: { FORCE_COLOR: '0' }, isTTY: true })).toBe(false);
    expect(shouldColor({ env: {}, isTTY: false })).toBe(false);
    expect(createStyle(true).dim('x')).toBe('\u001B[2mx\u001B[22m');
    expect(createStyle(true).yellow('x')).toBe('\u001B[33mx\u001B[39m');
  });
});

describe('expectNoBreakingChanges', () => {
  it('throws a readable error with the failing changes', () => {
    let thrown: unknown;
    try {
      expectNoBreakingChanges(before, after);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractViolationError);
    const violation = thrown as ContractViolationError;
    expect(violation.message).toMatch(/^MCP contract violated:\n3 changes/);
    expect(violation.failing.map((change) => change.code)).toEqual([
      'tool-removed',
      'constraint-tightened',
    ]);
    expect(violation.failOn).toBe('unknown');
  });

  it('returns the diff when compatible and honours failOn', () => {
    const compatible = snapshotOf({ tools: [...before.tools, tool('extra')] });
    expect(expectNoBreakingChanges(before, compatible).summary).toEqual({
      breaking: 0,
      unknown: 0,
      nonBreaking: 1,
    });
    expect(() => expectNoBreakingChanges(before, compatible, { failOn: 'any' })).toThrow(
      ContractViolationError,
    );
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
