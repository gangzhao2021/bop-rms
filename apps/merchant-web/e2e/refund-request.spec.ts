import { expect, test } from "@playwright/test";

for (const recovery of ["retry", "history"] as const)
  test("@production refund request recovery via " + recovery, async ({ page }) => {
    const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
    const scope = {
      brandLabel: "Synthetic Brand",
      storeLabel: "Synthetic Store",
      storeReference: id(99),
    };
    const headers = { "cache-control": "no-store" };
    let preparedOperation: string | null = null;
    let recoveredPhase: "NeedsReconciliation" | "Confirmed" | null = null;
    const preparations: string[] = [];
    const sends: string[] = [],
      reconciliations: string[] = [];
    await page.route("**/merchant/payments/refunds/send", (route) => {
      sends.push(route.request().postData() ?? "");
      return route.fulfill({
        status: sends.length === 1 ? 503 : 202,
        headers: { "cache-control": "no-store" },
        json:
          sends.length === 1
            ? { error: "refund_execution_unknown" }
            : { status: "DispatchRecorded" },
      });
    });
    await page.route("**/merchant/payments/refunds/reconcile", (route) => {
      reconciliations.push(route.request().postData() ?? "");
      if (reconciliations.length === 1) return route.abort("failed");
      return route.fulfill({
        status: 202,
        headers: { "cache-control": "no-store" },
        json: {
          status: "ReconciliationRecorded",
          receipt: {
            status: recoveredPhase === "Confirmed" ? "Created" : "Existing",
            version: recoveredPhase === "Confirmed" ? 2 : 1,
            kind: recoveredPhase === "Confirmed" ? "Refund" : "Original",
          },
        },
      });
    });
    let persisted: {
      requestReference: string;
      operationReference: string;
      claimVersion: number;
      requestedAt: string;
      reasonCode: string;
      currencyCode: string;
      amountMinor: string;
    } | null = null;
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
            businessDate: "2026-09-14",
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

    await page.route("**/merchant/orders", (route) =>
      route.fulfill({
        headers,
        json: {
          items: [
            {
              orderReference: id(1),
              orderNumber: "ORD-1",
              orderType: "Pickup",
              sourceChannel: "Web",
              submittedAt: "2026-09-14T00:00:00.000Z",
              observedAt: "2026-09-14T00:01:00.000Z",
              initialBatchReference: id(90),
              batches: [
                {
                  orderBatchReference: id(90),
                  sequence: 1,
                  acceptanceStatus: "Accepted",
                  canRequestAcceptance: false,
                },
              ],
              canRequestAcceptance: false,
              currentPhase: "Fulfilled",
              currentVersion: 4,
            },
          ],
          nextAfterOrderReference: null,
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
          observedAt: "2026-09-14T00:01:00.000Z",
          paymentState: "Captured",
          currencyCode: "CAD",
          capturedAmountMinor: "2260",
          confirmedRefundMinor: recoveredPhase === "Confirmed" ? "1130" : "0",
          pendingRefundMinor: persisted && recoveredPhase !== "Confirmed" ? "1130" : "0",
        },
      }),
    );
    await page.route("**/merchant/payments/refunds/items", (route) =>
      route.fulfill({
        headers,
        json: {
          orderReference: id(1),
          orderNumber: "ORD-1",
          claimVersion: persisted ? 1 : 0,
          recentRequests: persisted ? [persisted] : [],
          items: [
            {
              orderBatchReference: id(90),
              orderItemReference: id(3),
              label: "Latte",
              quantity: 2,
              unclaimedQuantity: persisted ? 1 : 2,
              paymentCaptured: true,
              paymentIntentReference: id(31),
            },
          ],
        },
      }),
    );
    const previews: string[] = [],
      requests: string[] = [];
    await page.route("**/merchant/payments/refunds/status", (route) =>
      route.fulfill({
        headers,
        json: {
          orderReference: id(1),
          requestReference: persisted?.requestReference,
          operationReference: persisted?.operationReference,
          observedAt: "2026-09-20T12:01:00.000Z",
          currencyCode: "CAD",
          amountMinor: "1130",
          payments: [
            {
              paymentAttemptReference: id(32),
              paymentIntentReference: id(31),
              state: recoveredPhase ?? (preparedOperation ? "Prepared" : "NotDispatched"),
              executionOperationReference: preparedOperation,
              amountMinor: "1130",
              confirmedMinor: recoveredPhase === "Confirmed" ? "1130" : "0",
              pendingMinor: recoveredPhase === "Confirmed" ? "0" : "1130",
            },
          ],
        },
      }),
    );
    await page.route("**/merchant/payments/refunds/prepare", (route) => {
      const body = route.request().postData() ?? "";
      preparations.push(body);
      if (recovery === "history")
        return route.fulfill({
          status: 503,
          headers,
          json: { error: "refund_preparation_unavailable" },
        });
      const command = JSON.parse(body);
      preparedOperation = command.operationReference;
      if (preparations.length === 1) return route.abort("failed");
      return route.fulfill({
        status: 202,
        headers,
        json: {
          status: "PreparationRecorded",
          operationReference: command.operationReference,
          replayed: true,
        },
      });
    });
    await page.route("**/merchant/payments/refunds/preview", (route) => {
      const body = route.request().postData() ?? "";
      previews.push(body);
      const command = JSON.parse(body);
      return route.fulfill({
        headers,
        json: {
          status: "Previewed",
          requestReference: command.requestReference,
          operationReference: command.operationReference,
          claimVersion: 0,
          currencyCode: "CAD",
          amountMinor: "1130",
          paymentAttemptReferences: [id(32)],
          components: {
            netAmountMinor: "1000",
            taxAmountMinor: "130",
            tipAmountMinor: "0",
            serviceChargeAmountMinor: "0",
            serviceChargeTaxAmountMinor: "0",
          },
        },
      });
    });
    await page.route("**/merchant/payments/refunds/request", (route) => {
      const body = route.request().postData() ?? "";
      requests.push(body);
      const command = JSON.parse(body);
      persisted = {
        requestReference: command.requestReference,
        operationReference: command.operationReference,
        claimVersion: 1,
        requestedAt: "2026-09-20T12:00:00.000Z",
        reasonCode: "CUSTOMER_REQUEST",
        currencyCode: "CAD",
        amountMinor: "1130",
      };
      if (requests.length === 1) return route.abort("failed");
      return route.fulfill({
        status: 202,
        headers,
        json: {
          status: "RequestRecorded",
          requestReference: command.requestReference,
          operationReference: command.operationReference,
          claimVersion: 1,
          currencyCode: "CAD",
          amountMinor: "1130",
          paymentAttemptReferences: [id(32)],
          replayed: true,
        },
      });
    });
    await page.goto("/operations/orders");
    await page.getByRole("button", { name: "View payments and refunds" }).click();
    await page.getByRole("link", { name: "Open payment 1" }).click();
    await expect(page).toHaveURL(new RegExp("/app/operations/payments/" + id(31) + "$"));
    await expect(page.getByRole("region", { name: "Payment financial summary" })).toContainText(
      "CAD 22.60",
    );
    await page.getByRole("link", { name: "Start refund request" }).click();
    await page.getByRole("button", { name: "Load refundable items" }).click();
    await page.getByRole("spinbutton", { name: /Latte/ }).fill("1");
    await page.getByRole("button", { name: "Calculate refund" }).click();
    await expect(page.getByRole("region", { name: "Refund calculation" })).toContainText(
      "CAD 11.30",
    );
    await expect(page.getByRole("button", { name: "Record refund request" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /I confirm/ }).check();
    await page.getByRole("button", { name: "Record refund request" }).click();
    await expect(page.getByText("Request result unknown.", { exact: false })).toBeVisible();
    await page.route(
      "**/merchant/payments/refunds/context",
      (route) =>
        route.fulfill({
          status: 403,
          headers,
          json: { error: "permission_denied" },
        }),
      { times: 1 },
    );
    await page.getByRole("button", { name: "Refresh payment amounts", exact: true }).click();
    await expect(page.getByRole("region", { name: "Payment financial summary" })).toHaveCount(0);
    await expect(page.getByText("Payment amounts are unavailable until refreshed.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry same refund request", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh payment amounts", exact: true }).click();
    await expect(page.getByRole("region", { name: "Payment financial summary" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry same refund request", exact: true }),
    ).toBeVisible();

    await expect(page.getByRole("spinbutton", { name: /Latte/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Calculate refund" })).toBeDisabled();
    await page
      .getByRole("button", {
        name: recovery === "retry" ? "Retry same refund request" : "Check recorded requests",
      })
      .click();
    await expect(page.getByText("Original request recovered.", { exact: false })).toBeVisible();
    expect(previews).toHaveLength(1);
    expect(requests).toHaveLength(recovery === "retry" ? 2 : 1);
    expect(requests[0]).toBe(previews[0]);
    if (recovery === "retry") expect(requests[1]).toBe(requests[0]);
    await expect(page.getByRole("button", { name: "Record refund request" })).toBeDisabled();
    await page.route("**/merchant/payments/refunds/items", (route) => route.abort("failed"), {
      times: 1,
    });
    await page.getByRole("button", { name: "Refresh recorded requests" }).click();
    await expect(
      page.getByText("Unable to refresh this information.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Record refund request" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Calculate refund" })).toBeDisabled();
    await page.getByRole("button", { name: "Refresh recorded requests" }).click();
    await expect(page.getByText("Request remains recorded.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record refund request" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Recorded refund requests" })).toContainText(
      "Request 1: CAD 11.30",
    );
    await expect(page.getByRole("spinbutton", { name: /Latte/ })).toHaveAttribute("max", "1");
    await page.getByRole("button", { name: "Check execution status for request 1" }).click();
    await expect(
      page.getByRole("region", { name: "Execution status for request 1" }),
    ).toContainText("Not dispatched. Requested CAD 11.30; confirmed CAD 0.00; pending CAD 11.30.");
    await page.getByRole("button", { name: "Prepare refund execution" }).click();
    if (recovery === "history") {
      await expect(
        page.getByText("Refund preparation is not configured for this store.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh recorded requests" })).toBeEnabled();
      expect(preparations).toHaveLength(1);
    } else {
      await expect(page.getByText("Preparation result unknown.", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh recorded requests" })).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Check execution status for request 1" }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Retry same refund preparation" }).click();
      await expect(
        page.getByText("Original preparation recovered.", { exact: false }),
      ).toBeVisible();
      expect(preparations).toHaveLength(2);
      expect(preparations[0]).toBe(preparations[1]);
      await page.reload();
      await page.getByRole("button", { name: "Load refundable items" }).click();
      await page.getByRole("button", { name: "Check execution status for request 1" }).click();
      await expect(
        page.getByRole("region", { name: "Execution status for request 1" }),
      ).toContainText("Preparation recorded; awaiting dispatch");
      await expect(page.getByRole("button", { name: "Prepare refund execution" })).toHaveCount(0);
      expect(sends).toHaveLength(0);
      await expect(page.getByRole("button", { name: "Send refund", exact: true })).toBeDisabled();
      await page
        .getByRole("checkbox", {
          name: "I confirm sending this CAD 11.30 refund to the original payment method",
          exact: true,
        })
        .check();
      await page.getByRole("button", { name: "Send refund", exact: true }).click();
      await expect(page.getByText("Result unknown.", { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Refresh payment amounts", exact: true }).click();
      await expect(page.getByRole("region", { name: "Payment financial summary" })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Retry same refund send", exact: true }),
      ).toBeVisible();

      await expect(
        page.getByRole("button", { name: "Check execution status for request 1", exact: true }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Retry same refund send", exact: true }).click();
      await expect(page.getByText("Dispatch recorded.", { exact: false })).toBeVisible();
      expect(sends).toHaveLength(2);
      expect(sends[0]).toBe(sends[1]);
      expect(JSON.parse(sends[0] ?? "{}").operationReference).toBe(preparedOperation);
      await expect(page.getByRole("button", { name: "Send refund", exact: true })).toHaveCount(0);
      await page
        .getByRole("button", { name: "Check refund result and receipt", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Retry same refund reconciliation", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Retry same refund reconciliation", exact: true })
        .click();
      await expect(page.getByText("Reconciliation recorded.", { exact: false })).toBeVisible();
      expect(reconciliations).toHaveLength(2);
      expect(reconciliations[0]).toBe(reconciliations[1]);
      for (const phase of ["NeedsReconciliation", "Confirmed"] as const) {
        recoveredPhase = phase;
        const lookupsBefore = reconciliations.length;
        await page.reload();
        await page.getByRole("button", { name: "Load refundable items" }).click();
        await page.getByRole("button", { name: "Check execution status for request 1" }).click();
        const status = page.getByRole("region", { name: "Execution status for request 1" });
        await expect(status).toContainText(
          phase === "Confirmed"
            ? "confirmed CAD 11.30; pending CAD 0.00"
            : "confirmed CAD 0.00; pending CAD 11.30",
        );
        await expect(page.getByRole("button", { name: "Prepare refund execution" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Send refund", exact: true })).toHaveCount(0);
        expect(preparations).toHaveLength(2);
        expect(sends).toHaveLength(2);
        expect(reconciliations).toHaveLength(lookupsBefore);
        await page
          .getByRole("button", { name: "Check refund result and receipt", exact: true })
          .click();
        await expect(page.getByText("Reconciliation recorded.", { exact: false })).toBeVisible();
        await expect(
          page.getByText(
            phase === "Confirmed"
              ? "Refund receipt version 2 created."
              : "Existing receipt version 1 (Original); no new receipt created.",
            { exact: false },
          ),
        ).toBeVisible();
        expect(reconciliations).toHaveLength(lookupsBefore + 1);
        expect(JSON.parse(reconciliations[lookupsBefore] ?? "{}").operationReference).toBe(
          preparedOperation,
        );
        if (phase === "Confirmed") {
          const summary = page.getByRole("region", { name: "Payment financial summary" });
          await expect(
            summary
              .locator("div")
              .filter({ has: page.getByText("Confirmed refunds", { exact: true }) }),
          ).toContainText("CAD 11.30");
          await expect(
            summary
              .locator("div")
              .filter({ has: page.getByText("Pending refunds", { exact: true }) }),
          ).toContainText("CAD 0.00");
        }
        expect(sends).toHaveLength(2);
      }
    }
    expect(requests).toHaveLength(recovery === "retry" ? 2 : 1);
  });
