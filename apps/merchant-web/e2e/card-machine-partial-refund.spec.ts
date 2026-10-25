import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 item 4 (DEC-COUNTER-PAYMENT-RECORD, partial refunds): a manager refunds one item of a
// round paid on the store's card machine. The request uses the same wizard and rules as an online
// refund (reason, per-item quantity, server-calculated amount with tax and tip share); the refund
// itself is made on the machine and recorded with the slip reference. An escalated one waits for
// the owner's approval, then the approver is told to make it on the machine and record it.
const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};

test("@production a manager refunds an item of a card-machine payment and records the machine refund", async ({
  page,
}) => {
  let recorded = false;
  const recordedRequest: { body: Record<string, unknown> | null } = { body: null };
  const records: string[] = [];
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-10-15",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: false,
        soleOperator: null,
        entries: [],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: {
        paymentIntentReference: id(31),
        paymentAttemptReference: id(32),
        orderReference: id(1),
        orderBatchReference: id(90),
        observedAt: new Date().toISOString(),
        paymentState: "Captured",
        paymentMethod: "CardMachine",
        currencyCode: "CAD",
        capturedAmountMinor: "2486",
        confirmedRefundMinor: recorded ? "621" : "0",
        pendingRefundMinor: recordedRequest.body !== null && !recorded ? "621" : "0",
        canRequest: true,
      },
    }),
  );
  const request = () => ({
    requestReference: String(recordedRequest.body?.requestReference),
    operationReference: String(recordedRequest.body?.operationReference),
    claimVersion: 1,
    requestedAt: "2026-10-15T15:00:00.000Z",
    reasonCode: "QUALITY_ISSUE",
    currencyCode: "CAD",
    amountMinor: "621",
    decline: null,
    progress: recorded ? "Refunded" : "Recorded",
    paymentMethod: "CardMachine",
  });
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderNumber: "T4-2",
        canRequest: true,
        claimVersion: recordedRequest.body === null ? 0 : 1,
        recentRequests: recordedRequest.body === null ? [] : [request()],
        items: [
          {
            orderBatchReference: id(90),
            orderItemReference: id(3),
            label: "Pad thai",
            quantity: 2,
            unclaimedQuantity: recordedRequest.body === null ? 2 : 1,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: id(31),
            paymentMethod: "CardMachine",
          },
          {
            orderBatchReference: id(91),
            orderItemReference: id(4),
            label: "Green tea",
            quantity: 1,
            unclaimedQuantity: 1,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: id(41),
            paymentMethod: "Online",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/preview", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    return route.fulfill({
      headers,
      json: {
        status: "Previewed",
        requestReference: body.requestReference,
        operationReference: body.operationReference,
        claimVersion: 0,
        currencyCode: "CAD",
        amountMinor: "621",
        paymentAttemptReferences: [id(32)],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        components: {
          netAmountMinor: "495",
          taxAmountMinor: "64",
          tipAmountMinor: "62",
          serviceChargeAmountMinor: "0",
          serviceChargeTaxAmountMinor: "0",
        },
      },
    });
  });
  await page.route("**/merchant/payments/refunds/request", (route) => {
    recordedRequest.body = JSON.parse(route.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
    return route.fulfill({
      status: 202,
      headers,
      json: {
        status: "RequestRecorded",
        requestReference: recordedRequest.body?.requestReference,
        operationReference: recordedRequest.body?.operationReference,
        claimVersion: 1,
        currencyCode: "CAD",
        amountMinor: "621",
        paymentAttemptReferences: [id(32)],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        replayed: false,
      },
    });
  });
  await page.route("**/merchant/payments/refunds/status", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        requestReference: recordedRequest.body?.requestReference,
        operationReference: recordedRequest.body?.operationReference,
        observedAt: new Date().toISOString(),
        currencyCode: "CAD",
        amountMinor: "621",
        payments: [
          {
            paymentAttemptReference: id(32),
            paymentIntentReference: id(31),
            state: recorded ? "Confirmed" : "NotDispatched",
            method: "CardMachine",
            refundedOnCardMachineAt: recorded ? "2026-10-15T15:02:00.000Z" : null,
            cardMachineSlipReference: recorded ? "REF 5521" : null,
            executionOperationReference: null,
            executionApprovalReference: null,
            amountMinor: "621",
            confirmedMinor: recorded ? "621" : "0",
            pendingMinor: recorded ? "0" : "621",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/card-machine-record", (route) => {
    records.push(route.request().postData() ?? "");
    if (records.length === 1) return route.abort("failed");
    recorded = true;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(1),
        requestReference: recordedRequest.body?.requestReference,
        amountMinor: "621",
        refundedAt: "2026-10-15T15:02:00.000Z",
        receipt: "NoDigitalReceipt",
      },
    });
  });
  // A card-machine refund is never prepared or sent to the payment provider.
  const providerCalls: string[] = [];
  for (const path of ["prepare", "send", "reconcile"])
    await page.route("**/merchant/payments/refunds/" + path, (route) => {
      providerCalls.push(path);
      return route.fulfill({ status: 500, headers, json: {} });
    });

  await page.goto("/app/operations/payments/" + id(31) + "/refund");
  const summary = page.getByRole("region", { name: "Payment financial summary" });
  await expect(summary).toContainText("Paid on the store's card machine");
  await expect(summary).toContainText("$24.86");
  await page.getByRole("button", { name: "Load refundable items" }).click();
  // Items paid on the card machine are never mixed with items paid online.
  await page.getByRole("spinbutton", { name: /Pad thai/ }).fill("1");
  await page.getByRole("spinbutton", { name: /Green tea/ }).fill("1");
  await page.getByRole("combobox", { name: "Reason" }).selectOption("QUALITY_ISSUE");
  await page.getByRole("button", { name: "Calculate refund" }).click();
  await expect(page.getByText(/Refund items paid on the card machine separately/u)).toBeVisible();
  await page.getByRole("spinbutton", { name: /Green tea/ }).fill("0");
  await page.getByRole("button", { name: "Calculate refund" }).click();
  const calculation = page.getByRole("region", { name: "Refund calculation" });
  await expect(calculation).toContainText("$6.21");
  await expect(calculation).toContainText("Tax");
  await expect(calculation).toContainText("$0.64");
  await expect(calculation).toContainText("Paid on the store's card machine");
  await page.getByRole("checkbox", { name: /I confirm/ }).check();
  await page.getByRole("button", { name: "Record refund request" }).click();
  await expect(page.getByText(/Now refund it on the store's card machine/u)).toBeVisible();
  // WP-2423: once recorded, the confirmation and its button are gone (no second request by mistake).
  await expect(page.getByRole("button", { name: "Record refund request" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /I confirm/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh recorded requests" }).click();
  const requests = page.getByRole("region", { name: "Recorded refund requests" });
  await expect(requests).toContainText("To refund on the card machine");
  await page.getByRole("button", { name: "Check execution status for request 1" }).click();
  await expect(page.getByRole("button", { name: "Send refund", exact: true })).toHaveCount(0);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await expectNoInternalText(page);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual(
    [],
  );
  // A card number is never accepted as the slip reference.
  const slip = page.getByRole("textbox", { name: "Slip reference (optional)" });
  await slip.fill("4111 1111 1111 1111");
  await expect(page.getByRole("button", { name: "Refunded $6.21 on card machine" })).toBeDisabled();
  await slip.fill("REF 5521");
  await page.getByRole("button", { name: "Refunded $6.21 on card machine" }).click();
  await expect(page.getByText(/Result unknown\. Record it again/u)).toBeVisible();
  await page.getByRole("button", { name: "Refunded $6.21 on card machine" }).click();
  await expect(
    page.getByText(/^Card-machine refund recorded: \$6\.21 refunded on the card machine/u),
  ).toBeVisible();
  // Without a reload: the request, its status and the payment amounts are reread from the server,
  // and the last amounts stay shown while they update (never "unavailable" unless a read failed).
  await expect(page.getByText("Payment amounts are unavailable until refreshed.")).toHaveCount(0);
  await expect(requests).toContainText("Refunded on the card machine");
  await expect(page.getByText(/Slip reference: REF 5521\./u)).toBeVisible();
  await expect(summary).toContainText("Payment state: Partly refunded");
  await expect(summary).not.toContainText("Captured");
  // The retry reused the same operation: the refund is counted once.
  expect(records).toHaveLength(2);
  expect(records[1]).toBe(records[0]);
  expect(JSON.parse(records[0] ?? "{}")).toMatchObject({
    orderReference: id(1),
    requestReference: recordedRequest.body?.requestReference,
    slipReference: "REF 5521",
    refundedAt: null,
  });
  expect(providerCalls).toEqual([]);
  await expectNoInternalText(page);
});

test("@production an owner approves a card-machine refund and is told to make it on the machine", async ({
  page,
}) => {
  const approvals: string[] = [];
  const entry = {
    orderReference: id(1),
    orderNumber: "T4-2",
    requestReference: id(2),
    paymentIntentReferences: [id(31)],
    paymentMethod: "CardMachine",
    currencyCode: "CAD",
    amountMinor: "12430",
    reasonCode: "STORE_ERROR",
    note: null,
    escalationReasons: ["OrderOrdinaryTotalAboveCad100"],
    requestedAt: new Date(Date.now() - 60_000).toISOString(),
    requesterName: "Mia",
    requestedByYou: false,
    requesterVerifiedUntil: new Date(Date.now() + 14 * 60_000).toISOString(),
    state: "AwaitingApproval",
    approvalReference: null,
    approvedAt: null,
    approverName: null,
    canApprove: true,
    soleOperatorApproval: false,
  };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-10-15",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "APPROVAL-INBOX",
              label: "Approvals",
              href: "/app/approvals",
              permission: "workflow.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/organization/sole-operator", (route) =>
    route.fulfill({ headers, json: { brandOwner: false } }),
  );
  await page.route("**/merchant/identity/step-up", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ headers, json: { validUntil: null } });
    const at = Date.now();
    return route.fulfill({
      headers,
      json: {
        status: "Verified",
        verifiedAt: new Date(at).toISOString(),
        validUntil: new Date(at + 15 * 60_000).toISOString(),
      },
    });
  });
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: true,
        soleOperator: null,
        entries: [entry],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/approve", (route) => {
    approvals.push(route.request().postData() ?? "");
    return route.fulfill({
      status: 202,
      headers,
      json: {
        status: "Approved",
        approvalReference: JSON.parse(route.request().postData() ?? "{}").approvalReference,
        replayed: false,
        payments: [
          {
            paymentAttemptReference: id(32),
            operationReference: id(33),
            state: "RecordOnCardMachine",
          },
        ],
      },
    });
  });
  await page.goto("/app/approvals");
  const card = page.getByRole("listitem").filter({ hasText: "T4-2" });
  const approve = card.getByRole("button", { name: "Approve card machine refund of $124.30" });
  // Owner 2026-10-25: Approve asks for the code when needed, then goes ahead.
  await approve.click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await dialog.getByLabel("Six-digit code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText(
    "Approved — refund it on the store's card machine, then record it",
  );
  await expect(card.getByRole("status")).toContainText(
    "Refund $124.30 on the store's card machine",
  );
  await expect(card.getByRole("link", { name: "Record the card machine refund" })).toHaveAttribute(
    "href",
    "/app/operations/payments/" + id(31),
  );
  // Nothing more to send: the approve button is gone once approved.
  await expect(approve).toHaveCount(0);
  expect(approvals).toHaveLength(1);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await expectNoInternalText(page);
});

// v15 2026-10-17: after refunding on the card machine, staff record it from the payment page
// itself. Each recorded refund of this payment still to be made on the machine is listed with an
// obvious record action; a request of another payment of the same order is left to that payment.
test("@production the payment page offers recording a pending card-machine refund directly", async ({
  page,
}) => {
  let recorded = false;
  const records: string[] = [];
  const statusReads: string[] = [];
  const request = (n: number, operation: number) => ({
    requestReference: id(40 + n),
    operationReference: id(operation),
    claimVersion: n,
    requestedAt: "2026-10-15T15:00:00.000Z",
    reasonCode: "QUALITY_ISSUE",
    currencyCode: "CAD",
    amountMinor: n === 1 ? "480" : "300",
    decline: null,
    progress: n === 1 && recorded ? "Refunded" : "Recorded",
    paymentMethod: "CardMachine",
  });
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-10-15",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: false,
        soleOperator: null,
        entries: [],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: {
        paymentIntentReference: id(31),
        paymentAttemptReference: id(32),
        orderReference: id(1),
        orderBatchReference: id(90),
        observedAt: new Date().toISOString(),
        paymentState: "Captured",
        paymentMethod: "CardMachine",
        currencyCode: "CAD",
        capturedAmountMinor: "2486",
        confirmedRefundMinor: recorded ? "480" : "0",
        pendingRefundMinor: recorded ? "0" : "480",
        canRequest: true,
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderNumber: "T4-2",
        canRequest: true,
        claimVersion: 2,
        // Request 2 refunds the order's other card-machine payment (another round).
        recentRequests: [request(1, 51), request(2, 52)],
        items: [
          {
            orderBatchReference: id(90),
            orderItemReference: id(3),
            label: "Pad thai",
            quantity: 2,
            unclaimedQuantity: 1,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: id(31),
            paymentMethod: "CardMachine",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/status", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { operationReference: string };
    statusReads.push(body.operationReference);
    const first = body.operationReference === id(51);
    const done = first && recorded;
    return route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        requestReference: first ? id(41) : id(42),
        operationReference: body.operationReference,
        observedAt: new Date().toISOString(),
        currencyCode: "CAD",
        amountMinor: first ? "480" : "300",
        payments: [
          {
            paymentAttemptReference: first ? id(32) : id(62),
            paymentIntentReference: first ? id(31) : id(61),
            state: done ? "Confirmed" : "NotDispatched",
            method: "CardMachine",
            refundedOnCardMachineAt: done ? "2026-10-15T15:02:00.000Z" : null,
            cardMachineSlipReference: done ? "REF 7710" : null,
            executionOperationReference: null,
            executionApprovalReference: null,
            amountMinor: first ? "480" : "300",
            confirmedMinor: done ? "480" : "0",
            pendingMinor: done ? "0" : first ? "480" : "300",
          },
        ],
      },
    });
  });
  await page.route("**/merchant/payments/refunds/card-machine-record", (route) => {
    records.push(route.request().postData() ?? "");
    recorded = true;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(1),
        requestReference: id(41),
        amountMinor: "480",
        refundedAt: "2026-10-15T15:02:00.000Z",
        receipt: "NoDigitalReceipt",
      },
    });
  });
  const providerCalls: string[] = [];
  for (const path of ["prepare", "send", "reconcile", "request", "preview"])
    await page.route("**/merchant/payments/refunds/" + path, (route) => {
      providerCalls.push(path);
      return route.fulfill({ status: 500, headers, json: {} });
    });

  await page.goto("/app/operations/payments/" + id(31));
  const summary = page.getByRole("region", { name: "Payment financial summary" });
  await expect(summary).toContainText("$4.80");
  const pending = page.getByRole("region", { name: "Refunds to make on the card machine" });
  const action = pending.getByRole("button", {
    name: "Record the card-machine refund for request 1 ($4.80)",
  });
  await expect(action).toBeVisible();
  // The order's other card-machine payment is not offered on this payment's page.
  await expect(pending).not.toContainText("Request 2");
  await expect(pending.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Start refund request" })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("payment-page-card-machine-refund-" + width + ".png"),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await action.click();
  const slip = pending.getByRole("textbox", { name: "Slip reference (optional)" });
  await slip.fill("REF 7710");
  await expectNoInternalText(page);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual(
    [],
  );
  await pending.getByRole("button", { name: "Refunded $4.80 on card machine" }).click();
  await expect(
    pending.getByText(/^Card-machine refund recorded: \$4\.80 refunded on the card machine/u),
  ).toBeVisible();
  // The amounts are reread from the server; nothing is left to record on this payment.
  await expect(summary).toContainText("Payment state: Partly refunded");
  await expect(
    pending.getByRole("button", { name: /Record the card-machine refund/u }),
  ).toHaveCount(0);
  expect(records).toHaveLength(1);
  expect(JSON.parse(records[0] ?? "{}")).toMatchObject({
    orderReference: id(1),
    requestReference: id(41),
    slipReference: "REF 7710",
    refundedAt: null,
  });
  expect(statusReads).toContain(id(52));
  expect(providerCalls).toEqual([]);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await expectNoInternalText(page);
});
