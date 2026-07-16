import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
describe("merchant shell", () => {
  it("renders accessible synthetic shell states", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain("Merchant workspace");
    expect(html).toContain("Offline read-only");
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('href="#main-content"');
    expect(html).not.toContain("@gmail.com");
  });
});
