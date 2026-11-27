import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

// v15 b17 review: a label ending in a colon is followed by wordGap() (a space in English, none in
// Chinese), never by a literal space, which reads "已付： $2.83" in Chinese. Guards every component.
const root = new URL("..", import.meta.url).pathname;
const components = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return components(path);
    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });

it("v15 b17 review: no colon label is followed by a literal space", () => {
  const found = components(root).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        /\{t\("[^"]*:"\)\} /u.test(line) ? [`${relative(root, path)}:${index + 1}`] : [],
      ),
  );
  expect(found).toEqual([]);
});
