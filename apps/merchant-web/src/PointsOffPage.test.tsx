import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PointsOffPage } from "./PointsOffPage.js";

const render = (loading: boolean, href: string | null) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PointsOffPage loading={loading} storeFeaturesHref={href} />
    </MemoryRouter>,
  );

describe("M129: the Points page never shows the internal placeholder", () => {
  it("says it is loading, or that points are off and what to do", () => {
    expect(render(true, null)).toContain("Loading points…");
    const off = render(false, "/app/settings/store-features");
    expect(off).toContain("Points are off for this store.");
    expect(off).toContain('href="/app/settings/store-features"');
    expect(render(false, null)).toContain("Ask the owner to turn on points.");
    for (const html of [render(true, null), off])
      expect(html).not.toMatch(/PHASE 3|Phase 3|LOY-PROGRAM/u);
  });
  it("no pilot route renders the Phase-3 list page any more", () => {
    const app = readFileSync(join(import.meta.dirname, "App.tsx"), "utf8");
    expect(app).not.toContain("LoyaltyProgramListPage");
  });
});
