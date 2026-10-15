import { readClosedRecord } from "@bop/identity";
import type { OrderPaymentPreparationEvidence } from "@rms/ordering";
import type { CustomerCartBindingPort } from "./customer-cart-binding.js";
import type { CustomerCartPort } from "./customer-cart.js";
import type { CustomerCheckoutDetailsPort } from "./customer-checkout-details.js";
import type { CustomerEntryPort } from "./customer-entry.js";
import type { CustomerQuotePort } from "./customer-quote.js";
import { createGuestOrderSteps } from "./counter-guest-pipeline.js";
import type { CounterGuestCredentials } from "./merchant-counter-order.js";
import type { StaffTableGuestPipeline } from "./merchant-staff-dining-round.js";

interface Staff {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
}
type Issued =
  | { readonly status: "Issued"; readonly joinCredential: string }
  | { readonly status: "AlreadyApplied" }
  | { readonly status: string };

/**
 * WP-2423 Q7 slice 2: a one-time table code for the staff member's table guest, issued the way
 * staff issue one for a party on the Tables page (Dining owner commands under the staff member's
 * table authority): a table without a dining session gets one started; a table with one gets a
 * fresh code (any earlier unused code for that table stops working, guests already at the table
 * stay joined). Nothing is returned for a table that can't be seated.
 */
export function createStaffTableCode(options: {
  loadTable(tableReference: string): Promise<null | {
    readonly aggregateVersion: number;
    readonly activeDiningSessionReference: string | null;
    /** Published and available to seat. */
    readonly seatable: boolean;
  }>;
  loadJoinState(
    staff: Staff,
    diningSessionReference: string,
  ): Promise<null | {
    readonly tableReference: string;
    readonly sessionVersion: number;
    readonly tableAssignmentVersion: number;
    readonly capabilityVersion: number;
    readonly generation: number;
  }>;
  start(staff: Staff, command: Record<string, unknown>): Promise<unknown>;
  regenerate(staff: Staff, command: Record<string, unknown>): Promise<unknown>;
  nextReference(): string;
}): StaffTableGuestPipeline["openTable"] {
  const issued = (value: unknown, diningSessionReference: string | null) => {
    const result = value as Issued & { session?: { diningSessionReference?: unknown } };
    if (
      result?.status !== "Issued" ||
      !("joinCredential" in result) ||
      typeof result.joinCredential !== "string"
    )
      return null;
    const session = diningSessionReference ?? result.session?.diningSessionReference;
    if (typeof session !== "string") return null;
    return Object.freeze({
      status: "Opened" as const,
      diningSessionReference: session,
      joinCredential: result.joinCredential,
    });
  };
  return async (staff, input) => {
    // A second staff member may start the table's session at the same moment: read it again once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const table = await options.loadTable(input.tableReference);
      if (table === null || !table.seatable) return Object.freeze({ status: "TableUnavailable" });
      try {
        if (table.activeDiningSessionReference === null) {
          const opened = issued(
            await options.start(staff, {
              tableReference: input.tableReference,
              expectedAssignmentVersion: table.aggregateVersion,
              operationReference: options.nextReference(),
              joinKind: "HumanCode",
            }),
            null,
          );
          if (opened !== null) return opened;
          continue;
        }
        const state = await options.loadJoinState(staff, table.activeDiningSessionReference);
        if (state === null || state.tableReference !== input.tableReference) continue;
        const opened = issued(
          await options.regenerate(staff, {
            diningSessionReference: table.activeDiningSessionReference,
            tableReference: input.tableReference,
            expectedAssignmentVersion: state.tableAssignmentVersion,
            expectedSessionVersion: state.sessionVersion,
            expectedCapabilityVersion: state.capabilityVersion,
            expectedGeneration: state.generation,
            operationReference: options.nextReference(),
          }),
          table.activeDiningSessionReference,
        );
        if (opened !== null) return opened;
      } catch {
        // The table changed under us (another session start, a code issued, the session closing).
      }
    }
    return Object.freeze({ status: "TableUnavailable" });
  };
}

/**
 * WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): the table guest a staff-entered round runs
 * through, composed from exactly the ports the customer app's HTTP handlers call (table QR entry,
 * dining join with a one-time table code, dining binding, the table's shared Cart, items, quote,
 * checkout details, checkout, and the first-or-later round submission with tip and payment clock).
 * Only the transport differs: credentials stay in this process's memory for one staff request.
 */
export function createStaffTableGuestPipeline(options: {
  takesOrder(input: { readonly recordedAfterOutage: boolean }): Promise<boolean>;
  openTable: StaffTableGuestPipeline["openTable"];
  /** The table's current printed QR token (as a guest scans it); null when it has none. */
  tableQrToken(tableReference: string): Promise<string | null>;
  entry: CustomerEntryPort;
  join: { join(input: unknown, request: unknown): Promise<unknown> };
  /** The join request's trusted context (abuse budget), as the customer route builds it. */
  joinRequest(): Promise<unknown>;
  /** The dining binding (same prepare/activate exchange as the customer app). */
  binding: Pick<CustomerCartBindingPort, "prepare" | "activate">;
  sessions: {
    authorize(input: {
      sessionCredential: string;
      csrfCredential: string;
      observedAt: string;
    }): Promise<{ readonly sessionReference: string }>;
  };
  cart: Pick<CustomerCartPort, "createCart" | "addItem">;
  quote: CustomerQuotePort;
  details: Pick<CustomerCheckoutDetailsPort, "save">;
  checkout: { create(value: unknown): Promise<unknown> };
  /** The customer payment preparation (first round or later round), without a Provider. */
  payment: { prepare(value: unknown): Promise<OrderPaymentPreparationEvidence> };
  nextReference(): string;
  now(): string;
}): StaffTableGuestPipeline {
  const failed = (): never => {
    throw new Error("TABLE_GUEST_PIPELINE_UNAVAILABLE");
  };
  const steps = createGuestOrderSteps(options);
  return Object.freeze<StaffTableGuestPipeline>({
    ...steps,
    takesOrder: (input) => options.takesOrder(input),
    openTable: (staff, input) => options.openTable(staff, input),
    async enter(input) {
      const qrToken = await options.tableQrToken(input.tableReference);
      if (qrToken === null) return Object.freeze({ status: "NoTableQr" as const });
      const result = (await options.entry.establish({
        entryRequestReference: options.nextReference(),
        operationReference: options.nextReference(),
        qrToken,
        requestedAt: input.requestedAt,
      })) as {
        status: string;
        channel?: string;
        sessionCredential?: unknown;
        csrfCredential?: unknown;
      };
      if (result.status === "NotAccepting")
        return Object.freeze({ status: "NotAccepting" as const });
      if (
        result.status !== "Established" ||
        result.channel !== "DineIn" ||
        typeof result.sessionCredential !== "string" ||
        typeof result.csrfCredential !== "string"
      )
        return failed();
      return Object.freeze({
        status: "Established" as const,
        credentials: Object.freeze({
          sessionCredential: result.sessionCredential,
          csrfCredential: result.csrfCredential,
        }),
      });
    },
    async join(credentials, input) {
      const joined = readClosedRecord(
        await options.join.join(
          {
            sessionCredential: credentials.sessionCredential,
            csrfCredential: credentials.csrfCredential,
            joinCredential: input.joinCredential,
            operationReference: input.operationReference,
          },
          await options.joinRequest(),
        ),
        ["status", "operationReference", "admissionReference"],
      );
      if (
        joined.status !== "Joined" ||
        joined.operationReference !== input.operationReference ||
        typeof joined.admissionReference !== "string"
      )
        return failed();
      return Object.freeze({ admissionReference: joined.admissionReference });
    },
    async bind(credentials, input) {
      const prepared = readClosedRecord(
        await options.binding.prepare({
          operationReference: input.operationReference,
          ...credentials,
          admissionReference: input.admissionReference,
        } as never),
        [
          "status",
          "operationReference",
          "sessionCredential",
          "csrfCredential",
          "recoveryProof",
          "expiresAt",
        ],
      );
      if (
        prepared.status !== "Prepared" ||
        typeof prepared.sessionCredential !== "string" ||
        typeof prepared.csrfCredential !== "string" ||
        typeof prepared.recoveryProof !== "string"
      )
        return failed();
      const activated = readClosedRecord(
        await options.binding.activate({
          operationReference: input.operationReference,
          ...credentials,
          candidateSessionCredential: prepared.sessionCredential,
          candidateCsrfCredential: prepared.csrfCredential,
          recoveryProof: prepared.recoveryProof,
        }),
        ["status", "operationReference", "sessionCredential", "csrfCredential", "cookie"],
      );
      if (
        activated.status !== "Activated" ||
        activated.sessionCredential !== prepared.sessionCredential ||
        activated.csrfCredential !== prepared.csrfCredential
      )
        return failed();
      const current: CounterGuestCredentials = Object.freeze({
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      });
      const guest = await options.sessions.authorize({ ...current, observedAt: options.now() });
      return Object.freeze({
        credentials: current,
        guestSessionReference: String(guest.sessionReference),
      });
    },
    async selectCart(credentials, input) {
      const result = await options.cart.createCart({
        guestCredential: credentials.sessionCredential,
        csrfCredential: credentials.csrfCredential,
        operationReference: input.operationReference,
        requestedAt: input.requestedAt,
      });
      if (result.status === "CheckoutInProgress" || result.status === "OrderProcessing")
        return Object.freeze({ status: "CheckoutInProgress" as const });
      if (
        (result.status !== "Applied" && result.status !== "Current") ||
        result.view.cart.orderType !== "DineIn"
      )
        return failed();
      return Object.freeze({
        status: "Selected" as const,
        cartReference: result.view.cart.cartReference,
        cartVersion: result.view.cart.version,
        pendingItems: Object.freeze(
          result.view.cart.items.map((item) =>
            Object.freeze({ name: item.displayName, quantity: item.quantity }),
          ),
        ),
      });
    },
    async preparePayment(credentials, input) {
      if (!(await options.takesOrder({ recordedAfterOutage: input.recordedAfterOutage })))
        throw Object.assign(new Error("store closed"), { code: "STORE_CLOSED" });
      return options.payment.prepare({
        ...credentials,
        checkoutSessionReference: input.checkoutSessionReference,
        selectionReference: input.selectionReference,
        tip: input.tip,
      });
    },
  });
}
