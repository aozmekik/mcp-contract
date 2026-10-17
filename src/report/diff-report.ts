import {
  DEFAULT_FAIL_ON,
  failingChanges,
  type Change,
  type DiffResult,
  type FailOn,
  type Severity,
} from '../diff/model.ts';
import { formatAnnotation, markdownCell, markdownCode, type AnnotationLevel } from './github.ts';
import { createStyle, type Style } from './style.ts';

/** Options shared by the diff formatters. */
export interface DiffReportOptions {
  /** Threshold used to decide pass/fail in the summary line. Defaults to `unknown`. */
  readonly failOn?: FailOn;
  /** Emit ANSI colors (text format only). Defaults to false. */
  readonly color?: boolean;
  /** Snapshot file that annotations point at (github format only). */
  readonly file?: string | undefined;
}

const LABELS: Readonly<Record<Severity, string>> = {
  breaking: 'BREAKING',
  unknown: 'UNKNOWN',
  'non-breaking': 'NON-BREAKING',
};

const ENTITY_LABELS: Readonly<Record<Change['entity'], string>> = {
  server: 'server',
  tool: 'tool',
  prompt: 'prompt',
  resource: 'resource',
  'resource-template': 'resource template',
};

function paint(style: Style, severity: Severity, text: string): string {
  switch (severity) {
    case 'breaking':
      return style.red(style.bold(text));
    case 'unknown':
      return style.yellow(text);
    case 'non-breaking':
      return style.green(text);
  }
}

/** `inputSchema $.limit`, `annotations`, ... or an empty string for entity-level changes. */
export function changeLocation(change: Change): string {
  return [change.location, change.path]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

function summaryLine(result: DiffResult): string {
  const { breaking, unknown, nonBreaking } = result.summary;
  const total = breaking + unknown + nonBreaking;
  if (total === 0) {
    return 'No changes.';
  }
  return `${total} ${total === 1 ? 'change' : 'changes'}: ${breaking} breaking, ${unknown} unknown, ${nonBreaking} non-breaking.`;
}

function verdict(result: DiffResult, failOn: FailOn): { passed: boolean; text: string } {
  const failing = failingChanges(result, failOn).length;
  return failing === 0
    ? { passed: true, text: `PASS (fail-on: ${failOn})` }
    : {
        passed: false,
        text: `FAIL: ${failing} ${failing === 1 ? 'change' : 'changes'} at or above the fail-on threshold (${failOn})`,
      };
}

/** Human-readable report grouped by element, optionally colored. */
export function formatDiffText(result: DiffResult, options: DiffReportOptions = {}): string {
  const style = createStyle(options.color ?? false);
  const failOn = options.failOn ?? DEFAULT_FAIL_ON;
  const lines: string[] = [style.bold(summaryLine(result))];
  let group = '';
  for (const change of result.changes) {
    const heading = `${ENTITY_LABELS[change.entity]} ${change.name}`;
    if (heading !== group) {
      group = heading;
      lines.push('', style.bold(heading));
    }
    const label = paint(style, change.severity, LABELS[change.severity].padEnd(12));
    const location = changeLocation(change);
    lines.push(`  ${label}  ${location === '' ? '' : `${style.dim(location)}: `}${change.message}`);
  }
  const { passed, text } = verdict(result, failOn);
  lines.push('', passed ? style.green(text) : style.red(style.bold(text)));
  return `${lines.join('\n')}\n`;
}

/** Machine-readable report. The shape is part of the public interface. */
export function formatDiffJson(result: DiffResult, options: DiffReportOptions = {}): string {
  const failOn = options.failOn ?? DEFAULT_FAIL_ON;
  const report = {
    passed: verdict(result, failOn).passed,
    failOn,
    summary: result.summary,
    changes: result.changes,
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Markdown summary, as appended to `$GITHUB_STEP_SUMMARY`. */
export function formatDiffMarkdown(result: DiffResult, options: DiffReportOptions = {}): string {
  const failOn = options.failOn ?? DEFAULT_FAIL_ON;
  const lines = [`### mcp-contract: ${summaryLine(result)}`, ''];
  if (result.changes.length > 0) {
    lines.push('| Severity | Element | Where | Change |', '| --- | --- | --- | --- |');
    for (const change of result.changes) {
      const location = changeLocation(change);
      lines.push(
        `| ${LABELS[change.severity]} | ${ENTITY_LABELS[change.entity]} ${markdownCell(markdownCode(change.name))} | ${location === '' ? '' : markdownCell(markdownCode(location))} | ${markdownCell(change.message)} |`,
      );
    }
    lines.push('');
  }
  lines.push(`**${verdict(result, failOn).text}**`);
  return `${lines.join('\n')}\n`;
}

const LEVELS: Readonly<Record<Severity, AnnotationLevel>> = {
  breaking: 'error',
  unknown: 'warning',
  'non-breaking': 'notice',
};

/** One GitHub workflow annotation per change. */
export function formatDiffAnnotations(result: DiffResult, options: DiffReportOptions = {}): string {
  return result.changes
    .map((change) => {
      const location = changeLocation(change);
      return `${formatAnnotation({
        level: LEVELS[change.severity],
        title: `${LABELS[change.severity]} ${ENTITY_LABELS[change.entity]} ${change.name}`,
        message: `${location === '' ? '' : `${location}: `}${change.message}`,
        file: options.file,
      })}\n`;
    })
    .join('');
}
