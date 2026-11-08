// SPDX-License-Identifier: AGPL-3.0-only
import { t, type FormulaProblem } from '@bines/shared';

/** why a formula does not parse, in the reader's language and with the column as they typed it. */
export const formulaProblemText = (p: FormulaProblem): string => {
  switch (p.code) {
    case 'empty':
      return t('formula.err.empty');
    case 'unterminated_string':
      return t('formula.err.unterminated_string');
    case 'unterminated_ref':
      return t('formula.err.unterminated_ref');
    case 'bad_number':
      return t('formula.err.bad_number');
    case 'unexpected_char':
    case 'unexpected':
      return t('formula.err.unexpected', { token: p.token });
    case 'unexpected_end':
      return t('formula.err.unexpected_end');
    case 'unexpected_column':
      return p.afterCall
        ? t('formula.err.unexpected_column_after', { column: `{${p.column}}` })
        : t('formula.err.unexpected_column', { column: `{${p.column}}` });
    case 'missing_paren':
      return t('formula.err.missing_paren');
    case 'missing_paren_after':
      return t('formula.err.missing_paren_after', { token: p.token });
    case 'unknown_name':
      return t('formula.err.unknown_name', { token: p.token });
    case 'unknown_function':
      return t('formula.err.unknown_function', { token: p.token });
    case 'unknown_column':
      return t('formula.err.unknown_column', { column: `{${p.column}}` });
  }
};
