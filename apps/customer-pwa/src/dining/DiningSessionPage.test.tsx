import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { DiningSessionPage } from "./DiningSessionPage.js";

describe("CUST-DINE-IN-SESSION", () => {
  it("shows the registered data groups as unavailable without inventing session facts", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dine-in/session"]}>
        <DiningSessionPage />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-current="page">Dine-in');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Session details are unavailable");
    expect(html).toContain("Table / session");
    expect(html).toContain("Active Order batches");
    expect(html).toContain("Shared payable summary");
    expect(html).toContain("Service / allergen notices");
    expect(html).toContain("Table / session · unavailable");
    expect(html).toContain("Active Order batches · unavailable");
    expect(html).toContain("Shared payable summary · unavailable");
    expect(html).toContain("Service / allergen notices · unavailable");
    expect(html).toContain('href="/"');
    expect(html).toContain("Return to entry");
    expect(html).not.toMatch(/\b(?:Order 1001|CAD \d|Table T-\d|\d+ participants?)\b/u);
  });
});
