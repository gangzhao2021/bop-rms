/** Merchant BFF routes: pickup queue, handoff, identity check, not collected and proof. Registered by createMerchantBffRouter (merchant-bff.ts). */
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { FulfillmentReadinessError, PickupHandoffError, PickupProofError } from "@rms/fulfillment";
import {
  cookie,
  denied,
  exactHeader,
  NO_STORE,
  refundReadFailure,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import type { Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantPickupRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  router.post("/pickup/query", sameOriginMutation(options), (request, response) => {
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
    if (!options.pickupQuery) {
      response.status(503).json({ error: "pickup_queue_unavailable" });
      return;
    }
    const pickupQuery = options.pickupQuery;
    // A read: a deadlock with a concurrent Orders read is rerun, never shown as a refusal.
    void retryTransactionConflict(() => pickupQuery({ sessionCookie, csrf, query: request.body }))
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof FulfillmentReadinessError)) {
          refundReadFailure(response, error);
          return;
        }
        const status = {
          FULFILLMENT_READINESS_INPUT_INVALID: 400,
          FULFILLMENT_READINESS_PERMISSION_DENIED: 403,
          FULFILLMENT_READINESS_NOT_FOUND: 404,
          FULFILLMENT_READINESS_CONFLICT: 409,
          FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/pickup/handoff", sameOriginMutation(options), (request, response) => {
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
    if (!options.pickupHandoff) {
      response.status(503).json({ error: "pickup_handoff_unavailable" });
      return;
    }
    void options
      .pickupHandoff({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PickupHandoffError)) {
          denied(response);
          return;
        }
        const status = {
          PICKUP_HANDOFF_INPUT_INVALID: 400,
          PICKUP_HANDOFF_PERMISSION_DENIED: 403,
          PICKUP_HANDOFF_NOT_READY: 422,
          PICKUP_HANDOFF_VERIFICATION_FAILED: 422,
          PICKUP_HANDOFF_ALREADY_COMPLETED: 409,
          PICKUP_HANDOFF_VERSION_CONFLICT: 409,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  // WP-2423: what staff compare when checking a pickup customer in person (no usable code).
  router.post("/pickup/identity-check", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    // Personal details: never cached by the browser or a proxy.
    response.setHeader("Cache-Control", NO_STORE);
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.pickupIdentityCheck) {
      response.status(503).json({ error: "pickup_identity_check_unavailable" });
      return;
    }
    void options
      .pickupIdentityCheck({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PickupHandoffError)) {
          denied(response);
          return;
        }
        const status = {
          PICKUP_HANDOFF_INPUT_INVALID: 400,
          PICKUP_HANDOFF_PERMISSION_DENIED: 403,
          PICKUP_HANDOFF_NOT_READY: 422,
          PICKUP_HANDOFF_VERIFICATION_FAILED: 422,
          PICKUP_HANDOFF_ALREADY_COMPLETED: 409,
          PICKUP_HANDOFF_VERSION_CONFLICT: 409,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  // WP-2423: close a ready pickup nobody collected after the pickup hold (no refund here).
  router.post("/pickup/not-collected", sameOriginMutation(options), (request, response) => {
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
    if (!options.pickupNotCollected) {
      response.status(503).json({ error: "pickup_not_collected_unavailable" });
      return;
    }
    void options
      .pickupNotCollected({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PickupHandoffError)) {
          denied(response);
          return;
        }
        const status = {
          PICKUP_HANDOFF_INPUT_INVALID: 400,
          PICKUP_HANDOFF_PERMISSION_DENIED: 403,
          PICKUP_HANDOFF_NOT_READY: 422,
          PICKUP_HANDOFF_VERIFICATION_FAILED: 422,
          PICKUP_HANDOFF_ALREADY_COMPLETED: 409,
          PICKUP_HANDOFF_VERSION_CONFLICT: 409,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/pickup/proof", sameOriginMutation(options), (request, response) => {
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
    if (!options.pickupProof) {
      response.status(503).json({ error: "pickup_proof_unavailable" });
      return;
    }
    void options
      .pickupProof({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PickupHandoffError) && !(error instanceof PickupProofError)) {
          denied(response);
          return;
        }
        const status = {
          PICKUP_PROOF_INPUT_INVALID: 400,
          PICKUP_PROOF_NOT_READY: 422,
          PICKUP_PROOF_VERSION_CONFLICT: 409,
          PICKUP_PROOF_UNAVAILABLE: 422,
          // WP-2423 (DEC-PICKUP-COUNTER-CODE): a wrong code, and code checks locked after five.
          PICKUP_PROOF_REJECTED: 422,
          PICKUP_PROOF_LOCKED: 423,
          PICKUP_HANDOFF_INPUT_INVALID: 400,
          PICKUP_HANDOFF_PERMISSION_DENIED: 403,
          PICKUP_HANDOFF_NOT_READY: 422,
          PICKUP_HANDOFF_VERIFICATION_FAILED: 422,
          PICKUP_HANDOFF_ALREADY_COMPLETED: 409,
          PICKUP_HANDOFF_VERSION_CONFLICT: 409,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });
}
