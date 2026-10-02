import { expect, test } from "@playwright/test";

test("@production PROC-PO-LIST keeps unavailable Procurement facts fail-closed responsively", async ({
  page,
}) => {
  await page.goto("/app/supply/purchase-orders");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole("heading", { name: "Purchase orders", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Purchase Order projection unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Order status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Purchase Orders unavailable" })).toBeVisible();
  await expect(page.locator(".purchase-order-fields-panel")).toContainText(
    "ordered / received / open amounts",
  );
  await expect(page.locator(".purchase-order-fields-panel")).toContainText("expected delivery");
  const filters = page.getByRole("group", { name: "Search and filters" });
  await expect(filters).toBeVisible();
  const desktopFilters = filters.locator(".purchase-order-filters-desktop");
  for (const label of [
    "PO reference, Supplier or Item filter unavailable",
    "Workflow, Fulfillment or Closure filter unavailable",
    "Store, Buyer or date filter unavailable",
    "Overdue or Discrepancy filter unavailable",
  ])
    await expect(desktopFilters.getByLabel(label)).toBeDisabled();
  await expect(page.getByText("No authorized rows are available to display.")).toBeVisible();
  await expect(page.getByText(/Synthetic|DEMO-|\bCAD\b|Ordered \d/u)).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width >= 768) {
      await expect(desktopFilters).toBeVisible();
      await expect(
        desktopFilters.getByLabel("Overdue or Discrepancy filter unavailable"),
      ).toBeDisabled();
    } else {
      const mobileFilters = filters.locator(".purchase-order-filters-mobile");
      await expect(mobileFilters).toBeVisible();
      await expect(
        mobileFilters.getByLabel("PO reference, Supplier or Item filter unavailable"),
      ).toBeDisabled();
      await expect(
        mobileFilters.getByLabel(
          "Workflow, Store, Buyer, Date, Overdue or Discrepancy filters unavailable",
        ),
      ).toBeDisabled();
    }
    const statusHeight = await page
      .locator(".purchase-order-status-card")
      .first()
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(statusHeight).toBe(width >= 768 ? 84 : 70);
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
      path: `test-results/purchase-order-list-${width}.png`,
      fullPage: true,
    });
  }
});

test("@production PROC-PO-DETAIL follows the responsive Review hierarchy without PO facts", async ({
  page,
}) => {
  await page.goto("/app/supply/purchase-orders/unavailable-review-reference");
  await expect(page.getByRole("heading", { name: "Purchase Order", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Purchase Order detail projection unavailable" }),
  ).toBeVisible();
  for (const heading of [
    "Order states",
    "Issued Purchase Order snapshot",
    "Line receipt and completion",
    "Supplier response and change history",
    "Supplier performance timeline",
    "Registered actions",
  ])
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  for (const label of [
    "Record acknowledgement / decline",
    "Create Revision",
    "Cancel eligible remainder",
    "Close Purchase Order",
  ])
    await expect(page.getByRole("button", { name: label })).toBeDisabled();
  await expect(
    page.getByText(/Synthetic|DEMO-|unavailable-review-reference|\bCAD\b|\$\d/u),
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
      path: `test-results/purchase-order-detail-${width}.png`,
      fullPage: true,
    });
  }
});

test("@production PROC-PO-EDITOR keeps unavailable authoring fields and commands fail-closed", async ({
  page,
}) => {
  await page.goto("/app/supply/purchase-orders/unavailable-review-reference/edit");
  await expect(page.getByRole("heading", { name: "Purchase Order", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Purchase Order editor projection unavailable" }),
  ).toBeVisible();
  for (const heading of [
    "Supplier / Buyer / Ship-To / currency",
    "Workflow and revision",
    "Offering-based lines and source allocations",
    "Terms and tolerance",
    "Totals and validation impact",
    "Registered actions",
  ])
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  for (const field of [
    "Supplier",
    "Buyer Entity",
    "Ship-To",
    "Currency",
    "Approved Offering / Item",
    "Supplier item and unit conversion",
    "Ordered quantity",
    "Purchase unit",
    "Resolved unit price",
    "Expected delivery",
    "Approved Requisition allocation",
    "Delivery terms",
    "Payment terms",
    "Quantity / price tolerance",
    "Subtotal",
    "Discount",
    "Total",
  ])
    await expect(page.getByText(field, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Inventory owns Goods Receipt; receipt entry is unavailable here."),
  ).toBeVisible();
  await expect(page.locator("input, select, textarea")).toHaveCount(0);
  for (const label of [
    "Save Draft / Revision",
    "Validate current snapshot",
    "Submit for approval",
    "Approve as authorized actor",
    "Issue with Buyer authority",
  ])
    await expect(page.getByRole("button", { name: label })).toBeDisabled();
  await expect(
    page.getByText(/Synthetic|DEMO-|unavailable-review-reference|\bCAD\b|\$\d/u),
  ).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const lineColumns = await page
      .locator(".purchase-order-editor-line-fields")
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(lineColumns).toBe(width >= 768 ? 3 : 1);
    const actionColumns = await page
      .locator(".purchase-order-editor-unavailable .purchase-order-detail-actions > div")
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(actionColumns).toBe(width >= 768 ? 3 : 1);
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
      path: `test-results/purchase-order-editor-${width}.png`,
      fullPage: true,
    });
  }
});
