import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { zhHans } from "./zh-Hans.js";

// b41 (v15 b40 live, "离线 — 显示的是以下时间的最近更新： 6:07"): a text whose Chinese ends in a
// colon is followed by wordGap() (a space in English, none in Chinese), never by a literal space.
const root = new URL("..", import.meta.url).pathname;
const components = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return components(path);
    return path.endsWith(".tsx") && !path.includes(".test.") ? [path] : [];
  });

it("no text whose Chinese ends in a colon is followed by a literal space", () => {
  const call =
    /t\(\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*\{[\s\S]*?\}\s*)?\)\s*\}(?:\s*\{" "\}| [^\s{])/gu;
  const found = components(root).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(call)].flatMap((match) => {
      const key = JSON.parse(`"${match[1] ?? ""}"`) as string;
      const zh = zhHans[key];
      return zh !== undefined && /[：:]$/u.test(zh) ? [`${relative(root, path)}: ${key}`] : [];
    }),
  );
  expect(found).toEqual([]);
});
