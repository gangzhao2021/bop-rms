import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// v15 run (738b4c8b): the Kitchen, kitchen work item and Dining pages built their own navigation
// from plain anchors, so every click reloaded the whole app and, offline, showed the browser's
// "No internet" page. Any link to a screen of this app must be a router Link.

const sourceDir = new URL(".", import.meta.url).pathname;
const sources = readdirSync(sourceDir)
  .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
  .map((name) => ({ name, text: readFileSync(join(sourceDir, name), "utf8") }));

/** The opening `<a ...>` tags in a JSX source, scanning past `{...}` expressions (arrow functions). */
function anchorTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(/<a\s/gu)) {
    let depth = 0,
      index = match.index + 2;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) break;
    }
    tags.push(text.slice(match.index, index + 1));
  }
  return tags;
}

/** Plain anchors that are not screens of this app: in-page jumps, phone/email, server pages. */
const notInApp = [
  /href="#[^"]*"/u,
  /href=\{`(tel|mailto):/u,
  // Sign-in pages are served by the server, outside this app.
  /href="\/(merchant|platform)\/[^"]*"/u,
  /href=\{entry\.path\}/u,
];

describe("v15 run: in-app navigation stays inside the loaded app", () => {
  it("renders no plain anchor for a route of this app", () => {
    const offenders = sources.flatMap(({ name, text }) =>
      anchorTags(text)
        .filter((tag) => /\shref=/u.test(tag) && !notInApp.some((rule) => rule.test(tag)))
        .map((tag) => `${name}: ${tag.replace(/\s+/gu, " ")}`),
    );
    expect(offenders).toEqual([]);
  });

  // The Tables (dining) page sits in the shared workspace layout since the 2026-10-21 UI refresh;
  // since the 2026-10-21 live check the Kitchen and kitchen work item pages take the same frame
  // from the app (a counter or office sign-in) instead of building their own list of links.
  it("gives the Kitchen and kitchen work item pages the shared workspace frame", () => {
    const app = sources.find(({ name }) => name === "App.tsx")?.text ?? "";
    expect([...app.matchAll(/workspaceFrame=\{workspaceFrame\}/gu)]).toHaveLength(2);
    expect(app).not.toMatch(/navigation=\{/u);
  });
});
