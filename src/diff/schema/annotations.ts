/** Annotation keywords: they never change validity, but `default` can change behaviour. */
import type { JsonObject } from '../../core/json.ts';
import { describeChange, emit, get, sameOptional, type Context } from './context.ts';

/** Reports title, description, examples, deprecation and default changes. */
export function compareAnnotations(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  for (const keyword of ['title', 'description'] as const) {
    const before = get(o, keyword);
    const after = get(n, keyword);
    if (!sameOptional(before, after)) {
      emit(ctx, 'annotation', `${keyword}-changed`, path, describeChange(keyword, before, after), {
        before,
        after,
      });
    }
  }
  for (const keyword of ['examples', '$comment', 'readOnly', 'writeOnly'] as const) {
    const before = get(o, keyword);
    const after = get(n, keyword);
    if (!sameOptional(before, after)) {
      emit(ctx, 'annotation', 'annotation-changed', path, describeChange(keyword, before, after), {
        before,
        after,
      });
    }
  }
  const wasDeprecated = get(o, 'deprecated') === true;
  const isDeprecated = get(n, 'deprecated') === true;
  if (wasDeprecated !== isDeprecated) {
    emit(
      ctx,
      'annotation',
      'deprecated-changed',
      path,
      isDeprecated ? 'marked deprecated' : 'no longer deprecated',
    );
  }
  const before = get(o, 'default');
  const after = get(n, 'default');
  if (!sameOptional(before, after)) {
    const what = describeChange('default', before, after);
    if (ctx.direction === 'input') {
      emit(ctx, 'unknown', 'default-changed', path, what, {
        before,
        after,
        reason: 'clients that omit this value may get different behaviour',
      });
    } else {
      emit(ctx, 'annotation', 'default-changed', path, what, { before, after });
    }
  }
}
