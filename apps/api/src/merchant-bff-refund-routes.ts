/** Merchant BFF routes: refund approvals, requests, dispatch and unmatched capture refunds. Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import { MerchantRefundApprovalError } from "./merchant-ordinary-refund-approval.js";
import {
  cookie,
  denied,
  exactHeader,
  NO_STORE,
  rawHeaderValues,
  refundReadFailure,
  safeRead,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import { UnmatchedCaptureRefundError } from "@rms/payment";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

/** WP-2423 Q5: why an approval or decline was refused, without internal detail. */
function refundDecisionFailure(response: express.Response, error: MerchantRefundApprovalError) {
  // A role refusal is not a session problem: the browser says who may decide, not "sign in".
  if (error.code === "Denied")
    response.status(403).set("Cache-Control", NO_STORE).json({ error: "refund_role_required" });
  else if (error.code === "RequesterNotEligible")
    response.status(409).json({ error: "requester_not_eligible" });
  else if (error.code === "SamePerson") response.status(422).json({ error: "same_person" });
  // WP-2423 Q19: self-approval asked for, but another person now holds refund approval.
  else if (error.code === "SoleOperatorNotInEffect")
    response.status(409).json({ error: "sole_operator_not_in_effect" });
  else if (error.code === "NeedsReverification")
    response.status(409).json({ error: "needs_reverification", party: error.party });
  else if (error.code === "AlreadyPrepared")
    response.status(409).json({ error: "refund_already_prepared" });
  else if (error.code === "AlreadyDeclined")
    response.status(409).json({ error: "refund_already_declined" });
  else response.status(409).json({ error: "refund_changed" });
}

export function installMerchantRefundRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  // WP-2423 P6: read, request and approve the full refund of an unmatched Provider capture.
  for (const step of ["status", "request", "approve"] as const)
    router.post(
      "/payments/unmatched-capture-refund/" + step,
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
        const command = options.unmatchedCaptureRefund;
        if (!command) {
          response.status(503).json({ error: "unmatched_capture_refund_unavailable" });
          return;
        }
        void (
          step === "status"
            ? command.read({ sessionCookie, csrf, query: request.body })
            : command[step]({ sessionCookie, csrf, command: request.body })
        )
          .then((result) => response.json(result))
          .catch((error: unknown) => {
            if (!(error instanceof UnmatchedCaptureRefundError)) {
              denied(response);
              return;
            }
            const status = {
              UNMATCHED_REFUND_INPUT_INVALID: 400,
              UNMATCHED_REFUND_PERMISSION_DENIED: 403,
              UNMATCHED_REFUND_NOT_FOUND: 404,
              UNMATCHED_REFUND_STATE_CONFLICT: 409,
              UNMATCHED_REFUND_SAME_APPROVER: 422,
              UNMATCHED_REFUND_UNAVAILABLE: 503,
            }[error.code];
            response.status(status).json({ error: error.code });
          });
      },
    );

  // WP-2423 Q5: refunds awaiting an Owner/Finance approval at the selected Store.
  router.get("/payments/refunds/approvals", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.ordinaryRefundApprovals) {
      response.status(503).json({ error: "refund_approvals_unavailable" });
      return;
    }
    // WP-2423 Q19: a read rerun on a transaction conflict; still conflicting is "retry later".
    const port = options.ordinaryRefundApprovals;
    void retryTransactionConflict(() => port({ sessionCookie }))
      .then((view) =>
        response.set("Cache-Control", NO_STORE).json({
          observedAt: view.observedAt,
          canApprove: view.canApprove,
          soleOperator: view.soleOperator,
          entries: view.entries.map((entry) => ({
            orderReference: entry.orderReference,
            orderNumber: entry.orderNumber,
            requestReference: entry.requestReference,
            paymentIntentReferences: entry.paymentIntentReferences,
            paymentMethod: entry.paymentMethod,
            currencyCode: entry.currencyCode,
            amountMinor: entry.amountMinor,
            reasonCode: entry.reasonCode,
            note: entry.note,
            escalationReasons: entry.escalationReasons,
            requestedAt: entry.requestedAt,
            requesterName: entry.requesterName,
            requestedByYou: entry.requestedByYou,
            requesterVerifiedUntil: entry.requesterVerifiedUntil,
            state: entry.state,
            approvalReference: entry.approvalReference,
            approvedAt: entry.approvedAt,
            approverName: entry.approverName,
            canApprove: entry.canApprove,
            soleOperatorApproval: entry.soleOperatorApproval,
          })),
        }),
      )
      .catch((error: unknown) => refundReadFailure(response, error));
  });

  // WP-2423 Q5: approve an escalated refund in person; it is sent at once with the approval.
  router.post("/payments/refunds/approve", sameOriginMutation(options), (request, response) => {
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
    const command = options.ordinaryRefundApproval;
    if (!command) {
      response.status(503).json({ error: "refund_approval_unavailable" });
      return;
    }
    void command({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.status(202).json({
          status: result.status,
          approvalReference: result.approvalReference,
          replayed: result.replayed,
          payments: result.payments.map((payment) => ({
            paymentAttemptReference: payment.paymentAttemptReference,
            operationReference: payment.operationReference,
            state: payment.state,
          })),
        }),
      )
      .catch((error: unknown) => {
        if (!(error instanceof MerchantRefundApprovalError)) {
          denied(response);
          return;
        }
        refundDecisionFailure(response, error);
      });
  });

  // WP-2423 Q5: decline a refund nothing was prepared for; it stops counting toward the Order.
  router.post("/payments/refunds/decline", sameOriginMutation(options), (request, response) => {
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
    const command = options.ordinaryRefundDecline;
    if (!command) {
      response.status(503).json({ error: "refund_decline_unavailable" });
      return;
    }
    void command({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          declinedAt: result.declinedAt,
          replayed: result.replayed,
        }),
      )
      .catch((error: unknown) => {
        if (!(error instanceof MerchantRefundApprovalError)) {
          denied(response);
          return;
        }
        refundDecisionFailure(response, error);
      });
  });

  router.post("/payments/refunds/progress", sameOriginMutation(options), (request, response) => {
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
    if (!options.ordinaryRefundProgress) {
      response.status(503).json({ error: "refund_progress_unavailable" });
      return;
    }
    // WP-2423 Q19: a read rerun on a transaction conflict; still conflicting is "retry later".
    const port = options.ordinaryRefundProgress;
    void retryTransactionConflict(() => port({ sessionCookie, csrf, query: request.body }))
      .then((result) =>
        response.set("Cache-Control", NO_STORE).json({
          requestReference: result.requestReference,
          progress: result.progress,
          observedAt: result.observedAt,
        }),
      )
      .catch((error: unknown) => refundReadFailure(response, error));
  });

  router.post("/payments/refunds/status", sameOriginMutation(options), (request, response) => {
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
    if (!options.ordinaryRefundStatus) {
      response.status(503).json({ error: "refund_status_unavailable" });
      return;
    }
    // WP-2423 Q19: a read rerun on a transaction conflict; still conflicting is "retry later".
    const port = options.ordinaryRefundStatus;
    void retryTransactionConflict(() => port({ sessionCookie, csrf, query: request.body }))
      .then((result) =>
        response.json({
          orderReference: result.orderReference,
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          observedAt: result.observedAt,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          payments: result.payments.map((payment) => ({
            paymentAttemptReference: payment.paymentAttemptReference,
            paymentIntentReference: payment.paymentIntentReference,
            state: payment.state,
            // WP-2423 item 4: refunded on the Store's card machine (recorded) or online.
            method: payment.method,
            refundedOnCardMachineAt: payment.refundedOnCardMachineAt,
            // The reference on the machine's refund slip (not secret; never a card number).
            cardMachineSlipReference: payment.cardMachineSlipReference,
            executionOperationReference: payment.executionOperationReference,
            executionApprovalReference: payment.executionApprovalReference,
            amountMinor: payment.amountMinor,
            confirmedMinor: payment.confirmedMinor,
            pendingMinor: payment.pendingMinor,
          })),
        }),
      )
      .catch((error: unknown) => refundReadFailure(response, error));
  });

  router.post("/payments/refunds/context", sameOriginMutation(options), (request, response) => {
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
    if (!options.refundPaymentContext) {
      response.status(503).json({ error: "refund_payment_context_unavailable" });
      return;
    }
    // WP-2423 Q19: a read rerun on a transaction conflict; still conflicting is "retry later".
    const port = options.refundPaymentContext;
    void retryTransactionConflict(() => port({ sessionCookie, csrf, query: request.body }))
      .then((result) =>
        response.json({
          paymentIntentReference: result.paymentIntentReference,
          paymentAttemptReference: result.paymentAttemptReference,
          orderReference: result.orderReference,
          orderBatchReference: result.orderBatchReference,
          observedAt: result.observedAt,
          paymentState: result.paymentState,
          paymentMethod: result.paymentMethod,
          currencyCode: result.currencyCode,
          capturedAmountMinor: result.capturedAmountMinor,
          confirmedRefundMinor: result.confirmedRefundMinor,
          pendingRefundMinor: result.pendingRefundMinor,
          canRequest: result.canRequest,
        }),
      )
      .catch((error: unknown) => refundReadFailure(response, error));
  });

  router.post("/payments/refunds/items", sameOriginMutation(options), (request, response) => {
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
    if (!options.ordinaryRefundItems) {
      response.status(503).json({ error: "refund_items_unavailable" });
      return;
    }
    // WP-2423 Q19: a read rerun on a transaction conflict; still conflicting is "retry later".
    const port = options.ordinaryRefundItems;
    void retryTransactionConflict(() => port({ sessionCookie, csrf, query: request.body }))
      .then((result) =>
        response.json({
          orderReference: result.orderReference,
          orderNumber: result.orderNumber,
          canRequest: result.canRequest,
          claimVersion: result.claimVersion,
          recentRequests: result.recentRequests.map((entry) => ({
            requestReference: entry.requestReference,
            operationReference: entry.operationReference,
            claimVersion: entry.claimVersion,
            requestedAt: entry.requestedAt,
            reasonCode: entry.reasonCode,
            currencyCode: entry.currencyCode,
            amountMinor: entry.amountMinor,
            decline:
              entry.decline === null
                ? null
                : {
                    reasonCode: entry.decline.reasonCode,
                    declinedAt: entry.decline.declinedAt,
                    declinerName: entry.decline.declinerName,
                    declinedByYou: entry.decline.declinedByYou,
                  },
            progress: entry.progress,
            paymentMethod: entry.paymentMethod,
          })),
          items: result.items.map((item) => ({
            orderBatchReference: item.orderBatchReference,
            orderItemReference: item.orderItemReference,
            label: item.label,
            quantity: item.quantity,
            unclaimedQuantity: item.unclaimedQuantity,
            paymentCaptured: item.paymentCaptured,
            refundedByCancellation: item.refundedByCancellation,
            paymentIntentReference: item.paymentIntentReference,
            paymentMethod: item.paymentMethod,
          })),
        }),
      )
      .catch((error: unknown) => refundReadFailure(response, error));
  });

  router.post("/payments/refunds/preview", sameOriginMutation(options), (request, response) => {
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
    if (!options.ordinaryRefundPreview) {
      response.status(503).json({ error: "refund_preview_unavailable" });
      return;
    }
    void options
      .ordinaryRefundPreview({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({
          status: result.status,
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          claimVersion: result.claimVersion,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          paymentAttemptReferences: result.paymentAttemptReferences,
          approvalRequired: result.approvalRequired,
          escalationReasons: result.escalationReasons,
          approveAlone: result.approveAlone,
          components: {
            netAmountMinor: result.components.netAmountMinor,
            taxAmountMinor: result.components.taxAmountMinor,
            tipAmountMinor: result.components.tipAmountMinor,
            serviceChargeAmountMinor: result.components.serviceChargeAmountMinor,
            serviceChargeTaxAmountMinor: result.components.serviceChargeTaxAmountMinor,
          },
        }),
      )
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/request", sameOriginMutation(options), (request, response) => {
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
    if (!options.ordinaryRefundRequest) {
      response.status(503).json({ error: "refund_request_unavailable" });
      return;
    }
    void options
      .ordinaryRefundRequest({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        response.status(202).json({
          status: "RequestRecorded",
          requestReference: result.requestReference,
          operationReference: result.operationReference,
          claimVersion: result.claimVersion,
          currencyCode: result.currencyCode,
          amountMinor: result.amountMinor,
          paymentAttemptReferences: result.paymentAttemptReferences,
          approvalRequired: result.approvalRequired,
          escalationReasons: result.escalationReasons,
          approveAlone: result.approveAlone,
          replayed: result.status === "AlreadyCommitted",
        });
      })
      .catch(() => denied(response));
  });

  router.post("/payments/refunds/prepare", sameOriginMutation(options), (request, response) => {
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
    if (!options.ordinaryRefund) {
      response.status(503).json({ error: "refund_preparation_unavailable" });
      return;
    }
    void options
      .ordinaryRefund({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.status(202).json({
          status: "PreparationRecorded",
          operationReference: result.operationReference,
          replayed: result.status === "AlreadyCommitted",
        }),
      )
      .catch(() => denied(response));
  });

  for (const [path, capability, status] of [
    ["send", "ordinaryRefundSend", "DispatchRecorded"],
    ["reconcile", "ordinaryRefundReconciliation", "ReconciliationRecorded"],
  ] as const) {
    router.post("/payments/refunds/" + path, sameOriginMutation(options), (request, response) => {
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
      const execute = options[capability];
      if (!execute) {
        response.status(503).json({ error: "refund_execution_unavailable" });
        return;
      }
      void execute({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (path === "send") return response.status(202).json({ status });
          if (!("receipt" in result)) throw new Error("REFUND_RECEIPT_RESULT_INVALID");
          const receipt = result.receipt;
          return response.status(202).json({
            status,
            receipt: {
              status: receipt.status,
              version: receipt.version,
              kind: receipt.kind,
            },
          });
        })
        // A failure may follow committed dispatch/observation. Never tell the client
        // to discard its original identity or infer that nothing happened.
        .catch(() => response.status(503).json({ error: "refund_execution_unknown" }));
    });
  }
}
