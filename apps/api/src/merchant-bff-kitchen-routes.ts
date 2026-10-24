/** Merchant BFF routes: kitchen board, work, rework, stale tickets and release. Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import { cookie, denied, exactHeader, NO_STORE, sameOriginMutation } from "./merchant-bff-http.js";
import {
  KitchenQueueProjectionError,
  KitchenReworkError,
  KitchenStaleTicketError,
  KitchenWorkLifecycleError,
} from "@rms/kitchen";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

/**
 * WP-2423 (v15 2026-10-16): a kitchen step that kept meeting a database conflict (a lock wait or
 * deadlock with the queue rebuild or another step, after its own reruns), a busy connection pool or
 * a statement timeout is "busy, try again" (503 with Retry-After), never a permission refusal. Returns false otherwise.
 */
function kitchenDatabaseRetryLater(response: express.Response, error: unknown): boolean {
  const code =
    error !== null && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code")?.value
      : undefined;
  const sqlState =
    error !== null && typeof error === "object"
      ? (
          Object.getOwnPropertyDescriptor(error, "diagnostic")?.value as {
            sqlState?: unknown;
          } | null
        )?.sqlState
      : undefined;
  // A statement cancelled by its timeout or a lost connection under load is transient too; a
  // failure such as a refused row (missing grant) stays a refusal.
  if (
    code !== "TENANT_DATABASE_TRANSACTION_CONFLICT" &&
    code !== "TENANT_DATABASE_ACQUIRE_FAILED" &&
    !(
      code === "TENANT_DATABASE_TRANSACTION_FAILED" &&
      typeof sqlState === "string" &&
      (sqlState === "57014" || sqlState.startsWith("08"))
    )
  )
    return false;
  response
    .status(503)
    .set("Cache-Control", NO_STORE)
    .set("Retry-After", "1")
    .json({ error: "retry_later" });
  return true;
}

export function installMerchantKitchenRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  router.post("/kitchen/query", sameOriginMutation(options), (request, response) => {
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
    if (!options.kitchenQuery) {
      response.status(503).json({ error: "kitchen_queue_unavailable" });
      return;
    }
    void options
      .kitchenQuery({ sessionCookie, csrf, query: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof KitchenQueueProjectionError)) {
          denied(response);
          return;
        }
        const status = {
          KITCHEN_QUEUE_INPUT_INVALID: 400,
          KITCHEN_QUEUE_PERMISSION_DENIED: 403,
          KITCHEN_QUEUE_NOT_FOUND: 404,
          KITCHEN_QUEUE_VERSION_CONFLICT: 409,
          KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/kitchen/work", sameOriginMutation(options), (request, response) => {
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
    if (!options.kitchenCommand) {
      response.status(503).json({ error: "kitchen_work_unavailable" });
      return;
    }
    void options
      .kitchenCommand({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof KitchenWorkLifecycleError)) {
          if (!kitchenDatabaseRetryLater(response, error)) denied(response);
          return;
        }
        const status = {
          KITCHEN_WORK_INPUT_INVALID: 400,
          KITCHEN_WORK_PERMISSION_DENIED: 403,
          KITCHEN_WORK_NOT_FOUND: 404,
          KITCHEN_WORK_VERSION_CONFLICT: 409,
          KITCHEN_WORK_PRECONDITION_FAILED: 422,
          KITCHEN_WORK_DEPENDENCY_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  // WP-2423 Q26 (Handoff Section 26.6): Kitchen remakes. Errors carry a code only.
  const kitchenReworkFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof KitchenReworkError)) {
      if (!kitchenDatabaseRetryLater(response, error)) denied(response);
      return;
    }
    const status = {
      KITCHEN_REWORK_INPUT_INVALID: 400,
      KITCHEN_REWORK_PERMISSION_DENIED: 403,
      KITCHEN_REWORK_NOT_FOUND: 404,
      KITCHEN_REWORK_CONFLICT: 409,
      KITCHEN_REWORK_PRECONDITION_FAILED: 422,
      KITCHEN_REWORK_WINDOW_CLOSED: 422,
      KITCHEN_REWORK_UNAVAILABLE: 503,
    }[error.code];
    response.status(status).json({ error: error.code });
  };
  router.post("/kitchen/rework/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as Record<string, unknown> | undefined;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.kitchenRework) {
      response.status(503).json({ error: "kitchen_rework_unavailable" });
      return;
    }
    void options.kitchenRework
      .query({ sessionCookie, csrf })
      .then((result) => response.json(result))
      .catch((error: unknown) => kitchenReworkFailure(response, error));
  });
  router.post("/kitchen/rework/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.kitchenRework) {
      response.status(503).json({ error: "kitchen_rework_unavailable" });
      return;
    }
    void options.kitchenRework
      .command({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => kitchenReworkFailure(response, error));
  });

  // DEC-KITCHEN-STALE-TICKETS: close an earlier business day's kitchen ticket. Errors carry a code only.
  router.post("/kitchen/stale-ticket/close", sameOriginMutation(options), (request, response) => {
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
    if (!options.kitchenStaleClose) {
      response.status(503).json({ error: "kitchen_stale_close_unavailable" });
      return;
    }
    void options
      .kitchenStaleClose({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof KitchenStaleTicketError)) {
          if (!kitchenDatabaseRetryLater(response, error)) denied(response);
          return;
        }
        const status = {
          KITCHEN_STALE_TICKET_INPUT_INVALID: 400,
          KITCHEN_STALE_TICKET_PERMISSION_DENIED: 403,
          KITCHEN_STALE_TICKET_NOT_FOUND: 404,
          KITCHEN_STALE_TICKET_CONFLICT: 409,
          KITCHEN_STALE_TICKET_NOT_EARLIER_DAY: 422,
          KITCHEN_STALE_TICKET_NOTHING_OPEN: 422,
          KITCHEN_STALE_TICKET_UNAVAILABLE: 503,
        }[error.code];
        response.status(status).json({ error: error.code });
      });
  });

  router.post("/kitchen/release", sameOriginMutation(options), (request, response) => {
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
    if (!options.kitchenRelease) {
      response.status(503).json({ error: "kitchen_release_unavailable" });
      return;
    }
    void options
      .kitchenRelease({ sessionCookie, csrf })
      .then(() => response.status(204).end())
      .catch(() => denied(response));
  });
}
