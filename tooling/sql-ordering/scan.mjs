// WP-2423 (v15 2026-10-16): PostgreSQL resolves a bare name in a SELECT's own ORDER BY to an
// OUTPUT column first. A select list that returns `version::text AS version` therefore sorts the
// TEXT ("9" > "10"), and `ORDER BY version DESC LIMIT 1` reads version 9 as the latest from version
// 10 on. This scanner finds a top-level ORDER BY item that is a bare name which the same statement's
// select list (inline, or through a same-file constant it interpolates) defines as a text-producing
// expression. Ordering inside a window or aggregate (`OVER (… ORDER BY x)`, `agg(x ORDER BY y)`)
// uses input columns and is not reported.

const keyword = (text, at, word) =>
  text.slice(at, at + word.length).toUpperCase() === word &&
  !/[A-Za-z0-9_$]/.test(text[at - 1] ?? " ") &&
  !/[A-Za-z0-9_$]/.test(text[at + word.length] ?? " ");

/** Same-file constants: `const NAME = …;` (string expression text, unparsed). */
function constants(text) {
  const map = new Map();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]{0,200})?=\s*/g;
  for (let match; (match = pattern.exec(text));) {
    const start = pattern.lastIndex;
    let end = text.indexOf(";", start);
    if (end < 0) end = Math.min(text.length, start + 4000);
    map.set(match[1], text.slice(start, Math.min(end, start + 4000)));
  }
  return map;
}

const FRAGMENT = -1;

/** Walk back from an ORDER BY to its SELECT at the same depth; null if it is inside a call. */
function selectStart(text, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0 && at - i < 20000; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        // An unmatched "(" before any SELECT: a subquery only if SELECT/WITH follows it.
        const after = text.slice(i + 1, i + 40).replace(/^[\s"'`+]*/, "");
        if (/^(?:SELECT|WITH)\b/i.test(after)) return i + 1;
        // A host-language call whose argument is a SQL fragment (`one("x=$1 ORDER BY v")`): the
        // select list is built elsewhere in the file.
        if (
          /^\s*["'`]/.test(text.slice(i + 1, i + 40)) &&
          /[\w$]\s*$/.test(text.slice(Math.max(0, i - 40), i))
        )
          return FRAGMENT;
        return null;
      }
      depth--;
    } else if (depth === 0 && (c === "S" || c === "s") && keyword(text, i, "SELECT")) return i;
    else if (depth === 0 && c === ";") return null;
  }
  return null;
}

/** The ORDER BY item list: up to LIMIT/OFFSET/FOR/FETCH, an unmatched ")", ";" or a quote. */
function orderItems(text, from) {
  let depth = 0;
  let i = from;
  for (; i < text.length && i - from < 600; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ";" || c === '"' || c === "'" || c === "`" || c === "$")) {
      if (c === '"' && /^"[a-z_][a-z0-9_]*"/.test(text.slice(i, i + 70))) {
        i = text.indexOf('"', i + 1);
        continue;
      }
      break;
    } else if (
      depth === 0 &&
      ["LIMIT", "OFFSET", "FOR", "FETCH", "UNION", "EXCEPT", "INTERSECT"].some((w) =>
        keyword(text, i, w),
      )
    )
      break;
  }
  const items = [];
  let item = "";
  depth = 0;
  for (const c of text.slice(from, i)) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      items.push(item.trim());
      item = "";
    } else item += c;
  }
  if (item.trim()) items.push(item.trim());
  return items;
}

const bareName =
  /^"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i;

/**
 * Text-producing aliases a select list defines for `name`: `x::text AS name`, `x::text name`,
 * `CAST(x AS text) AS name`, `json->>'k' AS name`, `to_char(…) AS name`, `format(…)`, `concat(…)`,
 * `a||b AS name`.
 */
function textAlias(segments, name) {
  const n = name.replace(/[$]/g, "\\$");
  const alias = String.raw`(?:\s+AS)?\s+"?${n}"?(?=\s*(?:,|FROM\b|$|"|'|\x60|\+|\n))`;
  const patterns = [
    new RegExp(
      String.raw`::\s*(?:text|varchar(?:\s*\(\s*\d+\s*\))?|character\s+varying(?:\s*\(\s*\d+\s*\))?|citext)${alias}`,
      "i",
    ),
    new RegExp(
      String.raw`CAST\s*\([^()]*\bAS\s+(?:text|varchar|character\s+varying)\b[^()]*\)${alias}`,
      "i",
    ),
    new RegExp(String.raw`->>\s*'[^']*'\s*\)?${alias}`, "i"),
    new RegExp(String.raw`\|\|\s*(?:'[^']*'|[\w.]+)${alias}`, "i"),
    new RegExp(
      String.raw`\b(?:to_char|format|concat|concat_ws|lpad|rpad)\s*\((?:[^()]|\([^()]*\))*\)${alias}`,
      "i",
    ),
    // Unaliased `t.name::text`: PostgreSQL names the output column `name`.
    new RegExp(
      String.raw`(?:^|[\s,(."'\x60+])"?${n}"?\s*::\s*(?:text|varchar(?:\s*\(\s*\d+\s*\))?|character\s+varying(?:\s*\(\s*\d+\s*\))?|citext)\s*(?=,|FROM\b|$|"|'|\x60|\+|\n)`,
      "i",
    ),
  ];
  // Only a select-list item counts (paren depth 0 of its segment), never an argument such as
  // `jsonb_build_object('v', version::text)`.
  return segments.some((segment) => {
    const depth = [];
    let d = 0;
    for (const c of segment) {
      if (c === "(") d++;
      if (c === ")") d--;
      depth.push(d);
    }
    return patterns.some((p) =>
      [...segment.matchAll(new RegExp(p.source, "gi"))].some(
        (m) => (depth[m.index + m[0].length - 1] ?? 0) === 0,
      ),
    );
  });
}

/**
 * Exported constants of a file (`export const NAME = …;`), so a column list one module exports
 * and another interpolates is resolved too (WP-2423 v15 2026-10-18: the Kitchen queue reader
 * sorted `result_ticket_version::text` from an imported column list).
 */
export function exportedConstants(text) {
  const map = new Map();
  for (const [name, value] of constants(text))
    if (
      new RegExp(String.raw`\bexport\s+(?:const|let|var)\s+${name.replace(/[$]/g, "\\$")}\b`).test(
        text,
      )
    )
      map.set(name, value);
  return map;
}

/** Names this file imports with `import { a, b as c } from "…"` (local name → imported name). */
function importedNames(text) {
  const names = new Map();
  for (const match of text.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g))
    for (const part of match[1].split(",")) {
      const [imported, local = imported] = part
        .replace(/^\s*type\s+/, "")
        .split(/\s+as\s+/)
        .map((value) => value.trim());
      if (imported) names.set(local, imported);
    }
  return names;
}

/**
 * Reports every top-level ORDER BY item that sorts a text alias by its bare name. `imported`
 * maps exported constant names (from other files) to their text; only names this file imports
 * are used.
 */
export function scanSqlOrdering(text, file = "", imported = new Map()) {
  const hits = [];
  const consts = new Map();
  for (const [local, name] of importedNames(text))
    if (imported.has(name)) consts.set(local, imported.get(name));
  for (const [name, value] of constants(text)) consts.set(name, value);
  const pattern = /\bORDER\s+BY\b/gi;
  for (let match; (match = pattern.exec(text));) {
    const at = match.index;
    const start = selectStart(text, at);
    if (start === null) continue;
    const selectText = start === FRAGMENT ? "" : text.slice(start, at);
    const segments = [selectText];
    // A fragment may be completed by any select list the file defines.
    if (start === FRAGMENT) segments.push(...consts.values());
    // Interpolated or concatenated same-file constants (one level, plus their own references).
    const seen = new Set();
    const resolve = (source, level) => {
      if (level > 2) return;
      const refs = [
        ...source.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g),
        ...source.matchAll(/["'`]\s*\+\s*([A-Za-z_$][\w$]*)\s*\+\s*["'`]/g),
        ...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\+\s*["'`]/g),
      ];
      for (const ref of refs) {
        const name = ref[1];
        if (seen.has(name) || !consts.has(name)) continue;
        seen.add(name);
        const value = consts.get(name);
        segments.push(value);
        resolve(value, level + 1);
      }
    };
    resolve(selectText, 0);
    const line = text.slice(0, at).split("\n").length;
    for (const item of orderItems(text, at + match[0].length)) {
      const bare = bareName.exec(item);
      if (!bare) continue;
      const name = bare[1];
      if (textAlias(segments, name)) hits.push(Object.freeze({ file, line, name, item }));
    }
  }
  return hits;
}
