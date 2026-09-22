import { expect, test } from "@playwright/test";

const stores = [1, 2].map((n) => ({
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store " + n,
  storeReference: "018f8100-0000-7000-8000-00000000000" + n,
}));
const workspace = (index: number) => ({
  screenId: "HOME-OVERVIEW",
  selectedScope: stores[index],
  authorizedStores: stores,
  businessDate: "2026-08-12",
  storeStatus: "Unavailable",
  freshness: "Stale",
  dashboardAvailability: "UnavailableUntilWP1905",
  navigation: [
    {
      screenId: "OPS-ORDER-EXCEPTION",
      label: "Order exceptions",
      href: "/operations/order-exceptions",
      permission: "operations.order-exception.manage",
    },
  ],
});
const view = (index: number) => ({
  screenId: "OPS-ORDER-EXCEPTION",
  projectionName: "merchant_order_exception_v1",
  storeLabel: stores[index]?.storeLabel,
  businessDate: "2026-08-12",
  projectedAt: "2026-08-12T16:30:00.000Z",
  freshnessStatus: "Stale",
  items: [
    {
      exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000901",
      orderReference: "018f0f58-767a-7f3b-a1d0-000000000902",
      kind: "PaidWithoutFulfillableOrder",
      severity: "Critical",
      status: "Open",
      providerState: "Unknown",
      compensationStatus: "Pending",
      sourceOwner: "Payment",
      createdAt: "2026-08-12T16:00:00.000Z",
      dueAt: "2026-08-12T16:15:00.000Z",
      ownerStatus: "Unassigned",
      sourceFinal: false,
    },
  ],
});
const headers = { "cache-control": "no-store" };

test("@production exception read recovers and clears old data on refresh denial", async ({
  page,
}) => {
  let response: "denied" | "stale" | "empty" = "denied";
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") mutations.push(request.method());
  });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill(
      response === "denied"
        ? { status: 403, json: { error: "request_denied" }, headers }
        : { json: { ...view(0), ...(response === "empty" ? { items: [] } : {}) }, headers },
    ),
  );
  await page.goto("/operations/order-exceptions");
  await expect(page.getByRole("button", { name: "Retry loading exceptions" })).toBeVisible();
  response = "stale";
  await page.getByRole("button", { name: "Retry loading exceptions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Stale workbench — read-only" })).toBeVisible();
  await expect(page.getByText("PaidWithoutFulfillableOrder", { exact: true })).toBeVisible();
  for (const name of [
    "Acknowledge",
    "Assign",
    "Request owning-domain compensation / retry",
    "Resolve from final source evidence",
  ]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await expect(page.getByRole("button", { name: "Refresh source" })).toBeFocused();
  response = "denied";
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Retry loading exceptions" })).toBeVisible();
  await expect(page.getByText("PaidWithoutFulfillableOrder", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry loading exceptions" })).toBeFocused();
  response = "empty";
  await page.getByRole("button", { name: "Retry loading exceptions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "No exceptions in this view" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stale workbench — read-only" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh source" })).toBeFocused();
  expect(mutations).toEqual([]);
});

test("@production exception view follows the selected Store after an authorized switch", async ({
  page,
}) => {
  let selected = 0;
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(selected) },
      headers,
    }),
  );
  await page.route("**/merchant/store-context", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    expect(route.request().postDataJSON()).toEqual({
      targetStoreReference: stores[1]?.storeReference,
    });
    selected = 1;
    await route.fulfill({ json: { workspace: workspace(selected) }, headers });
  });
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: view(selected),
      headers,
    }),
  );
  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption("018f8100-0000-7000-8000-000000000002");
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Synthetic Store 2", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Order exceptions", exact: true }).click();
  await expect(page.getByText(/OPS-ORDER-EXCEPTION · Synthetic Store 2/)).toBeVisible();
  await expect(page.getByText(/OPS-ORDER-EXCEPTION · Synthetic Store 1/)).toHaveCount(0);
});

test("@production workbench displays the full 500-row backlog", async ({ page }) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  const source = view(0);
  const items = Array.from({ length: 500 }, (_, index) => ({
    ...source.items[0],
    exceptionReference: "018f0f58-767a-7f3b-a1d0-" + index.toString(16).padStart(12, "0"),
  }));
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: { ...source, items },
      headers,
    }),
  );
  await page.goto("/operations/order-exceptions");
  await expect(
    page.getByRole("heading", { name: "PaidWithoutFulfillableOrder", exact: true }),
  ).toHaveCount(500);
  await expect(
    page.getByRole("heading", { name: "PaidWithoutFulfillableOrder", exact: true }).last(),
  ).toBeAttached();
  await expect(page.getByRole("button", { name: "Retry loading exceptions" })).toHaveCount(0);
});

test("@production compensation acknowledgment reviews confirmed refund and retries identical intent", async ({
  page,
  context,
}) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({ json: { ...view(0), freshnessStatus: "Fresh" }, headers }),
  );
  await page.route("**/merchant/operations/compensations/query", (route) =>
    route.fulfill({
      json: {
        caseVersion: 2,
        caseState: "Open",
        refund: {
          amountMinor: "1130",
          currencyCode: "CAD",
          confirmedAt: "2026-09-21T00:00:00.000Z",
        },
        acknowledgmentRecorded: false,
      },
      headers,
    }),
  );
  const bodies: string[] = [];
  await page.route("**/merchant/operations/compensations/reconcile", async (route) => {
    bodies.push(route.request().postData() ?? "");
    await route.fulfill(
      bodies.length === 1
        ? { status: 503, json: { error: "compensation_reconciliation_unknown" }, headers }
        : {
            status: 202,
            json: {
              status: "ReconciliationRecorded",
              replayed: true,
              reconciledAt: "2026-09-21T00:00:00.000Z",
            },
            headers,
          },
    );
  });
  await page.goto("/operations/order-exceptions");
  await page.getByRole("button", { name: "Review confirmed refund" }).click();
  await expect(page.getByText(/Confirmed refund: CAD 11.30/)).toBeVisible();
  const submit = page.getByRole("button", { name: "Record operations reconciliation" });
  await expect(submit).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "I have reviewed this confirmed refund and reconciled this case",
    })
    .check();
  await context.setOffline(true);
  await expect(submit).toBeDisabled();
  await expect(page.getByText("Offline — reconciliation is read-only.")).toBeVisible();
  await context.setOffline(false);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText(/Result unknown/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review confirmed refund" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same acknowledgment" }).click();
  await expect(
    page.getByText(
      "Operations reconciliation recorded. Refresh the workbench to check case closure.",
    ),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(JSON.parse(bodies[0] ?? "{}").expectedCaseVersion).toBe(2);
  await expect(page.getByText("Case: Open", { exact: true })).toBeVisible();
});

test("@production unassociated reconciliation stays visible alongside a linked compensation case", async ({
  page,
}) => {
  let linked = false;
  const queries: unknown[] = [];
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: {
        ...view(0),
        freshnessStatus: "Fresh",
        items: [
          {
            ...view(0).items[0],
            exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000903",
            kind: "PaymentReconciliationDifference",
            orderReference: linked ? "018f0f58-767a-7f3b-a1d0-000000000904" : null,
            compensationStatus: "NotRequested",
          },
          ...view(0).items,
        ],
      },
      headers,
    }),
  );
  await page.route("**/merchant/operations/compensations/query", (route) => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        caseVersion: 2,
        caseState: "Open",
        refund: {
          amountMinor: "1130",
          currencyCode: "CAD",
          confirmedAt: "2026-09-21T00:00:00.000Z",
        },
        acknowledgmentRecorded: false,
      },
      headers,
    });
  });
  await page.goto("/operations/order-exceptions");
  const reconciliation = page.locator("article").filter({
    has: page.getByRole("heading", { name: "PaymentReconciliationDifference", exact: true }),
  });
  const compensation = page.locator("article").filter({
    has: page.getByRole("heading", { name: "PaidWithoutFulfillableOrder", exact: true }),
  });
  await expect(
    reconciliation.getByText("Order reference unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    reconciliation.getByRole("button", { name: "Request owning-domain compensation / retry" }),
  ).toBeDisabled();
  await expect(reconciliation.getByRole("button", { name: "Review confirmed refund" })).toHaveCount(
    0,
  );
  await expect(compensation.getByRole("button", { name: "Review confirmed refund" })).toBeEnabled();
  expect(queries).toHaveLength(0);
  await compensation.getByRole("button", { name: "Review confirmed refund" }).click();
  await expect(compensation.getByText(/Confirmed refund: CAD 11.30/)).toBeVisible();
  expect(queries).toEqual([
    {
      orderReference: "018f0f58-767a-7f3b-a1d0-000000000902",
      caseReference: "018f0f58-767a-7f3b-a1d0-000000000901",
    },
  ]);
  linked = true;
  await page.getByRole("button", { name: "Refresh source" }).click();
  await expect(
    reconciliation.getByText("018f0f58-767a-7f3b-a1d0-000000000904", { exact: true }),
  ).toBeVisible();
  await expect(
    reconciliation.getByText("Order reference unavailable", { exact: true }),
  ).toHaveCount(0);
  await expect(reconciliation.getByRole("button", { name: "Review confirmed refund" })).toHaveCount(
    0,
  );
  expect(queries).toHaveLength(1);
});

for (const failure of ["unknown", "conflict", "self", "denied"] as const) {
  test(`@production follow-up recovery ${failure} preserves safe operation identity`, async ({
    page,
    context,
  }) => {
    const writes: string[] = [];
    let queries = 0;
    await page.route("**/merchant/session", (route) =>
      route.fulfill({
        json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
        headers,
      }),
    );
    const source = view(0);
    await page.route("**/merchant/order-exceptions", (route) =>
      route.fulfill({
        json: {
          ...source,
          freshnessStatus: "Fresh",
          items: source.items.map((item) => ({
            ...item,
            kind: "PaymentReconciliationDifference",
            orderReference: null,
            compensationStatus: "NotRequested",
          })),
        },
        headers,
      }),
    );
    await page.route("**/merchant/operations/order-exceptions/follow-up-query", (route) => {
      queries++;
      return route.fulfill({
        json: {
          version: queries === 1 ? 1 : 2,
          followUpStatus: queries === 1 ? "Open" : "Assigned",
          acknowledged: false,
          assigned: queries > 1,
          updatedAt: "2026-08-12T16:30:00.000Z",
        },
        headers,
      });
    });
    await page.route("**/merchant/operations/order-exceptions/follow-up", (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
      writes.push(route.request().postData() ?? "");
      if (writes.length === 1)
        return failure === "unknown" || failure === "self"
          ? route.abort("failed")
          : route.fulfill({
              status: failure === "denied" ? 403 : 409,
              json: {
                error:
                  failure === "denied" ? "request_denied" : "reconciliation_follow_up_conflict",
              },
              headers,
            });
      return route.fulfill({
        status: 202,
        json: {
          status: "FollowUpRecorded",
          replayed: failure === "unknown" || failure === "self",
          version: failure === "unknown" || failure === "self" ? 2 : 3,
          followUpStatus: failure === "unknown" ? "Acknowledged" : "Assigned",
          updatedAt: "2026-08-12T16:31:00.000Z",
        },
        headers,
      });
    });
    await page.goto("/operations/order-exceptions");
    const region = page.getByRole("region", { name: "Payment reconciliation follow-up" });
    const review = region.getByRole("button", { name: "Review current follow-up" });
    const acknowledge = region.getByRole("button", {
      name: failure === "self" ? "Assign to me" : "Acknowledge payment difference",
      exact: true,
    });
    await review.click();
    await expect(region.getByText("Follow-up: Open · version 1")).toBeVisible();
    await expect(region.getByRole("combobox", { name: "Assign to" })).toBeDisabled();
    await expect(region.getByRole("button", { name: "Assign payment difference" })).toBeDisabled();
    await context.setOffline(true);
    await expect(acknowledge).toBeDisabled();
    await expect(region.getByText("Offline — follow-up is read-only.")).toBeVisible();
    expect(writes).toHaveLength(0);
    await context.setOffline(false);
    await acknowledge.click();
    if (failure === "unknown" || failure === "self") {
      await expect(region.getByText(/Result unknown/)).toBeVisible();
      await expect(review).toBeDisabled();
      await expect(acknowledge).toBeDisabled();
      expect(queries).toBe(1);
      await region.getByRole("button", { name: "Retry same follow-up" }).click();
    } else {
      await expect(
        region.getByText(
          failure === "denied"
            ? /Action was not accepted/
            : /Another action changed this exception/,
        ),
      ).toBeVisible();
      await expect(acknowledge).toHaveCount(0);
      await expect(region.getByRole("button", { name: "Retry same follow-up" })).toHaveCount(0);
      await review.click();
      await expect(region.getByText("Follow-up: Assigned · version 2")).toBeVisible();
      await acknowledge.click();
    }
    await expect(
      region.getByText(/Follow-up recorded.*financial exception remains open/),
    ).toBeVisible();
    await expect(review).toBeEnabled();
    expect(writes).toHaveLength(2);
    const first = JSON.parse(writes[0] ?? "{}");
    const second = JSON.parse(writes[1] ?? "{}");
    expect(first.expectedVersion).toBe(1);
    expect(first.action).toBe(failure === "self" ? "AssignSelf" : "Acknowledge");
    expect(first.assigneeReference).toBeNull();
    if (failure === "unknown" || failure === "self") expect(writes[1]).toBe(writes[0]);
    else {
      expect(second.expectedVersion).toBe(2);
      expect(second.operationReference).not.toBe(first.operationReference);
    }
  });
}

test("@production employee directory pagination clears stale choices on failure", async ({
  page,
}) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      json: { authenticated: true, csrf: "a".repeat(43), workspace: workspace(0) },
      headers,
    }),
  );
  const source = view(0);
  await page.route("**/merchant/order-exceptions", (route) =>
    route.fulfill({
      json: {
        ...source,
        freshnessStatus: "Fresh",
        items: source.items.map((item) => ({
          ...item,
          kind: "PaymentReconciliationDifference",
          orderReference: null,
          compensationStatus: "NotRequested",
        })),
      },
      headers,
    }),
  );
  await page.route("**/merchant/operations/order-exceptions/follow-up-query", (route) =>
    route.fulfill({
      json: {
        version: 1,
        followUpStatus: "Open",
        acknowledged: false,
        assigned: false,
        updatedAt: "2026-08-12T16:30:00.000Z",
      },
      headers,
    }),
  );
  const actorReference = "01950000-0000-7000-8000-000000000010";
  let reads = 0,
    writes = 0;
  await page.route("**/merchant/operations/order-exceptions/follow-up-assignees", (route) => {
    reads++;
    expect(route.request().postDataJSON().afterActorReference).toBe(
      reads === 2 ? actorReference : null,
    );
    return reads === 1
      ? route.fulfill({
          json: {
            items: [{ actorReference, label: "Synthetic employee" }],
            nextAfterActorReference: actorReference,
          },
          headers,
        })
      : route.fulfill({
          status: 503,
          json: { error: "reconciliation_assignees_unavailable" },
          headers,
        });
  });
  await page.route("**/merchant/operations/order-exceptions/follow-up", (route) => {
    writes++;
    return route.abort();
  });
  await page.goto("/operations/order-exceptions");
  const region = page.getByRole("region", { name: "Payment reconciliation follow-up" });
  await region.getByRole("button", { name: "Review current follow-up" }).click();
  await region.getByRole("button", { name: "Load eligible employees" }).click();
  const selector = region.getByRole("combobox", { name: "Assign to" });
  await selector.selectOption(actorReference);
  await expect(region.getByRole("button", { name: "Assign payment difference" })).toBeEnabled();
  await region.getByRole("button", { name: "Next employee page" }).click();
  await expect(region.getByText(/Employee directory unavailable/)).toBeVisible();
  await expect(selector).toBeDisabled();
  await expect(selector).toHaveValue("");
  await expect(region.getByRole("option", { name: "Synthetic employee" })).toHaveCount(0);
  await expect(region.getByRole("button", { name: "Assign payment difference" })).toBeDisabled();
  await expect(region.getByRole("button", { name: "Assign to me", exact: true })).toBeEnabled();
  expect(writes).toBe(0);
});
