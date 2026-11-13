import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { SessionRestoreBusy } from "./SessionRestoreBusy.js";
import { setCustomerSessionRestoreUnavailable } from "./customer-transaction-context.js";

afterEach(() => {
  setCustomerSessionRestoreUnavailable(false);
});

it("WP-2423 (rush-reads-and-orders-changes review): a page whose visit the store could not give back says busy, never scan again or session ended", () => {
  setCustomerSessionRestoreUnavailable(true);
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/menu"]}>
      <SessionRestoreBusy retryNow={() => undefined} retryAfterSeconds={5} />
    </MemoryRouter>,
  );
  expect(html).toContain("The store’s system is busy");
  expect(html).toContain(
    "Your order and cart are kept. This page loads again by itself in 5 seconds.",
  );
  expect(html).toContain("Try again");
  expect(html).not.toMatch(/Scan the location QR code|session ended/iu);
  // The journey links wait with it (the page has no visit to show yet).
  expect(html).toContain('aria-disabled="true"');
});
