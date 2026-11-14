import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../public/shell.css", import.meta.url), "utf8");

describe("M106: the guest sees the app opening before its script has loaded", () => {
  it("ships a bilingual, store-neutral line inside the root that React replaces", () => {
    const root = html.slice(html.indexOf('<div id="root">'), html.indexOf("</body>"));
    expect(root).toContain("Opening the store…");
    expect(root).toContain("正在打开门店…");
    expect(root).toContain('role="status"');
    expect(root).not.toMatch(/BOP|DEMO|cache|[0-9a-f]{8}-[0-9a-f]{4}/iu);
  });
  it("renders under the customer CSP: its style is an owned file, nothing inline", () => {
    expect(html).toContain('<link rel="stylesheet" href="/shell.css" />');
    expect(html).not.toMatch(/<style[\s>]/iu);
    expect(html).not.toMatch(/\sstyle=/iu);
    expect(html).not.toMatch(/\son[a-z]+=/iu);
    // The only script is the module the build replaces with its own file.
    expect(html.match(/<script\b[^>]*>/giu)).toEqual([
      '<script type="module" src="/src/main.tsx">',
    ]);
    expect(css).not.toMatch(/url\(|@import|expression\(/iu);
  });
});
