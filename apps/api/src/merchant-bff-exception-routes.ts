/** Merchant BFF routes: order exceptions, follow-up and compensation reconciliation. Registered by createMerchantBffRouter (merchant-bff.ts). */
import {
  cookie,
  denied,
  exactHeader,
  rawHeaderValues,
  safeRead,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import { BrowserSessionError, parseCanonicalInstant, parseOpaqueUuidV7 } from "@bop/identity";
import { PaymentReconciliationError, ReconciliationFollowUpError } from "@rms/payment";
import type { Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantExceptionRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  router.get("/order-exceptions", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    // WP-2423: the only query is the cursor of an older page of resolved cases.
    const queryKeys = Object.keys(request.query);
    const resolvedBefore = request.query.resolvedBefore;
    if (
      request.method !== "GET" ||
      queryKeys.some((key) => key !== "resolvedBefore") ||
      (resolvedBefore !== undefined &&
        (typeof resolvedBefore !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            resolvedBefore,
          ))) ||
      request.body !== undefined ||
      sessionCookie === null ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.orderExceptions) {
      response.status(503).json({ error: "order_exceptions_unavailable" });
      return;
    }
    void options
      .orderExceptions(sessionCookie, {
        resolvedBefore: typeof resolvedBefore === "string" ? resolvedBefore : null,
      })
      .then((view) => {
        response.json({
          screenId: view.screenId,
          projectionName: view.projectionName,
          storeLabel: view.storeLabel,
          businessDate: view.businessDate,
          projectedAt: view.projectedAt,
          freshnessStatus: view.freshnessStatus,
          olderResolvedBefore: view.olderResolvedBefore,
          items: view.items.map((item) => ({
            exceptionReference: item.exceptionReference,
            orderReference: item.orderReference,
            orderNumber: item.orderNumber,
            kind: item.kind,
            severity: item.severity,
            status: item.status,
            providerState: item.providerState,
            compensationStatus: item.compensationStatus,
            sourceOwner: item.sourceOwner,
            createdAt: item.createdAt,
            dueAt: item.dueAt,
            ownerStatus: item.ownerStatus,
            sourceFinal: item.sourceFinal,
            // WP-2423 D3: what a payment reconciliation difference is about (the read's own DTO).
            ...(item.reconciliation === undefined ? {} : { reconciliation: item.reconciliation }),
          })),
        });
      })
      .catch(() => denied(response));
  });

  router.post(
    "/operations/compensations/query",
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
      if (!options.compensationQuery) {
        response.status(503).json({ error: "compensation_reconciliation_unavailable" });
        return;
      }
      void options
        .compensationQuery({ sessionCookie, csrf, query: request.body })
        .then((result) =>
          response.json({
            caseVersion: result.caseVersion,
            caseState: result.caseState,
            refund: {
              amountMinor: result.refund.amountMinor,
              currencyCode: result.refund.currencyCode,
              confirmedAt: result.refund.confirmedAt,
            },
            acknowledgmentRecorded: result.acknowledgmentRecorded,
          }),
        )
        .catch(() =>
          response.status(503).json({ error: "compensation_reconciliation_unavailable" }),
        );
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-assignees",
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
      if (!options.reconciliationAssigneeQuery) {
        response.status(503).json({ error: "reconciliation_assignees_unavailable" });
        return;
      }
      void options
        .reconciliationAssigneeQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (!Array.isArray(result.items) || result.items.length > 25)
            throw Error("RECONCILIATION_ASSIGNEES_INVALID");
          const seen = new Set<string>();
          const items = result.items.map((item) => {
            const actorReference = String(
              parseOpaqueUuidV7(item.actorReference, "ACTOR_REFERENCE_INVALID"),
            );
            if (
              seen.has(actorReference) ||
              typeof item.label !== "string" ||
              !/^([^\p{Cc}\p{Cf}]){1,80}$/u.test(item.label) ||
              item.label.trim() !== item.label ||
              item.label.includes("@")
            )
              throw Error("RECONCILIATION_ASSIGNEES_INVALID");
            seen.add(actorReference);
            return { actorReference, label: item.label };
          });
          const nextAfterActorReference =
            result.nextAfterActorReference === null
              ? null
              : String(
                  parseOpaqueUuidV7(result.nextAfterActorReference, "ACTOR_REFERENCE_INVALID"),
                );
          response.status(200).json({ items, nextAfterActorReference });
        })
        .catch((error) => {
          if (
            (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") ||
            (error instanceof ReconciliationFollowUpError &&
              error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED")
          ) {
            denied(response);
            return;
          }
          response.status(503).json({ error: "reconciliation_assignees_unavailable" });
        });
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-evidence",
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
      if (!options.reconciliationEvidenceQuery) {
        response.status(503).json({ error: "reconciliation_evidence_unavailable" });
        return;
      }
      void options
        .reconciliationEvidenceQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (result === null) {
            response.status(200).json({ evidence: null });
            return;
          }
          if (
            typeof result.amountMinor !== "string" ||
            !/^[1-9][0-9]{0,18}$/.test(result.amountMinor) ||
            BigInt(result.amountMinor) > 9223372036854775807n ||
            result.currencyCode !== "CAD" ||
            !["Test", "Live"].includes(result.environment) ||
            result.recordedReason !== "ProviderCaptureWithoutInternalOperation"
          )
            throw Error("RECONCILIATION_EVIDENCE_INVALID");
          const occurredAt = String(parseCanonicalInstant(result.occurredAt)),
            observedAt = String(parseCanonicalInstant(result.observedAt));
          if (occurredAt > observedAt) throw Error("RECONCILIATION_EVIDENCE_INVALID");
          response.status(200).json({
            evidence: {
              amountMinor: result.amountMinor,
              currencyCode: "CAD",
              environment: result.environment,
              occurredAt,
              observedAt,
              recordedReason: result.recordedReason,
            },
          });
        })
        .catch((error) => {
          if (
            (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") ||
            (error instanceof PaymentReconciliationError &&
              error.code === "PAYMENT_RECONCILIATION_PERMISSION_DENIED") ||
            (error instanceof ReconciliationFollowUpError &&
              error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED")
          ) {
            denied(response);
            return;
          }
          response.status(503).json({ error: "reconciliation_evidence_unavailable" });
        });
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up-query",
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
      if (!options.reconciliationFollowUpQuery) {
        response.status(503).json({ error: "reconciliation_follow_up_unavailable" });
        return;
      }
      void options
        .reconciliationFollowUpQuery({ sessionCookie, csrf, query: request.body })
        .then((result) => {
          if (
            !Number.isSafeInteger(result.version) ||
            result.version < 1 ||
            !["Open", "Acknowledged", "Assigned"].includes(result.followUpStatus) ||
            typeof result.acknowledged !== "boolean" ||
            typeof result.assigned !== "boolean" ||
            (result.followUpStatus === "Open" && (result.acknowledged || result.assigned)) ||
            (result.followUpStatus === "Acknowledged" &&
              (!result.acknowledged || result.assigned)) ||
            (result.followUpStatus === "Assigned" && !result.assigned)
          )
            throw Error("RECONCILIATION_FOLLOW_UP_RESULT_INVALID");
          response.status(200).json({
            version: result.version,
            followUpStatus: result.followUpStatus,
            acknowledged: result.acknowledged,
            assigned: result.assigned,
            updatedAt: String(parseCanonicalInstant(result.updatedAt)),
          });
        })
        .catch(() => response.status(503).json({ error: "reconciliation_follow_up_unavailable" }));
    },
  );

  router.post(
    "/operations/order-exceptions/follow-up",
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
      if (!options.reconciliationFollowUp) {
        response.status(503).json({ error: "reconciliation_follow_up_unavailable" });
        return;
      }
      void options
        .reconciliationFollowUp({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (
            !["Created", "Duplicate"].includes(result.status) ||
            !Number.isSafeInteger(result.version) ||
            result.version < 2 ||
            !["Acknowledged", "Assigned"].includes(result.followUpStatus)
          )
            throw Error("RECONCILIATION_FOLLOW_UP_RESULT_INVALID");
          return response.status(202).json({
            status: "FollowUpRecorded",
            replayed: result.status === "Duplicate",
            version: result.version,
            followUpStatus: result.followUpStatus,
            updatedAt: String(parseCanonicalInstant(result.updatedAt)),
          });
        })
        .catch((error) => {
          if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") {
            denied(response);
            return;
          }
          if (error instanceof ReconciliationFollowUpError) {
            if (error.code === "RECONCILIATION_FOLLOW_UP_CONFLICT") {
              response.status(409).json({ error: "reconciliation_follow_up_conflict" });
              return;
            }
            if (error.code === "RECONCILIATION_FOLLOW_UP_PERMISSION_DENIED") {
              denied(response);
              return;
            }
            if (error.code === "RECONCILIATION_FOLLOW_UP_INVALID") {
              response.status(400).json({ error: "reconciliation_follow_up_invalid" });
              return;
            }
          }
          response.status(503).json({ error: "reconciliation_follow_up_unknown" });
        });
    },
  );

  router.post(
    "/operations/compensations/reconcile",
    sameOriginMutation(options),
    (request, response) => {
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
      if (!options.compensationReconciliation) {
        response.status(503).json({ error: "compensation_reconciliation_unavailable" });
        return;
      }
      void options
        .compensationReconciliation({ sessionCookie, csrf, command: request.body })
        .then((result) => {
          if (result.status !== "Created" && result.status !== "Duplicate")
            throw new Error("COMPENSATION_RECONCILIATION_RESULT_INVALID");
          return response.status(202).json({
            status: "ReconciliationRecorded",
            replayed: result.status === "Duplicate",
            reconciledAt: String(parseCanonicalInstant(result.reconciledAt)),
          });
        })
        .catch(() => response.status(503).json({ error: "compensation_reconciliation_unknown" }));
    },
  );
}
