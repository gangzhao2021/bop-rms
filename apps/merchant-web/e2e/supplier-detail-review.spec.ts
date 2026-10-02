import { expect, test } from "@playwright/test";

test("@production SUP-SUPPLIER-DETAIL keeps unavailable fields and actions fail-closed responsively", async ({
  page,
}) => {
  await page.goto("/app/supply/suppliers/018fa900-0000-7000-8000-000000000010");
  await expect(page.getByRole("heading", { name: "Supplier", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Supplier detail", level: 2 })).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Supplier detail source unavailable" }),
  ).toBeVisible();
  for (const heading of [
    "Profile scope",
    "Contacts and addresses",
    "Qualifications and evidence",
    "Authorized summaries and history",
  ])
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  for (const value of [
    "Contact role · name · email · phone",
    "Business / remittance address",
    "Tax registration reference",
    "Edit · review qualification · suspend · open Offering / PO / discrepancy: unavailable.",
    "No physical delete; suspension preserves issued POs.",
  ])
    await expect(page.getByText(value)).toBeVisible();
  await expect(
    page.getByText(/Synthetic|DEMO-|@[a-z]|\bCAD\b|\+?\d{3}[ -]?\d{3}[ -]?\d{4}/u),
  ).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          className: element.className,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }))
        .slice(0, 8),
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({
      path: `test-results/supplier-detail-${width}.png`,
      fullPage: true,
    });
  }
});
