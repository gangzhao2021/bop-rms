/** Merchant BFF routes: dining sessions, tables, table QR, order progress, serving and closing. Registered by createMerchantBffRouter (merchant-bff.ts). */
import { cookie, denied, exactHeader, NO_STORE, sameOriginMutation } from "./merchant-bff-http.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";
import { DiningServeReadyError } from "./merchant-dining-serve-ready-command.js";
import { DiningClosingError } from "@rms/dining";
import { DiningCheckoutAlreadyPaidError } from "./merchant-dining-closing-command.js";
import type { Response, Router } from "express";
import { DiningTableCheckoutError } from "./merchant-dining-table-checkout.js";

export function installMerchantDiningRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  router.post("/dining/sessions/join-state", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningJoinState) {
      response.status(503).json({ error: "dining_join_state_unavailable" });
      return;
    }
    void options
      .diningJoinState({ sessionCookie, csrf, query: request.body })
      .then((r) =>
        response.json({
          diningSessionReference: r.diningSessionReference,
          tableReference: r.tableReference,
          sessionVersion: r.sessionVersion,
          tableAssignmentVersion: r.tableAssignmentVersion,
          capabilityVersion: r.capabilityVersion,
          generation: r.generation,
          joinKind: r.joinKind,
        }),
      )
      .catch(() => denied(response));
  });
  router.post("/dining/sessions/regenerate", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningJoinRegenerate) {
      response.status(503).json({ error: "dining_join_regenerate_unavailable" });
      return;
    }
    void options
      .diningJoinRegenerate({ sessionCookie, csrf, command: request.body })
      .then((r) => {
        if (
          !r ||
          !["Issued", "AlreadyApplied"].includes(r.status) ||
          !Number.isSafeInteger(r.generation) ||
          r.generation < 1 ||
          !Number.isSafeInteger(r.capabilityVersion) ||
          r.capabilityVersion < 1 ||
          !["HumanCode", "Invitation"].includes(r.joinKind) ||
          (r.status === "Issued" &&
            (typeof r.joinCredential !== "string" ||
              !(r.joinKind === "HumanCode" ? /^[0-9]{6}$/u : /^[A-Za-z0-9_-]{22}$/u).test(
                r.joinCredential,
              )))
        ) {
          denied(response);
          return;
        }
        response.json({
          status: r.status,
          generation: r.generation,
          capabilityVersion: r.capabilityVersion,
          joinKind: r.joinKind,
          ...(r.status === "Issued" ? { joinCredential: r.joinCredential } : {}),
        });
      })
      .catch(() => denied(response));
  });

  router.post(
    "/dining/sessions/host-transfer",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.diningHostTransfer) {
        response.status(503).json({ error: "dining_host_transfer_unavailable" });
        return;
      }
      void options
        .diningHostTransfer({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          const reference =
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          if (
            !result ||
            !["Applied", "AlreadyApplied"].includes(result.status) ||
            !reference.test(result.operationReference) ||
            !reference.test(result.diningSessionReference) ||
            !reference.test(String(result.hostParticipantReference)) ||
            (result.previousHostParticipantReference !== null &&
              !reference.test(result.previousHostParticipantReference)) ||
            result.hostParticipantReference === result.previousHostParticipantReference ||
            !Number.isSafeInteger(result.sessionVersion) ||
            result.sessionVersion < 2 ||
            result.sessionVersion > 2147483647 ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result.transferredAt) ||
            !Number.isFinite(Date.parse(result.transferredAt)) ||
            new Date(result.transferredAt).toISOString() !== result.transferredAt
          ) {
            denied(response);
            return;
          }
          response.json({
            status: result.status,
            operationReference: result.operationReference,
            diningSessionReference: result.diningSessionReference,
            previousHostParticipantReference: result.previousHostParticipantReference,
            hostParticipantReference: result.hostParticipantReference,
            sessionVersion: result.sessionVersion,
            transferredAt: result.transferredAt,
          });
        })
        .catch(() => denied(response));
    },
  );

  router.post(
    "/dining/sessions/host-selection",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.diningHostSelection) {
        response.status(503).json({ error: "dining_host_selection_unavailable" });
        return;
      }
      void options
        .diningHostSelection({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          const reference =
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
          const instant = (value: string) =>
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString() === value;
          if (
            !result ||
            !reference.test(result.diningSessionReference) ||
            !Number.isSafeInteger(result.sessionVersion) ||
            result.sessionVersion < 1 ||
            result.sessionVersion >= 2147483647 ||
            !["Active", "Closing"].includes(result.phase) ||
            (result.hostParticipantReference !== null &&
              !reference.test(result.hostParticipantReference)) ||
            !instant(result.observedAt) ||
            !Array.isArray(result.participants) ||
            result.participants.length > 100
          ) {
            denied(response);
            return;
          }
          const seen = new Set<string>();
          for (const p of result.participants) {
            if (
              !p ||
              !reference.test(p.participantReference) ||
              !instant(p.joinedAt) ||
              p.joinedAt > result.observedAt ||
              p.isHost !== (p.participantReference === result.hostParticipantReference) ||
              seen.has(p.participantReference)
            ) {
              denied(response);
              return;
            }
            seen.add(p.participantReference);
          }
          response.json({
            diningSessionReference: result.diningSessionReference,
            sessionVersion: result.sessionVersion,
            phase: result.phase,
            hostParticipantReference: result.hostParticipantReference,
            observedAt: result.observedAt,
            participants: result.participants.map((p) => ({
              participantReference: p.participantReference,
              joinedAt: p.joinedAt,
              isHost: p.isHost,
            })),
          });
        })
        .catch(() => denied(response));
    },
  );

  router.post("/dining/sessions/start", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningSessionStart) {
      response.status(503).json({ error: "dining_session_start_unavailable" });
      return;
    }
    void options
      .diningSessionStart({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
        if (
          !result ||
          !["Issued", "AlreadyApplied"].includes(result.status) ||
          !reference.test(result.diningSessionReference) ||
          !reference.test(result.tableReference) ||
          !Number.isSafeInteger(result.sessionVersion) ||
          result.sessionVersion < 1 ||
          !Number.isSafeInteger(result.tableAssignmentVersion) ||
          result.tableAssignmentVersion < 1 ||
          !["Invitation", "HumanCode"].includes(result.joinKind) ||
          (result.status === "Issued" &&
            (typeof result.joinCredential !== "string" ||
              !(result.joinKind === "HumanCode" ? /^[0-9]{6}$/u : /^[A-Za-z0-9_-]{22}$/u).test(
                result.joinCredential,
              )))
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          diningSessionReference: result.diningSessionReference,
          sessionVersion: result.sessionVersion,
          tableReference: result.tableReference,
          tableAssignmentVersion: result.tableAssignmentVersion,
          joinKind: result.joinKind,
          ...(result.status === "Issued" ? { joinCredential: result.joinCredential } : {}),
        });
      })
      .catch(() => denied(response));
  });

  router.post("/dining/tables", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningTables) {
      response.status(503).json({ error: "dining_tables_unavailable" });
      return;
    }
    void options
      .diningTables({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch(() => denied(response));
  });

  // WP-2423 Q28 DEC-DINING-STAFF-CALL: how many guests wait for staff, and answering one call.
  router.post("/dining/staff-calls/count", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningStaffCallCount) {
      response.status(503).json({ error: "dining_staff_calls_unavailable" });
      return;
    }
    void options
      .diningStaffCallCount({ sessionCookie, csrf })
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch(() => denied(response));
  });
  router.post("/dining/staff-calls/answer", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningStaffCallAnswer) {
      response.status(503).json({ error: "dining_staff_calls_unavailable" });
      return;
    }
    void options
      .diningStaffCallAnswer({ sessionCookie, csrf, command: request.body })
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch(() => denied(response));
  });

  // WP-2423 DEC-DINE-IN-PAY-LATER: the Store's dine-in payment timing (Owner, Store Manager).
  router.post("/dining/payment-timing", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningPaymentTimingRead) {
      response.status(503).json({ error: "dining_payment_timing_unavailable" });
      return;
    }
    void options
      .diningPaymentTimingRead({ sessionCookie, csrf })
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch(() => denied(response));
  });
  router.post("/dining/payment-timing/change", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningPaymentTimingChange) {
      response.status(503).json({ error: "dining_payment_timing_unavailable" });
      return;
    }
    void options
      .diningPaymentTimingChange({ sessionCookie, csrf, command: request.body })
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch(() => denied(response));
  });

  // WP-2423 DEC-DINE-IN-PAY-LATER: a pay-later table's bill, and its one payment (card machine or
  // cash) recorded at checkout. Refusals keep their meaning for the page (409 changed/owed, 422 cash
  // short); a missing permission reads as denied.
  const checkoutFailure = (response: Response, error: unknown) => {
    const code = error instanceof DiningTableCheckoutError ? error.code : null;
    if (code === null || code === "TABLE_CHECKOUT_PERMISSION_DENIED") {
      denied(response);
      return;
    }
    const status =
      code === "TABLE_CHECKOUT_INPUT_INVALID"
        ? 400
        : code === "TABLE_CHECKOUT_TENDER_SHORT"
          ? 422
          : code === "TABLE_CHECKOUT_UNAVAILABLE"
            ? 503
            : 409;
    response
      .status(status)
      .set("Cache-Control", NO_STORE)
      .json({ error: code.replace(/^TABLE_CHECKOUT_/u, "").toLowerCase() });
  };
  router.post("/dining/table-bill", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningTableBill) {
      response.status(503).json({ error: "dining_table_bill_unavailable" });
      return;
    }
    void options
      .diningTableBill({ sessionCookie, csrf, query: request.body })
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch((error: unknown) => checkoutFailure(response, error));
  });
  router.post("/dining/table-settle", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningTableSettle) {
      response.status(503).json({ error: "dining_table_settle_unavailable" });
      return;
    }
    void options
      .diningTableSettle({ sessionCookie, csrf, command: request.body })
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch((error: unknown) => checkoutFailure(response, error));
  });

  router.post("/dining/tables/availability", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningTableCommand) {
      response.status(503).json({ error: "dining_table_command_unavailable" });
      return;
    }
    void options
      .diningTableCommand({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
        if (
          !result ||
          !["Applied", "AlreadyApplied"].includes(result.status) ||
          !reference.test(result.tableReference) ||
          !["Available", "TemporarilyBlocked"].includes(result.operationalState) ||
          !Number.isSafeInteger(result.aggregateVersion) ||
          result.aggregateVersion < 1
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          tableReference: result.tableReference,
          operationalState: result.operationalState,
          aggregateVersion: result.aggregateVersion,
        });
      })
      .catch(() => denied(response));
  });

  // WP-2423 Q11: table QR codes. Unknown failures stay denied; a changed table answers 409 so the
  // page refreshes instead of telling staff they lack permission.
  const tableQrRoute = (
    path: string,
    run: (
      port: NonNullable<MerchantBffRouterOptions["diningTableQr"]>,
      input: { sessionCookie: string; csrf: string; body: unknown },
    ) => Promise<unknown>,
  ) =>
    router.post(path, sameOriginMutation(options), (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      response.setHeader("Cache-Control", "no-store");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.diningTableQr) {
        response.status(503).json({ error: "dining_table_qr_unavailable" });
        return;
      }
      void run(options.diningTableQr, { sessionCookie, csrf, body: request.body })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === "TABLE_QR_CONFLICT")
            response.status(409).json({ error: "dining_table_qr_changed" });
          else denied(response);
        });
    });
  tableQrRoute("/dining/table-qr", (port, input) =>
    port.list({ sessionCookie: input.sessionCookie, csrf: input.csrf, query: input.body }),
  );
  tableQrRoute("/dining/table-qr/command", (port, input) =>
    port.command({ sessionCookie: input.sessionCookie, csrf: input.csrf, command: input.body }),
  );
  tableQrRoute("/dining/table-qr/sheet", (port, input) =>
    port.sheet({ sessionCookie: input.sessionCookie, csrf: input.csrf, query: input.body }),
  );

  router.post("/dining/order-progress", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningOrderProgress) {
      response.status(503).json({ error: "dining_order_progress_unavailable" });
      return;
    }
    void options
      .diningOrderProgress({ sessionCookie, csrf, query: request.body })
      .then((current) => {
        if (!current) {
          response.status(404).json({ error: "dining_order_progress_unavailable" });
          return;
        }
        response.json({
          orderReference: current.orderReference,
          tableLabel: current.tableLabel,
          diningSessionReference: current.diningSessionReference,
          sessionPhase: current.sessionPhase,
          closureStatus: current.closureStatus,
          closureVersion: current.closureVersion,
          currentOrderVersion: current.currentOrderVersion,
          sessionVersion: current.sessionVersion,
          tableAssignmentVersion: current.tableAssignmentVersion,
          orderVersion: current.orderVersion,
          phase: current.phase,
          observedAt: current.observedAt,
          items: current.items.map((item) => ({
            orderItemReference: item.orderItemReference,
            orderBatchReference: item.orderBatchReference,
            displayName: item.displayName,
            batchSequence: item.batchSequence,
            itemOrdinal: item.itemOrdinal,
            phase: item.phase,
            orderedQuantity: item.orderedQuantity,
            deliveredQuantity: item.deliveredQuantity,
            remainingQuantity: item.remainingQuantity,
            itemServiceVersion: item.itemServiceVersion,
            // WP-2423 (2026-10-18): portions the kitchen is making again.
            remakingQuantity: item.remakingQuantity,
            // WP-2423 (v15 2026-10-16): options and the customer's note, so identical lines
            // ("Cup 3") can be told apart when serving. Absent when they could not be read.
            ...("options" in item
              ? {
                  options: item.options.map((option) => ({
                    name: option.name,
                    quantity: option.quantity,
                  })),
                  customerNote: item.customerNote,
                }
              : {}),
          })),
        });
      })
      .catch(() => denied(response));
  });

  // DEC-TABLE-CLOSE-GUESTS-LEFT: what closing a table whose guests left resolves and refunds.
  router.post("/dining/table-close-plan", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningTableClosePlan) {
      response.status(503).json({ error: "dining_table_close_plan_unavailable" });
      return;
    }
    void options
      .diningTableClosePlan({ sessionCookie, csrf, query: request.body })
      .then((plan) => {
        if (!plan) {
          response.status(404).json({ error: "dining_table_close_plan_not_found" });
          return;
        }
        response.json({
          orderReference: plan.orderReference,
          diningSessionReference: plan.diningSessionReference,
          orderVersion: plan.orderVersion,
          observedAt: plan.observedAt,
          rounds: plan.rounds.map((round) => ({
            orderBatchReference: round.orderBatchReference,
            sequence: round.sequence,
            state: round.state,
            openItemCount: round.openItemCount,
            startedItemCount: round.startedItemCount,
            readyItemCount: round.readyItemCount,
            cancellableItemReferences: round.cancellableItemReferences,
            refund: round.refund,
            cancelsAt: round.cancelsAt,
          })),
          totals: plan.totals,
          closeBlockers: plan.closeBlockers,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "DINING_TABLE_CLOSE_PLAN_PERMISSION_DENIED")
          denied(response);
        else response.status(503).json({ error: "dining_table_close_plan_unavailable" });
      });
  });

  router.post("/dining/serve", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningServe) {
      response.status(503).json({ error: "dining_serve_unavailable" });
      return;
    }
    void options
      .diningServe({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          itemServiceVersion: result.itemServiceVersion,
        }),
      )
      .catch(() => denied(response));
  });

  // WP-2423: "Serve all ready items" for a round or a table. 200 reports every line (served,
  // already served elsewhere, changed, failed); 503 means the outcome is unknown and the same
  // request (same operation reference) may be retried safely.
  router.post("/dining/serve-ready", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningServeReady) {
      response.status(503).json({ error: "dining_serve_ready_unavailable" });
      return;
    }
    void options
      .diningServeReady({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          operationReference: result.operationReference,
          served: result.served,
          alreadyServed: result.alreadyServed,
          changed: result.changed,
          failed: result.failed,
          lines: result.lines.map((line) => ({
            orderItemReference: line.orderItemReference,
            outcome: line.outcome,
          })),
        }),
      )
      .catch((error: unknown) => {
        if (error instanceof DiningServeReadyError && error.code === "Invalid")
          response.status(400).json({ error: "dining_serve_ready_invalid" });
        else if (error instanceof DiningServeReadyError && error.code === "NotFound")
          response.status(404).json({ error: "dining_serve_ready_not_found" });
        else if (error instanceof DiningServeReadyError) denied(response);
        else response.status(503).json({ error: "dining_serve_ready_unavailable" });
      });
  });

  router.post("/dining/item-service", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningItemService) {
      response.status(503).json({ error: "dining_item_service_unavailable" });
      return;
    }
    void options
      .diningItemService({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          itemServiceVersion: result.record.itemServiceVersion,
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/dining/closing", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.diningClosing) {
      response.status(503).json({ error: "dining_closing_unavailable" });
      return;
    }
    void options
      .diningClosing({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        if (
          !result ||
          !["Applied", "AlreadyApplied"].includes(result.status) ||
          !["Active", "Closing", "Closed"].includes(result.phase) ||
          !Number.isSafeInteger(result.sessionVersion) ||
          result.sessionVersion < 1
        ) {
          denied(response);
          return;
        }
        response.json({
          status: result.status,
          phase: result.phase,
          sessionVersion: result.sessionVersion,
        });
      })
      .catch((error: unknown) => {
        // WP-2423 (B759): a table that cannot close yet is a 409, never a permission message.
        const code =
          error instanceof DiningClosingError || error instanceof DiningCheckoutAlreadyPaidError
            ? error.code
            : null;
        const [status, body] =
          code === "DINING_CHECKOUT_ALREADY_PAID"
            ? ([409, "table_already_paid"] as const)
            : code === "DINING_CLOSING_PERMISSION_DENIED"
              ? ([403, "dining_closing_permission_denied"] as const)
              : code === "DINING_CLOSING_VERSION_CONFLICT" ||
                  code === "DINING_CLOSING_PHASE_CONFLICT" ||
                  code === "DINING_CLOSING_IDEMPOTENCY_CONFLICT"
                ? ([409, "dining_session_changed"] as const)
                : code === "DINING_CLOSING_TASK_REQUIRED" ||
                    code === "DINING_CLOSING_BATCH_NOT_TERMINAL"
                  ? ([409, "dining_session_not_ready"] as const)
                  : ([503, "dining_closing_unavailable"] as const);
        response.status(status).set("Cache-Control", NO_STORE).json({ error: body });
      });
  });
}
