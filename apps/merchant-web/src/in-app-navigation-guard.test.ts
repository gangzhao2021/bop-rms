import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { workspaceNavigationLinks } from "./WorkspaceLayout.js";

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
  // the Kitchen display and its work item still build their own navigation.
  it("builds the Kitchen and kitchen work item navigation from router links", () => {
    const app = sources.find(({ name }) => name === "App.tsx")?.text ?? "";
    const navigationProps = [...app.matchAll(/navigation=\{([^\n]*)/gu)].map((match) => match[1]);
    expect(navigationProps.length).toBeGreaterThanOrEqual(2);
    for (const prop of navigationProps) expect(prop).toMatch(/^workspaceNavigationLinks\(/u);
  });

  it("keeps real addresses and marks the current screen", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        workspaceNavigationLinks(
          [
            { screenId: "KIT-KITCHEN-QUEUE", label: "Kitchen", href: "/operations/kitchen" },
            { screenId: "DIN-FLOOR-BOARD", label: "Tables", href: "/operations/dining" },
          ] as never,
          (item) => item.screenId === "KIT-KITCHEN-QUEUE",
        ),
      ),
    );
    // React Router marks its own links; a plain anchor would not carry this.
    expect(html).toBe(
      '<a aria-current="page" href="/operations/kitchen" data-discover="true">Kitchen</a>' +
        '<a href="/operations/dining" data-discover="true">Tables</a>',
    );
  });
});
