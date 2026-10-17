import type { ScenarioResult } from '../scenarios/run.ts';
import { formatAnnotation, markdownCell } from './github.ts';
import { createStyle } from './style.ts';

/** Options shared by the scenario report formatters. */
export interface TestReportOptions {
  /** Emit ANSI colors (text format only). Defaults to false. */
  readonly color?: boolean;
  /** Include durations (text and Markdown). Defaults to true; tests turn it off for stable output. */
  readonly durations?: boolean;
  /** Scenario file that annotations point at (github format only). */
  readonly file?: string | undefined;
}

function counts(results: readonly ScenarioResult[]): { passed: number; failed: number } {
  const passed = results.filter((result) => result.passed).length;
  return { passed, failed: results.length - passed };
}

function duration(result: ScenarioResult, options: TestReportOptions): string {
  return options.durations === false ? '' : ` (${Math.round(result.durationMs)} ms)`;
}

/** Human-readable scenario report. */
export function formatTestText(
  results: readonly ScenarioResult[],
  options: TestReportOptions = {},
): string {
  const style = createStyle(options.color ?? false);
  const lines: string[] = [];
  for (const result of results) {
    const label = result.passed ? style.green('PASS') : style.red(style.bold('FAIL'));
    lines.push(
      `${label}  ${result.name} ${style.dim(`[${result.tool}]${duration(result, options)}`)}`,
    );
    for (const failure of result.failures) {
      lines.push(`      ${failure}`);
    }
  }
  const { passed, failed } = counts(results);
  const summary = `${results.length} ${results.length === 1 ? 'scenario' : 'scenarios'}: ${passed} passed, ${failed} failed`;
  lines.push('', failed === 0 ? style.green(summary) : style.red(style.bold(summary)));
  return `${lines.join('\n')}\n`;
}

/** Machine-readable scenario report. */
export function formatTestJson(results: readonly ScenarioResult[]): string {
  const { passed, failed } = counts(results);
  return `${JSON.stringify({ passed: failed === 0, summary: { passed, failed }, results }, null, 2)}\n`;
}

/** Markdown summary for `$GITHUB_STEP_SUMMARY`. */
export function formatTestMarkdown(
  results: readonly ScenarioResult[],
  options: TestReportOptions = {},
): string {
  const { passed, failed } = counts(results);
  const lines = [
    `### mcp-contract test: ${passed} passed, ${failed} failed`,
    '',
    '| Result | Scenario | Tool | Details |',
    '| --- | --- | --- | --- |',
  ];
  for (const result of results) {
    const details =
      result.failures.length === 0 ? duration(result, options).trim() : result.failures.join('\n');
    lines.push(
      `| ${result.passed ? 'PASS' : 'FAIL'} | ${markdownCell(result.name)} | ${markdownCell(result.tool)} | ${markdownCell(details)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** One error annotation per failed scenario. */
export function formatTestAnnotations(
  results: readonly ScenarioResult[],
  options: TestReportOptions = {},
): string {
  return results
    .filter((result) => !result.passed)
    .map(
      (result) =>
        `${formatAnnotation({ level: 'error', title: `Scenario failed: ${result.name}`, message: result.failures.join('\n'), file: options.file })}\n`,
    )
    .join('');
}
