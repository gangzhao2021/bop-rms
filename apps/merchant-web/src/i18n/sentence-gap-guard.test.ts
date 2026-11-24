import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { zhHans } from "./zh-Hans.js";

/**
 * Batch 56 (v15 b55 live, "…这会开一张新账单。 没有下单…"): Chinese sentences follow each other
 * with no space. A text whose Chinese ends a sentence (。！？；) is followed by wordGap() or joined
 * with sentences() (a space in English, none in Chinese), never by a literal space.
 */
const root = new URL("..", import.meta.url).pathname;
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(path) && !path.includes(".test.") && !path.endsWith("zh-Hans.ts")
      ? [path]
      : [];
  });

/** Where the call opened at `open` (its "(") closes, skipping strings. */
function callEnd(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") {
      at += 1;
      while (at < text.length && text[at] !== char) at += text[at] === "\\" ? 2 : 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

it("no text whose Chinese ends a sentence is followed by a literal space", () => {
  const found = sources(root).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/gu)].flatMap((match) => {
      const key = JSON.parse(`"${match[1] ?? ""}"`) as string;
      const zh = zhHans[key];
      if (zh === undefined || !/[。！？；]$/u.test(zh)) return [];
      const end = callEnd(text, (match.index ?? 0) + 1);
      const after = text.slice(end, end + 40);
      return /^\s*\}?\s*(?:<\/[a-z]+>\s*)?(?:\{" "\}|\+\s*" ")/u.test(after)
        ? [`${relative(root, path)}: ${key}`]
        : [];
    });
  });
  expect(found).toEqual([]);
});
