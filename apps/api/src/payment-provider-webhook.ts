import { PaymentWebhookInboxError, ProviderWebhookVerificationError } from "@rms/payment";
import express, { type RequestHandler, type Response } from "express";

/**
 * WP-2423 DEC-STRIPE-PILOT-WIRING: the Stripe webhook endpoint. Stripe signs the exact bytes it
 * sends, so the body is read raw (never JSON-parsed or re-serialized here) and handed to the
 * Payment receiver with the signature header and the server's receive time. A 2xx answer means
 * the event is durably accepted and processed; any other answer makes Stripe deliver it again,
 * which the Payment Webhook Inbox deduplicates.
 */
export const paymentProviderWebhookRoute = "/api/v1/payment-provider/stripe/webhook";
export interface PaymentProviderWebhookPort {
  receive(input: {
    readonly signatureHeader: string;
    readonly rawBody: Uint8Array;
    readonly receivedAt: string;
  }): Promise<unknown>;
}
const permanent = new Set([
  "PROVIDER_WEBHOOK_INPUT_INVALID",
  "PROVIDER_WEBHOOK_SIGNATURE_INVALID",
  "PROVIDER_WEBHOOK_TIMESTAMP_INVALID",
  "PROVIDER_WEBHOOK_PAYLOAD_INVALID",
  "PROVIDER_WEBHOOK_SCOPE_MISMATCH",
  "PAYMENT_WEBHOOK_INBOX_IDENTITY_CONFLICT",
  "PAYMENT_WEBHOOK_INBOX_EVIDENCE_MISMATCH",
  "PAYMENT_WEBHOOK_INBOX_INPUT_INVALID",
]);
function reply(response: Response, status: number) {
  response.setHeader("Cache-Control", "no-store");
  if (status === 200) {
    response.status(200).json({ received: true });
    return;
  }
  if (status === 503) response.setHeader("Retry-After", "30");
  response.status(status).json({
    error: {
      code: status === 400 ? "webhook_rejected" : "webhook_unavailable",
      message: "The webhook could not be accepted.",
    },
  });
}
export class PaymentProviderWebhookHandler {
  readonly #port: PaymentProviderWebhookPort;
  readonly #now: () => string;
  constructor(options: { port: PaymentProviderWebhookPort; now?: () => string }) {
    this.#port = options.port;
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  handlers(): RequestHandler[] {
    return [
      express.raw({ type: () => true, limit: "1mb" }),
      async (request, response) => {
        const signature = request.get("stripe-signature");
        const body: unknown = request.body;
        if (
          typeof signature !== "string" ||
          signature.length < 1 ||
          signature.length > 8192 ||
          Object.keys(request.query).length !== 0 ||
          request.is("application/json") !== "application/json" ||
          !Buffer.isBuffer(body) ||
          body.byteLength < 1
        ) {
          reply(response, 400);
          return;
        }
        try {
          await this.#port.receive({
            signatureHeader: signature,
            rawBody: new Uint8Array(body),
            receivedAt: this.#now(),
          });
          reply(response, 200);
        } catch (error) {
          const code =
            error instanceof ProviderWebhookVerificationError ||
            error instanceof PaymentWebhookInboxError
              ? error.code
              : null;
          reply(response, code !== null && permanent.has(code) ? 400 : 503);
        } finally {
          body.fill(0);
        }
      },
    ];
  }
}
export const unavailablePaymentProviderWebhookHandler: RequestHandler = (_request, response) =>
  reply(response, 503);
