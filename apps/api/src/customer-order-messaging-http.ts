import {
  OrderRecoveryError,
  serializeGuestSessionCookie,
  type GuestRawCredential,
} from "@bop/identity";
import express, { type RequestHandler, type Response } from "express";

/**
 * DEC-PILOT-NOTIFICATIONS (2026-10-20): HTTP surface for customer order messages.
 *
 * - `GET  /api/v1/customer/order-messages`: which channels can actually send now. The checkout only
 *   offers a contact purpose that will really be used (AGENTS.md customer respect).
 * - `POST /api/v1/customer/order-recovery`: IDR-0031 one-time link consume. The token arrives only in
 *   the JSON body (the page read it from the URL fragment); success re-keys the Order's own Guest
 *   Session and returns only the clean order path. Every failure is the same answer.
 * - `POST /api/v1/provider/ses-feedback`: the SNS HTTPS subscription for SES bounce/complaint
 *   (IDR-0027 r1). SNS posts `text/plain`; the body is authenticated before anything is stored.
 *
 * None of these log or echo the body, token, cookie or address.
 */
export const customerOrderMessagingOptionsRoute = "/api/v1/customer/order-messages";
export const customerOrderRecoveryRoute = "/api/v1/customer/order-recovery";
export const notificationFeedbackRoute = "/api/v1/provider/ses-feedback";

const token = /^[A-Za-z0-9_-]{43}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function privateHeaders(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}

export function createCustomerOrderMessagingOptionsHandler(options: {
  readonly availability: () => { readonly sms: boolean; readonly email: boolean };
}): RequestHandler {
  return (request, response) => {
    privateHeaders(response);
    if (Object.keys(request.query).length !== 0) {
      response.status(400).json({ schemaVersion: 1, error: { code: "request_invalid" } });
      return;
    }
    let ready = { sms: false, email: false };
    try {
      const value = options.availability();
      ready = { sms: value.sms === true, email: value.email === true };
    } catch {
      // Unknown means nothing is offered.
    }
    response.status(200).json({ schemaVersion: 1, orderMessages: ready });
  };
}

export type CustomerOrderRecoveryPort = (input: {
  readonly token: string;
  readonly peerAddress: string;
}) => Promise<{ readonly orderReference: string; readonly sessionCredential: GuestRawCredential }>;

export function createCustomerOrderRecoveryHandler(options: {
  readonly allowedOrigin: string;
  readonly port?: CustomerOrderRecoveryPort;
}): RequestHandler {
  const origin = new URL(options.allowedOrigin).origin;
  const uniform = (response: Response, status: 400 | 429 | 503, retryAfter?: number) => {
    privateHeaders(response);
    if (retryAfter !== undefined) response.setHeader("Retry-After", String(retryAfter));
    response.status(status).json({
      schemaVersion: 1,
      error: {
        code:
          status === 429
            ? "order_link_rate_limited"
            : status === 503
              ? "order_link_service_unavailable"
              : "order_link_unavailable",
      },
    });
  };
  return async (request, response) => {
    let value: string;
    try {
      const body: unknown = request.body;
      if (
        request.get("origin") !== origin ||
        request.get("sec-fetch-site") !== "same-origin" ||
        !request.is("application/json") ||
        Object.keys(request.query).length !== 0 ||
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof (body as Record<string, unknown>).token !== "string" ||
        !token.test((body as Record<string, string>).token as string)
      )
        throw new Error();
      value = (body as Record<string, string>).token as string;
    } catch {
      uniform(response, 400);
      return;
    }
    if (options.port === undefined) {
      uniform(response, 503, 30);
      return;
    }
    try {
      const result = await options.port({
        token: value,
        peerAddress: request.socket.remoteAddress ?? "",
      });
      if (!reference.test(result.orderReference)) throw new Error();
      privateHeaders(response);
      response.setHeader("Set-Cookie", serializeGuestSessionCookie(result.sessionCredential));
      response
        .status(200)
        .json({ schemaVersion: 1, redirectPath: `/orders/${result.orderReference}` });
    } catch (error) {
      if (error instanceof OrderRecoveryError && error.code === "ORDER_RECOVERY_RATE_LIMITED")
        uniform(response, 429, error.retryAfterSeconds ?? 3600);
      else if (error instanceof OrderRecoveryError) uniform(response, 400);
      else uniform(response, 503, 30);
    }
  };
}

export interface NotificationFeedbackPort {
  handle(input: { readonly body: string; readonly messageTypeHeader: string | null }): Promise<{
    readonly status: 200 | 400 | 403 | 413 | 503;
    readonly body: { readonly outcome: string };
  }>;
}

/** Route-level body parser + handler: SNS posts JSON as `text/plain; charset=UTF-8`. */
export function createNotificationFeedbackHandlers(options: {
  readonly port?: NotificationFeedbackPort;
}): RequestHandler[] {
  return [
    express.text({ type: () => true, limit: "128kb" }),
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (options.port === undefined) {
        response.status(404).json({ outcome: "unavailable" });
        return;
      }
      const body: unknown = request.body;
      if (typeof body !== "string" || Object.keys(request.query).length !== 0) {
        response.status(400).json({ outcome: "rejected" });
        return;
      }
      const header = request.get("x-amz-sns-message-type");
      try {
        const result = await options.port.handle({
          body,
          messageTypeHeader: typeof header === "string" ? header : null,
        });
        response.status(result.status).json(result.body);
      } catch {
        response.status(503).json({ outcome: "retry" });
      }
    },
  ];
}
