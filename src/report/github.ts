/**
 * GitHub Actions workflow commands, escaped the way the runner expects
 * (https://docs.github.com/actions/reference/workflow-commands-for-github-actions).
 */
import { randomBytes } from 'node:crypto';

/** Annotation level of a workflow command. */
export type AnnotationLevel = 'error' | 'warning' | 'notice';

/** One annotation. */
export interface Annotation {
  /** Severity shown by GitHub. */
  readonly level: AnnotationLevel;
  /** Short title. */
  readonly title: string;
  /** Message body. */
  readonly message: string;
  /** Repository-relative file the annotation belongs to. */
  readonly file?: string | undefined;
}

function escapeData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** Formats an annotation as a `::level file=...,title=...::message` workflow command. */
export function formatAnnotation(annotation: Annotation): string {
  const properties = [
    ...(annotation.file === undefined ? [] : [`file=${escapeProperty(annotation.file)}`]),
    `title=${escapeProperty(annotation.title)}`,
  ];
  return `::${annotation.level} ${properties.join(',')}::${escapeData(annotation.message)}`;
}

/**
 * Wraps text that must not be interpreted as workflow commands (it contains
 * names chosen by the server) between `::stop-commands::` and the resume
 * command, using a random token that the text cannot know.
 */
export function withoutWorkflowCommands(
  text: string,
  token: string = randomBytes(16).toString('hex'),
): string {
  return `::stop-commands::${token}\n${text}${text.endsWith('\n') ? '' : '\n'}::${token}::\n`;
}

/**
 * Defuses lines that the Actions runner would execute as workflow commands
 * (it trims leading whitespace, then looks for `::`), keeping them readable.
 * For logs that are not wrapped by {@link withoutWorkflowCommands}.
 */
export function inertCommands(text: string): string {
  return text.replaceAll(/^(\s*)::/gm, '$1: :');
}

/** Escapes text for a Markdown table cell (pipes, line breaks and HTML). */
export function markdownCell(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/\r?\n/g, '<br>');
}

/** Formats text as inline Markdown code, choosing a fence that the text cannot close. */
export function markdownCode(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}
