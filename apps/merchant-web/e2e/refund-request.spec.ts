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
      // WP-2423 item 6: once really sent, the card provider answered that it refunded it.
      if (sends.length > 1) recoveredPhase = "Confirmed";
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
      decline: null;
      paymentMethod: "Online";
    } | null = null;
    // WP-2423 item 6: where the request stands, as the server derives it from the payment states.
    const progress = () =>
      recoveredPhase === "Confirmed"
        ? "Refunded"
        : recoveredPhase === "NeedsReconciliation"
          ? "Sending"
          : preparedOperation
            ? "ReadyToSend"
            : "Recorded";
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
                  canCancel: false,
                  staffCancellation: null,
                  canCancelItems: false,
                },
              ],
              canRequestAcceptance: false,
              currentPhase: "Fulfilled",
              currentVersion: 4,
              unfulfillable: null,
              pickupNotCollected: false,
              acceptBy: null,
              awaitingPayment: false,
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
          paymentMethod: "Online",
          currencyCode: "CAD",
          capturedAmountMinor: "2260",
          confirmedRefundMinor: recoveredPhase === "Confirmed" ? "1130" : "0",
          pendingRefundMinor: persisted && recoveredPhase !== "Confirmed" ? "1130" : "0",
          canRequest: true,
        },
      }),
    );
    await page.route("**/merchant/payments/refunds/items", (route) =>
      route.fulfill({
        headers,
        json: {
          orderReference: id(1),
          orderNumber: "ORD-1",
          canRequest: true,
          claimVersion: persisted ? 1 : 0,
          recentRequests: persisted ? [{ ...persisted, progress: progress() }] : [],
          items: [
            {
              orderBatchReference: id(90),
              orderItemReference: id(3),
              label: "Latte",
              quantity: 2,
              unclaimedQuantity: persisted ? 1 : 2,
              paymentCaptured: true,
              refundedByCancellation: false,
              paymentIntentReference: id(31),
              paymentMethod: "Online",
            },
            // WP-2423 Q5: a line from a round cancelled before payment was never charged.
            {
              orderBatchReference: id(91),
              orderItemReference: id(4),
              label: "Tea",
              quantity: 1,
              unclaimedQuantity: 0,
              paymentCaptured: false,
              refundedByCancellation: false,
              paymentIntentReference: null,
              paymentMethod: null,
            },
            // A round the store cancelled was refunded whole by that cancellation (v15 order 7).
            {
              orderBatchReference: id(92),
              orderItemReference: id(5),
              label: "Soup",
              quantity: 1,
              unclaimedQuantity: 0,
              paymentCaptured: true,
              refundedByCancellation: true,
              paymentIntentReference: id(33),
              paymentMethod: "Online",
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
              method: "Online",
              refundedOnCardMachineAt: null,
              cardMachineSlipReference: null,
              executionOperationReference: preparedOperation,
              executionApprovalReference: null,
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
    // WP-2423 Q5: nothing at this Store is waiting for an owner's approval.
    await page.route("**/merchant/payments/refunds/approvals", (route) =>
      route.fulfill({
        headers,
        json: {
          observedAt: "2026-09-20T12:01:00.000Z",
          canApprove: false,
          soleOperator: null,
          entries: [],
        },
      }),
    );
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
          approvalRequired: false,
          escalationReasons: [],
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
        decline: null,
        paymentMethod: "Online",
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
          approvalRequired: false,
          escalationReasons: [],
          replayed: true,
        },
      });
    });
    await page.goto("/operations/orders");
    await page.getByRole("button", { name: "Payments and refunds" }).click();
    await page.getByRole("link", { name: "Payment 1 · refunds and details" }).click();
    await expect(page).toHaveURL(new RegExp("/app/operations/payments/" + id(31) + "$"));
    await expect(page.getByRole("region", { name: "Payment financial summary" })).toContainText(
      "$22.60",
    );
    await page.getByRole("link", { name: "Start refund request" }).click();
    await page.getByRole("button", { name: "Load refundable items" }).click();
    await expect(page.getByRole("spinbutton", { name: /Tea/ })).toHaveCount(0);
    await expect(page.getByText("Not charged, so not refundable: Tea.")).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: /Soup/ })).toHaveCount(0);
    await expect(
      page.getByText("Already refunded in full when the round was cancelled: Soup."),
    ).toBeVisible();
    await page.getByRole("spinbutton", { name: /Latte/ }).fill("1");
    await page.getByRole("combobox", { name: "Reason" }).selectOption("CUSTOMER_REQUEST");
    await page.getByRole("button", { name: "Calculate refund" }).click();
    await expect(page.getByRole("region", { name: "Refund calculation" })).toContainText("$11.30");
    // WP-2423 Q5: calculating again with an unchanged selection reuses the same request identity.
    await page.getByRole("button", { name: "Calculate refund" }).click();
    await expect(page.getByRole("region", { name: "Refund calculation" })).toContainText("$11.30");
    expect(previews).toHaveLength(2);
    expect(previews[1]).toBe(previews[0]);
    // WP-2423 item 6: a refund needing no approval is sent on this one confirmation.
    const sendNow = page.getByRole("button", { name: "Send $11.30 refund", exact: true });
    await expect(page.getByRole("region", { name: "Refund calculation" })).toContainText(
      "as soon as you confirm",
    );
    await expect(page.getByRole("button", { name: "Record refund request" })).toHaveCount(0);
    await expect(sendNow).toBeDisabled();
    await page.getByRole("checkbox", { name: /I confirm/ }).check();
    await sendNow.click();
    await expect(page.getByText("Request result unknown.", { exact: false })).toBeVisible();
    // Nothing is prepared or sent while the request's own result is unknown.
    expect(preparations).toHaveLength(0);
    expect(sends).toHaveLength(0);
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
    const list = page.getByRole("region", { name: "Recorded refund requests" });
    if (recovery === "retry") {
      // The same request is retried, then the refund continues on its own: getting it ready to
      // send is lost once, so it stops there and says nothing was sent.
      await page.getByRole("button", { name: "Retry same refund request" }).click();
      await expect(
        page.getByText("getting it ready to send was not confirmed", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByText("Nothing has been sent to the card provider.", { exact: false }),
      ).toBeVisible();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
      expect(preparations).toHaveLength(1);
      expect(sends).toHaveLength(0);
      // The recorded request is listed straight away and never called sent.
      await expect(list).toContainText("Request 1: $11.30");
      await expect(list).toContainText("Not sent yet");
      await expect(list).not.toContainText("Sent");
      // Its own controls point back to the refund form, which resumes the same refund.
      await page.getByRole("button", { name: "Check execution status for request 1" }).click();
      await expect(
        page.getByRole("region", { name: "Execution status for request 1" }),
      ).toContainText("Continue sending this refund with the button under the refund form.");
      await expect(page.getByRole("button", { name: "Send refund", exact: true })).toHaveCount(0);
      // The form is cleared and locked behind the recorded request.
      await expect(page.getByRole("checkbox", { name: /I confirm the selected/ })).toHaveCount(0);
      await expect(page.getByRole("spinbutton", { name: /Latte/ })).toHaveValue("0");
      await page.getByRole("button", { name: "Continue sending this refund" }).click();
      // The send's result is lost: staff are told it is not confirmed, never that it was sent.
      await expect(
        page.getByText("It is not confirmed that the card provider received this refund.", {
          exact: false,
        }),
      ).toBeVisible();
      expect(preparations).toHaveLength(2);
      expect(preparations[1]).toBe(preparations[0]);
      expect(sends).toHaveLength(1);
      // Another request cannot be started while this send is unconfirmed.
      await expect(page.getByRole("button", { name: "Start another refund request" })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: "Continue sending this refund" }).click();
      // Sent; checking the card provider's answer is lost once, and says the refund was sent.
      await expect(
        page.getByText("The refund was sent to the card provider, but its answer could not", {
          exact: false,
        }),
      ).toBeVisible();
      expect(sends).toHaveLength(2);
      expect(sends[1]).toBe(sends[0]);
      expect(JSON.parse(sends[0] ?? "{}").operationReference).toBe(preparedOperation);
      expect(preparations).toHaveLength(2);
      await page.getByRole("button", { name: "Check the card provider's answer again" }).click();
      await expect(
        page.getByText("Refunded $11.30 to the customer's original payment method.", {
          exact: false,
        }),
      ).toBeVisible();
      expect(reconciliations).toHaveLength(2);
      expect(reconciliations[1]).toBe(reconciliations[0]);
      expect(JSON.parse(reconciliations[0] ?? "{}").operationReference).toBe(preparedOperation);
      // Every step ran once more only where it was lost; nothing was sent twice.
      expect(requests).toHaveLength(2);
      expect(preparations).toHaveLength(2);
      expect(sends).toHaveLength(2);
      await expect(list).toContainText("Refunded");
      await expect(
        page.getByRole("button", { name: "Start another refund request" }),
      ).toBeVisible();
      const summary = page.getByRole("region", { name: "Payment financial summary" });
      await expect(
        summary
          .locator("div")
          .filter({ has: page.getByText("Confirmed refunds", { exact: true }) }),
      ).toContainText("$11.30");
      // After a reload, a sent refund only offers checking its answer and receipt.
      for (const phase of ["NeedsReconciliation", "Confirmed"] as const) {
        recoveredPhase = phase;
        const lookupsBefore = reconciliations.length;
        await page.reload();
        await page.getByRole("button", { name: "Load refundable items" }).click();
        await expect(list).toContainText(
          phase === "Confirmed" ? "Refunded" : "Sent — waiting for the card provider's answer",
        );
        await page.getByRole("button", { name: "Check execution status for request 1" }).click();
        const execution = page.getByRole("region", { name: "Execution status for request 1" });
        await expect(execution).toContainText(
          phase === "Confirmed"
            ? "Refunded. Requested $11.30; confirmed $11.30; pending $0.00."
            : "Sent — waiting for the card provider's answer. Requested $11.30; confirmed $0.00; pending $11.30.",
        );
        // WP-2423 Q5: the set-aside note appears only while an amount is still pending.
        await expect(
          execution.getByText("A pending amount stays set aside", { exact: false }),
        ).toHaveCount(phase === "Confirmed" ? 0 : 1);
        await expect(page.getByRole("button", { name: "Send refund", exact: true })).toHaveCount(0);
        await page
          .getByRole("button", { name: "Check refund result and receipt", exact: true })
          .click();
        await expect(page.getByText("Answer checked.", { exact: false })).toBeVisible();
        await expect(
          page.getByText(
            phase === "Confirmed"
              ? "Refund receipt version 2 created."
              : "The receipt on file stays version 1 (Original); no new receipt was created.",
            { exact: false },
          ),
        ).toBeVisible();
        expect(reconciliations).toHaveLength(lookupsBefore + 1);
        expect(JSON.parse(reconciliations[lookupsBefore] ?? "{}").operationReference).toBe(
          preparedOperation,
        );
        expect(preparations).toHaveLength(2);
        expect(sends).toHaveLength(2);
      }
    } else {
      await page.getByRole("button", { name: "Check recorded requests" }).click();
      await expect(page.getByText("Original request recovered.", { exact: false })).toBeVisible();
      // The recorded request is listed straight away, without a manual refresh.
      await expect(list).toContainText("Request 1: $11.30");
      expect(previews).toHaveLength(2);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toBe(previews[0]);
      // WP-2423: the recorded request's confirmation is gone; another request is started on purpose.
      await expect(sendNow).toHaveCount(0);
      await expect(page.getByRole("checkbox", { name: /I confirm the selected/ })).toHaveCount(0);
      await expect(page.getByRole("spinbutton", { name: /Latte/ })).toHaveValue("0");
      await expect(
        page.getByRole("button", { name: "Start another refund request" }),
      ).toBeVisible();
      await page.route("**/merchant/payments/refunds/items", (route) => route.abort("failed"), {
        times: 1,
      });
      await page.getByRole("button", { name: "Refresh recorded requests" }).click();
      await expect(
        page.getByText("Unable to refresh this information.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Calculate refund" })).toBeDisabled();
      await page.getByRole("button", { name: "Refresh recorded requests" }).click();
      await expect(page.getByText("Request remains recorded.", { exact: false })).toBeVisible();
      await expect(list).toContainText("Request 1: $11.30");
      // v15 2026-10-18 (dd750045): a refund recorded for this order while the list was loading
      // answers "changed while loading"; the page reads it once more by itself and shows the
      // latest, never "your permissions do not allow this refund workflow".
      const itemStatuses: number[] = [];
      page.on("response", (response) => {
        if (response.url().endsWith("/merchant/payments/refunds/items"))
          itemStatuses.push(response.status());
      });
      await page.route(
        "**/merchant/payments/refunds/items",
        (route) =>
          route.fulfill({ status: 409, headers, json: { error: "changed_while_loading" } }),
        { times: 1 },
      );
      await page.getByRole("button", { name: "Refresh recorded requests" }).click();
      await expect.poll(() => itemStatuses).toEqual([409, 200]);
      await expect(page.getByText("Request remains recorded.", { exact: false })).toBeVisible();
      await expect(list).toContainText("Request 1: $11.30");
      await expect(page.getByText(/permissions do not allow/u)).toHaveCount(0);
      await expect(page.getByText(/changed while it was loading/u)).toHaveCount(0);
      // WP-2423 Q5: each recorded request shows where it stands without a separate check.
      await expect(list).toContainText("Recorded, not sent yet");
      await expect(page.getByRole("spinbutton", { name: /Latte/ })).toHaveAttribute("max", "1");
      await page.getByRole("button", { name: "Check execution status for request 1" }).click();
      await expect(
        page.getByRole("region", { name: "Execution status for request 1" }),
      ).toContainText("Not sent yet. Requested $11.30; confirmed $0.00; pending $11.30.");
      // A recorded request not sent yet is sent from here with one confirmation.
      const send = page.getByRole("button", { name: "Send refund", exact: true });
      await expect(send).toBeDisabled();
      await page
        .getByRole("checkbox", {
          name: "I confirm sending this $11.30 refund to the customer's original payment method",
          exact: true,
        })
        .check();
      await send.click();
      await expect(
        page.getByText("sending refunds is not set up for this store", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Continue sending this refund" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh recorded requests" })).toBeEnabled();
      expect(preparations).toHaveLength(1);
      expect(sends).toHaveLength(0);
    }
    expect(requests).toHaveLength(recovery === "retry" ? 2 : 1);
  });
