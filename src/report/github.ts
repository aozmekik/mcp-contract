/**
 * GitHub Actions workflow commands, escaped the way the runner expects
 * (https://docs.github.com/actions/reference/workflow-commands-for-github-actions).
 */

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

/** Escapes text for a Markdown table cell. */
export function markdownCell(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
}

/** Formats text as inline Markdown code, choosing a fence that the text cannot close. */
export function markdownCode(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}
