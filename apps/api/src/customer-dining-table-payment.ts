import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import type { CartQueryTransactionRunner } from "@rms/ordering";
import { createRetrieveIntentRequest, type RetrieveIntentRequest } from "@rms/payment";
import express, { type RequestHandler, type Response } from "express";
import type { createCustomerOrderStatusRead } from "./customer-order-status-read.js";
import { assertDiningParticipant } from "./customer-dining-session-read.js";
import {
  DiningTableOnlinePaymentError,
  type DiningTableOnlinePaymentView,
  type TableOnlinePaymentAuthority,
  type createDiningTableOnlinePayments,
} from "./dining-table-online-payment.js";
import type { DiningTableTip } from "./merchant-dining-table-checkout.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER S4: the guest's side of paying the whole table on their phone —
 * the table's bill (rounds, tax, the tip chosen once), starting or coming back to the payment,
 * the secure card form's one-time value, and the result as the Provider reports it. The guest is
 * any current participant of the table; the browser never names a table, an Order or an amount.
 */
export const customerDiningTablePaymentRoute = "/api/v1/dine-in/table-payment";
type StatusReadOptions = Parameters<typeof createCustomerOrderStatusRead>[0];
interface Credentials {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
}

export interface CustomerDiningTablePaymentOptions {
  readonly access: StatusReadOptions;
  readonly payments: ReturnType<typeof createDiningTableOnlinePayments>;
  /** The secure card form's one-time value (Stripe); absent with the TEST-ONLY simulator. */
  readonly handoff?: {
    retrieve(
      request: RetrieveIntentRequest,
      expectedAmount: { amountMinor: bigint; currencyCode: "CAD" },
    ): Promise<{ clientSecret: string }>;
  };
  readonly providerEnvironment: "Test" | "Live";
}

export function createCustomerDiningTablePayment(options: CustomerDiningTablePaymentOptions) {
  const scope = options.access.scope;
  const guestIn = async (tx: ConsumerTransaction, credentials: Credentials) => {
    const runner: CartQueryTransactionRunner = { run: async (work) => work(tx) };
    const guest = await new GuestSessionService({
      store: createPostgresGuestSessionEntryStore(runner, scope),
      credentials: options.access.credentials,
      binding: options.access.binding(tx),
      now: options.access.now,
      admission: { consume: async () => null },
    }).authorize({ ...credentials, observedAt: options.access.now() });
    return assertDiningParticipant(guest, scope);
  };
  const authority = async (credentials: Credentials): Promise<TableOnlinePaymentAuthority> => {
    const first = await options.access.transactions.run((tx) => guestIn(tx, credentials));
    return Object.freeze({
      diningSessionReference: first.diningSessionReference,
      guestSessionReference: first.guestSessionReference,
      allowed: async (tx: ConsumerTransaction) => {
        try {
          const again = await guestIn(tx, credentials);
          return (
            again.diningSessionReference === first.diningSessionReference &&
            again.guestSessionReference === first.guestSessionReference
          );
        } catch {
          return false;
        }
      },
    });
  };
  return Object.freeze({
    async read(credentials: Credentials) {
      return options.payments.refresh(await authority(credentials));
    },
    async start(
      credentials: Credentials,
      command: { operationReference: string; tip: DiningTableTip },
    ) {
      return options.payments.start(await authority(credentials), command);
    },
    async handoff(credentials: Credentials) {
      if (options.handoff === undefined)
        throw new DiningTableOnlinePaymentError("TABLE_ONLINE_PAYMENT_UNAVAILABLE");
      const view = await options.payments.read(await authority(credentials));
      const attempt = view.attempt;
      if (attempt === null || !attempt.mine)
        throw new DiningTableOnlinePaymentError("TABLE_ONLINE_PAYMENT_NOTHING_OWED");
      const { clientSecret } = await options.handoff.retrieve(
        createRetrieveIntentRequest({
          operation: "RetrieveIntent",
          purpose: "RetrievePaymentIntent",
          context: {
            provider: "Stripe",
            environment: options.providerEnvironment,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            paymentAttemptReference: attempt.onlinePaymentReference,
            operationReference: attempt.operationReference,
          },
          providerIntentReference: attempt.providerIntentReference,
        } as never),
        { amountMinor: BigInt(attempt.totalMinor), currencyCode: "CAD" },
      );
      return clientSecret;
    },
    /** The open attempt of this guest, for the TEST-ONLY simulator's confirm/decline. */
    async ownAttempt(credentials: Credentials) {
      const view = await options.payments.read(await authority(credentials));
      return view.attempt !== null && view.attempt.mine ? view.attempt : null;
    },
  });
}

/** The guest's view, in public fields only: no references, Provider identifiers or codes. */
export function customerTablePaymentBody(view: DiningTableOnlinePaymentView) {
  const bill = view.bill;
  const paid = bill.settlement;
  return {
    schemaVersion: 1,
    payment: {
      tableLabel: bill.tableLabel,
      checkingOut: bill.sessionPhase === "Closing",
      rounds: bill.rounds.map((round) => ({
        roundNumber: round.roundNumber,
        items: round.items.map((item) => ({
          displayName: item.displayName,
          subtotalMinor: item.subtotalMinor,
        })),
        totalMinor: round.totalMinor,
      })),
      owed: bill.owed,
      consistent: bill.consistent,
      state:
        paid !== null
          ? "Paid"
          : bill.writeOff !== null
            ? "Closed"
            : view.attempt !== null
              ? view.attempt.mine
                ? "Paying"
                : "AnotherGuestPaying"
              : bill.onlinePayment?.status === "Failed"
                ? "Failed"
                : "NotPaid",
      attempt:
        view.attempt === null || !view.attempt.mine
          ? null
          : { totalMinor: view.attempt.totalMinor, tipMinor: view.attempt.tipMinor },
      // The whole-table receipt once paid (decision 5): one payment, never split by round.
      receipt:
        paid === null
          ? null
          : {
              method: paid.method,
              roundsMinor: paid.roundsMinor,
              tipMinor: paid.tipMinor,
              roundingMinor: paid.roundingMinor,
              totalMinor: paid.totalMinor,
              paidAt: paid.recordedAt,
            },
    },
  };
}

const credential = /^[A-Za-z0-9_-]{43}$/u;
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
const errorBodies: Readonly<Record<string, [number, string]>> = {
  TABLE_ONLINE_PAYMENT_NOT_CHECKING_OUT: [409, "table_not_checking_out"],
  TABLE_ONLINE_PAYMENT_NOTHING_OWED: [409, "table_nothing_owed"],
  TABLE_ONLINE_PAYMENT_ALREADY_PAID: [409, "table_already_paid"],
  TABLE_ONLINE_PAYMENT_BILL_CHANGED: [409, "table_bill_changed"],
  TABLE_ONLINE_PAYMENT_ANOTHER_GUEST_PAYING: [409, "table_another_guest_paying"],
  TABLE_ONLINE_PAYMENT_STILL_PROCESSING: [409, "table_payment_processing"],
  TABLE_ONLINE_PAYMENT_INPUT_INVALID: [400, "table_payment_invalid"],
};

/** HTTP: POST {action: "Read" | "Start", ...}; POST /handoff for the secure card form. */
export class CustomerDiningTablePaymentHandler {
  readonly #origin: string;
  readonly #port: ReturnType<typeof createCustomerDiningTablePayment>;
  constructor(options: {
    allowedOrigin: string;
    port: ReturnType<typeof createCustomerDiningTablePayment>;
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  /** Same-origin guest request with its session cookie and CSRF value, or null. */
  credentials(request: Parameters<RequestHandler>[0]): Credentials | null {
    if (
      (request.get("origin") !== undefined && request.get("origin") !== this.#origin) ||
      request.get("sec-fetch-site") !== "same-origin" ||
      Object.keys(request.query).length !== 0
    )
      return null;
    const entries = (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name]) => name === "__Host-bop-guest");
    const csrf = request.headers["x-csrf-token"];
    if (
      entries.length !== 1 ||
      entries[0]?.length !== 2 ||
      !credential.test(entries[0]?.[1] ?? "") ||
      typeof csrf !== "string" ||
      !credential.test(csrf)
    )
      return null;
    return {
      sessionCredential: String(parseGuestRawCredential(entries[0]?.[1])),
      csrfCredential: String(parseGuestRawCredential(csrf)),
    };
  }
  failure(response: Response, error: unknown) {
    protect(response);
    const mapped =
      error instanceof DiningTableOnlinePaymentError ? errorBodies[error.code] : undefined;
    if (mapped !== undefined) {
      response.status(mapped[0]).json({ schemaVersion: 1, error: { code: mapped[1] } });
      return;
    }
    // A guest no longer at the table (or never was) is told so; anything else is retried.
    const status = /GUEST_SESSION|PERMISSION|DENIED/u.test(
      String((error as { code?: unknown } | null)?.code ?? ""),
    )
      ? 404
      : 503;
    if (status === 503) response.setHeader("Retry-After", "5");
    response.status(status).json({
      schemaVersion: 1,
      error: { code: status === 404 ? "table_not_found" : "table_payment_unavailable" },
    });
  }
  handler(): RequestHandler[] {
    return [
      express.json({ limit: "2kb", strict: true }),
      async (request, response) => {
        protect(response);
        const credentials = this.credentials(request);
        let command:
          | { action: "Read" }
          | { action: "Start"; operationReference: string; tip: DiningTableTip }
          | null = null;
        try {
          const body = (request.body ?? {}) as Record<string, unknown>;
          if (body.action === "Read") {
            readClosedRecord(body, ["action"]);
            command = { action: "Read" };
          } else if (body.action === "Start") {
            const raw = readClosedRecord(body, ["action", "operationReference", "tip"]);
            const tip = readClosedRecord(raw.tip, Object.keys((raw.tip ?? {}) as object));
            let parsed: DiningTableTip | null = null;
            if (tip.kind === "None" && Object.keys(tip).length === 1) parsed = { kind: "None" };
            else if (
              tip.kind === "Percent" &&
              Object.keys(tip).length === 2 &&
              [10, 15, 18, 20].includes(tip.percent as number)
            )
              parsed = { kind: "Percent", percent: tip.percent as 10 | 15 | 18 | 20 };
            else if (
              tip.kind === "Amount" &&
              Object.keys(tip).length === 2 &&
              typeof tip.amountMinor === "string" &&
              /^(0|[1-9][0-9]{0,8})$/u.test(tip.amountMinor)
            )
              parsed = { kind: "Amount", amountMinor: tip.amountMinor };
            if (
              parsed === null ||
              typeof raw.operationReference !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
                raw.operationReference,
              )
            )
              throw new Error();
            command = { action: "Start", operationReference: raw.operationReference, tip: parsed };
          }
        } catch {
          command = null;
        }
        if (credentials === null || command === null) {
          response.status(400).json({ schemaVersion: 1, error: { code: "table_payment_invalid" } });
          return;
        }
        try {
          const view =
            command.action === "Read"
              ? await this.#port.read(credentials)
              : await this.#port.start(credentials, command);
          response.status(200).json(customerTablePaymentBody(view));
        } catch (error) {
          this.failure(response, error);
        }
      },
    ];
  }
  /**
   * TEST-ONLY simulator (InternalTest): finish this guest's own open payment, approved or
   * declined. The caller supplies the simulator's action; the request must carry the explicit
   * simulation confirmation header.
   */
  simulationHandler(
    confirmation: "SIMULATE_CAPTURE" | "SIMULATE_FAILURE",
    simulate: (attempt: {
      onlinePaymentReference: string;
      operationReference: string;
      providerIntentReference: string;
    }) => Promise<void>,
  ): RequestHandler[] {
    return [
      express.json({ limit: "1kb", strict: true }),
      async (request, response) => {
        protect(response);
        const credentials = this.credentials(request);
        if (credentials === null || request.get("x-bop-simulation-confirmation") !== confirmation) {
          response.status(400).json({ code: "SIMULATION_CONFIRMATION_REQUIRED" });
          return;
        }
        try {
          const attempt = await this.#port.ownAttempt(credentials);
          if (attempt === null) {
            response.status(409).json({ code: "SIMULATION_NOTHING_OPEN" });
            return;
          }
          await simulate(attempt);
          response.status(200).json(customerTablePaymentBody(await this.#port.read(credentials)));
        } catch (error) {
          this.failure(response, error);
        }
      },
    ];
  }
  handoffHandler(): RequestHandler[] {
    return [
      express.json({ limit: "1kb", strict: true }),
      async (request, response) => {
        protect(response);
        const credentials = this.credentials(request);
        if (credentials === null) {
          response.status(400).json({ schemaVersion: 1, error: { code: "table_payment_invalid" } });
          return;
        }
        try {
          response
            .status(200)
            .json({ schemaVersion: 1, clientSecret: await this.#port.handoff(credentials) });
        } catch (error) {
          this.failure(response, error);
        }
      },
    ];
  }
}
