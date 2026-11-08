// SPDX-License-Identifier: AGPL-3.0-only
/**
 * a formula keeps its columns as `{<column id>}` (storage, API, JSON — rename-safe), while people read
 * and type them by name: `{Price} * {Quantity}`. These two convert between the forms. Text inside "…" stays as is
 * (the engine reads it as a string), and a `#attr` after a reference (`{timeline#end}`) is kept.
 *
 * A column shows by name only when the name leads back to it alone: not empty, without `{ } # "` or a line break,
 * unique on the board (case and outer spaces ignored) and not another column's id. Any other column keeps its id.
 */
export type FormulaRefColumn = { id: string; title: string };

const norm = (s: string) => s.trim().toLowerCase();

/** The name each column is written with (`title`, or its id when the title would not lead back to it alone). */
export const formulaRefNames = (columns: readonly FormulaRefColumn[]): Map<string, string> => {
  const counts = new Map<string, number>();
  for (const c of columns) counts.set(norm(c.title), (counts.get(norm(c.title)) ?? 0) + 1);
  const ids = new Set(columns.map((c) => norm(c.id)));
  return new Map(
    columns.map((c) => {
      const title = c.title.trim();
      const ok =
        !!title &&
        !/[{}#"\n\r]/.test(title) &&
        counts.get(norm(title)) === 1 &&
        (!ids.has(norm(title)) || norm(title) === norm(c.id));
      return [c.id, ok ? title : c.id];
    }),
  );
};

/** Rewrites every `{…}` outside strings with `map(inner key)`; anything it returns undefined for stays as written. */
const mapRefs = (src: string, map: (key: string) => string | undefined): string => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      const end = j < 0 ? src.length : j + 1;
      out += src.slice(i, end);
      i = end;
    } else if (ch === '{') {
      const j = src.indexOf('}', i + 1);
      if (j < 0) {
        out += src.slice(i);
        break;
      }
      const inner = src.slice(i + 1, j);
      const hash = inner.indexOf('#');
      const key = hash < 0 ? inner : inner.slice(0, hash);
      const next = map(key.trim());
      out += next === undefined ? src.slice(i, j + 1) : `{${next}${hash < 0 ? '' : inner.slice(hash)}}`;
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
};

/** Stored → shown: `{col_ab12}` → `{Price}`. */
export const formulaToNames = (src: string, columns: readonly FormulaRefColumn[]): string => {
  const names = formulaRefNames(columns);
  return mapRefs(src, (key) => names.get(key));
};

/** Shown → stored: `{Price}` → `{col_ab12}`; an id typed as is stays; an unknown name is left for validation. */
export const formulaToKeys = (src: string, columns: readonly FormulaRefColumn[]): string => {
  const names = formulaRefNames(columns);
  const byName = new Map<string, string>();
  for (const [id, name] of names) if (name !== id) byName.set(norm(name), id);
  const ids = new Set(columns.map((c) => c.id));
  return mapRefs(src, (key) => byName.get(norm(key)) ?? (ids.has(key) ? key : undefined));
};

/**
 * `"{Platform}"` is text — the braces inside quotes are not read as the column. The names / ids of
 * the board's columns written that way, so the editor can say so (a column's value needs no quotes).
 */
export const quotedFormulaRefs = (src: string, columns: readonly FormulaRefColumn[]): string[] => {
  const known = new Set<string>();
  for (const c of columns) known.add(norm(c.id)).add(norm(c.title));
  const found: string[] = [];
  for (const m of src.matchAll(/"([^"]*)"/g))
    for (const r of m[1]!.matchAll(/\{([^{}#]+)(?:#[^{}]*)?\}/g)) {
      const key = r[1]!.trim();
      if (known.has(norm(key)) && !found.includes(key)) found.push(key);
    }
  return found;
};
