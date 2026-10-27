import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER S4: paying the whole table on the guest's phone. The server works
 * out the bill; the browser sends only the tip chosen (once) and its own operation reference.
 */
export type TablePaymentState =
  "NotPaid" | "Paying" | "AnotherGuestPaying" | "Failed" | "Paid" | "Closed";
export type TableTip =
  | { readonly kind: "None" }
  | { readonly kind: "Percent"; readonly percent: 10 | 15 | 18 | 20 }
  | { readonly kind: "Amount"; readonly amountMinor: string };
export interface TablePaymentView {
  readonly tableLabel: string | null;
  readonly checkingOut: boolean;
  readonly rounds: readonly {
    readonly roundNumber: number;
    readonly items: readonly { readonly displayName: string; readonly subtotalMinor: string }[];
    readonly totalMinor: string;
  }[];
  readonly owed: {
    readonly subtotalMinor: string;
    readonly taxMinor: string;
    readonly totalMinor: string;
  };
  readonly consistent: boolean;
  readonly state: TablePaymentState;
  readonly attempt: { readonly totalMinor: string; readonly tipMinor: string } | null;
  readonly receipt: null | {
    readonly method: "CardMachine" | "Cash" | "Online";
    readonly roundsMinor: string;
    readonly tipMinor: string;
    readonly roundingMinor: string;
    readonly totalMinor: string;
    readonly paidAt: string;
  };
}
export type TablePaymentErrorCode =
  | "not-checking-out"
  | "already-paid"
  | "bill-changed"
  | "another-guest-paying"
  | "processing"
  | "not-found"
  | "unavailable";
export class TablePaymentClientError extends Error {
  constructor(readonly code: TablePaymentErrorCode) {
    super(code);
    this.name = "TablePaymentClientError";
  }
}
const fail = (code: TablePaymentErrorCode = "unavailable"): never => {
  throw new TablePaymentClientError(code);
};
const minor = /^-?(?:0|[1-9][0-9]{0,18})$/u;
const amount = (value: unknown) =>
  typeof value === "string" && minor.test(value) ? value : fail();

export function parseTablePaymentView(value: unknown): TablePaymentView {
  const body = (value ?? {}) as { schemaVersion?: unknown; payment?: Record<string, unknown> };
  const p = body.payment;
  if (body.schemaVersion !== 1 || p === undefined || p === null || typeof p !== "object")
    return fail();
  const states: readonly TablePaymentState[] = [
    "NotPaid",
    "Paying",
    "AnotherGuestPaying",
    "Failed",
    "Paid",
    "Closed",
  ];
  const owed = (p.owed ?? {}) as Record<string, unknown>;
  const attempt = p.attempt as Record<string, unknown> | null;
  const receipt = p.receipt as Record<string, unknown> | null;
  if (
    !Array.isArray(p.rounds) ||
    typeof p.checkingOut !== "boolean" ||
    typeof p.consistent !== "boolean" ||
    !states.includes(p.state as TablePaymentState)
  )
    return fail();
  return Object.freeze({
    tableLabel: typeof p.tableLabel === "string" ? p.tableLabel : null,
    checkingOut: p.checkingOut,
    rounds: Object.freeze(
      p.rounds.map((round: Record<string, unknown>) => {
        if (!Number.isSafeInteger(round.roundNumber) || !Array.isArray(round.items)) return fail();
        return Object.freeze({
          roundNumber: round.roundNumber as number,
          items: Object.freeze(
            round.items.map((item: Record<string, unknown>) =>
              Object.freeze({
                displayName: typeof item.displayName === "string" ? item.displayName : fail(),
                subtotalMinor: amount(item.subtotalMinor),
              }),
            ),
          ),
          totalMinor: amount(round.totalMinor),
        });
      }),
    ),
    owed: Object.freeze({
      subtotalMinor: amount(owed.subtotalMinor),
      taxMinor: amount(owed.taxMinor),
      totalMinor: amount(owed.totalMinor),
    }),
    consistent: p.consistent,
    state: p.state as TablePaymentState,
    attempt:
      attempt === null || attempt === undefined
        ? null
        : Object.freeze({
            totalMinor: amount(attempt.totalMinor),
            tipMinor: amount(attempt.tipMinor),
          }),
    receipt:
      receipt === null || receipt === undefined
        ? null
        : Object.freeze({
            method:
              receipt.method === "CardMachine" ||
              receipt.method === "Cash" ||
              receipt.method === "Online"
                ? receipt.method
                : fail(),
            roundsMinor: amount(receipt.roundsMinor),
            tipMinor: amount(receipt.tipMinor),
            roundingMinor: amount(receipt.roundingMinor),
            totalMinor: amount(receipt.totalMinor),
            paidAt: typeof receipt.paidAt === "string" ? receipt.paidAt : fail(),
          }),
  });
}

const errorCodes: Readonly<Record<string, TablePaymentErrorCode>> = {
  table_not_checking_out: "not-checking-out",
  table_nothing_owed: "already-paid",
  table_already_paid: "already-paid",
  table_bill_changed: "bill-changed",
  table_another_guest_paying: "another-guest-paying",
  table_payment_processing: "processing",
  table_not_found: "not-found",
};

export function createTablePaymentClient(request: typeof fetch = globalThis.fetch) {
  async function post(path: string, body: object, headers: Record<string, string> = {}) {
    const csrf = getCustomerCsrfCredential();
    const current = captureCustomerCsrfContext();
    if (csrf === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrf)) return fail("not-found");
    let response: Response;
    try {
      response = await request("/api/v1/dine-in/table-payment" + path, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": csrf,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    } catch {
      return fail();
    }
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: unknown };
      clientSecret?: unknown;
    } | null;
    if (!current()) return fail();
    if (response.status !== 200)
      return fail(errorCodes[String(payload?.error?.code ?? "")] ?? "unavailable");
    return payload;
  }
  return Object.freeze({
    /** The bill and the payment, as the Provider reports it now. */
    async read() {
      return parseTablePaymentView(await post("", { action: "Read" }));
    },
    /** Pay the whole table with this tip; the same operation comes back to the same payment. */
    async start(operationReference: string, tip: TableTip) {
      return parseTablePaymentView(await post("", { action: "Start", operationReference, tip }));
    },
    /** The secure card form's one-time value (Stripe). */
    async handoff() {
      const payload = await post("/handoff", {});
      const secret = (payload as { clientSecret?: unknown } | null)?.clientSecret;
      if (typeof secret !== "string" || !/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/u.test(secret))
        return fail();
      return secret;
    },
    /** Internal testing only: finish the simulated payment, approved or declined. */
    async simulate(outcome: "approve" | "decline") {
      return parseTablePaymentView(
        await post(
          outcome === "approve" ? "/simulation-confirm" : "/simulation-fail",
          {},
          {
            "x-bop-simulation-confirmation":
              outcome === "approve" ? "SIMULATE_CAPTURE" : "SIMULATE_FAILURE",
          },
        ),
      );
    },
  });
}
