import { nameLocale } from "../i18n/i18n.js";
import { boundedJsonFetch } from "../network/bounded-fetch.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";

/** Dish names on a split bill's parts in the language the guest chose. */
const guestLocale = () => (nameLocale() === null ? {} : { locale: nameLocale() });

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER S4: paying the whole table on the guest's phone. The server works
 * out the bill; the browser sends only the tip chosen (once) and its own operation reference.
 */
export type TablePaymentState =
  "NotPaid" | "Paying" | "AnotherGuestPaying" | "Failed" | "Paid" | "Closed";
export type TableTip =
  | { readonly kind: "None" }
  | { readonly kind: "Percent"; readonly percent: number }
  | { readonly kind: "Amount"; readonly amountMinor: string };
export interface TablePaymentView {
  /** Owner 2026-11-03: what went back from this table's payments ("0" while nothing has). */
  readonly refundedMinor: string;
  readonly tableLabel: string | null;
  readonly checkingOut: boolean;
  readonly rounds: readonly {
    readonly roundNumber: number;
    readonly items: readonly { readonly displayName: string; readonly subtotalMinor: string }[];
    readonly totalMinor: string;
  }[];
  readonly owed: {
    readonly subtotalMinor: string;
    /** Includes the tax rounding below. */
    readonly taxMinor: string;
    readonly totalMinor: string;
    /** WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill's tax rounding still owed (older server: 0). */
    readonly taxRoundingMinor: string;
  };
  readonly consistent: boolean;
  /**
   * WP-2423 item 8 ⑦ (Owner decision 11): the Store's tip percentages (of the subtotal before
   * tax), or tips off. An older server sends none: 10 / 15 / 18 %.
   */
  readonly tips: { readonly enabled: boolean; readonly tierPercents: readonly number[] };
  readonly state: TablePaymentState;
  readonly attempt: {
    readonly totalMinor: string;
    readonly tipMinor: string;
    /** WP-2423 item 8 ④: the part this guest is paying (null: the whole table). */
    readonly partNumber: number | null;
  } | null;
  /**
   * WP-2423 item 8 ④: the table's bill split into parts paid one by one (null: paid whole).
   * "Mine": this guest is paying it; "Paying": someone else is.
   */
  readonly split: null | {
    /** "ByGuests": guests at the table pay by dish as they go (WP-2423 同桌结账). */
    readonly mode: "Even" | "ByRounds" | "ByItems" | "ByGuests";
    /** Every part paid (by dish: the parts cover the whole bill). */
    readonly paidInFull: boolean;
    readonly paidParts: number;
    readonly remainingMinor: string;
    readonly parts: readonly {
      readonly partNumber: number;
      readonly amountMinor: string;
      readonly subtotalMinor: string;
      /** By dish: what this part pays for, so guests can find their own part. */
      readonly dishes: readonly {
        readonly displayName: string;
        readonly quantity: number;
        readonly shared: boolean;
      }[];
      readonly status: "Paid" | "Mine" | "Paying" | "ToPay";
      /** WP-2423 同桌结账: this phone paid this part. */
      readonly byYou: boolean;
    }[];
  };
  /**
   * WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06): what this phone may pay by dish — null when
   * the table is paid, staff split it another way, or an older server. `mine`: what "only what I
   * added" comes to (null: nothing of theirs left to pay). Each dish: the units still to pay.
   */
  readonly choices: null | {
    /** The Store's setting: what this phone starts with. */
    readonly defaultScope: "WholeTable" | "OwnDishes";
    readonly mine: null | { readonly count: number; readonly amountMinor: string };
    readonly dishes: readonly {
      readonly orderItemReference: string;
      readonly displayName: string;
      readonly roundNumber: number;
      readonly mine: boolean;
      readonly unitMinor: readonly string[];
      readonly unitSubtotalMinor: readonly string[];
    }[];
    /** What is left of each round: a choice taking its last dishes pays exactly this. */
    readonly rounds: readonly {
      readonly roundNumber: number;
      readonly restMinor: string;
      readonly restSubtotalMinor: string;
    }[];
  };
  readonly receipt: null | {
    readonly method: "CardMachine" | "Cash" | "Online";
    readonly roundsMinor: string;
    /** WP-2423 取舍 18: already off `roundsMinor`; said so the receipt adds up with the order. */
    readonly pointsUsedMinor: string;
    readonly tipMinor: string;
    readonly roundingMinor: string;
    readonly totalMinor: string;
    readonly paidAt: string;
  };
}
/**
 * WP-2423 同桌结账: which dishes this phone pays — only what it added, dishes it chooses (also for
 * others at the table), or the rest once others paid some. Absent: the whole table.
 */
export type TablePayChoice =
  | { readonly kind: "Mine" }
  | { readonly kind: "Rest" }
  | {
      readonly kind: "Chosen";
      readonly dishes: readonly {
        readonly orderItemReference: string;
        readonly quantity: number;
      }[];
    };
export type TablePaymentErrorCode =
  | "not-checking-out"
  | "already-paid"
  | "bill-changed"
  | "another-guest-paying"
  | "processing"
  | "not-found"
  /** WP-2423 item 8 ⑦: the Store turned tips off; the bill is paid without one. */
  | "tips-off"
  /** The Store's tip percentages changed: the guest chooses again. */
  | "tip-choices-changed"
  /** WP-2423 item 8 ⑤: some of the table's dishes wait for staff to confirm them first. */
  | "rounds-waiting"
  /** WP-2423 同桌结账: someone at the table just started paying for some of these dishes. */
  | "dishes-taken"
  /** Staff split the bill: the guest pays one of its parts. */
  | "split-by-staff"
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
    refundedMinor: p.refundedMinor === undefined ? "0" : amount(p.refundedMinor),
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
      taxRoundingMinor:
        owed.taxRoundingMinor === undefined
          ? "0"
          : typeof owed.taxRoundingMinor === "string" &&
              /^-?(0|[1-9][0-9]{0,15})$/u.test(owed.taxRoundingMinor) &&
              owed.taxRoundingMinor !== "-0"
            ? owed.taxRoundingMinor
            : fail(),
    }),
    consistent: p.consistent,
    tips: tipsOf(p.tips),
    state: p.state as TablePaymentState,
    attempt:
      attempt === null || attempt === undefined
        ? null
        : Object.freeze({
            totalMinor: amount(attempt.totalMinor),
            tipMinor: amount(attempt.tipMinor),
            partNumber:
              attempt.partNumber === undefined || attempt.partNumber === null
                ? null
                : Number.isSafeInteger(attempt.partNumber)
                  ? (attempt.partNumber as number)
                  : fail(),
          }),
    split: splitOf(p.split),
    choices: choicesOf(p.choices),
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
            pointsUsedMinor: amount(receipt.pointsUsedMinor),
            tipMinor: amount(receipt.tipMinor),
            roundingMinor: amount(receipt.roundingMinor),
            totalMinor: amount(receipt.totalMinor),
            paidAt: typeof receipt.paidAt === "string" ? receipt.paidAt : fail(),
          }),
  });
}

function tipsOf(value: unknown): TablePaymentView["tips"] {
  if (value === undefined) return Object.freeze({ enabled: true, tierPercents: [10, 15, 18] });
  const raw = (value ?? {}) as Record<string, unknown>;
  const tiers = raw.tierPercents;
  if (
    typeof raw.enabled !== "boolean" ||
    !Array.isArray(tiers) ||
    tiers.length !== 3 ||
    tiers.some((n) => !Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > 50) ||
    !(Number(tiers[0]) < Number(tiers[1]) && Number(tiers[1]) < Number(tiers[2]))
  )
    return fail();
  return Object.freeze({ enabled: raw.enabled, tierPercents: Object.freeze(tiers.map(Number)) });
}

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function choicesOf(value: unknown): TablePaymentView["choices"] {
  if (value === undefined || value === null) return null;
  const raw = value as Record<string, unknown>;
  const mine = raw.mine as Record<string, unknown> | null;
  if (
    !Array.isArray(raw.dishes) ||
    raw.dishes.length > 500 ||
    !Array.isArray(raw.rounds) ||
    (raw.defaultScope !== "WholeTable" && raw.defaultScope !== "OwnDishes")
  )
    return fail();
  return Object.freeze({
    defaultScope: raw.defaultScope,
    mine:
      mine === null || mine === undefined
        ? null
        : Object.freeze({
            count:
              Number.isSafeInteger(mine.count) && Number(mine.count) > 0
                ? Number(mine.count)
                : fail(),
            amountMinor: amount(mine.amountMinor),
          }),
    dishes: Object.freeze(
      raw.dishes.map((value: unknown) => {
        const dish = value as Record<string, unknown>;
        if (
          typeof dish.orderItemReference !== "string" ||
          !reference.test(dish.orderItemReference) ||
          typeof dish.displayName !== "string" ||
          !Number.isSafeInteger(dish.roundNumber) ||
          typeof dish.mine !== "boolean" ||
          !Array.isArray(dish.unitMinor) ||
          dish.unitMinor.length < 1 ||
          !Array.isArray(dish.unitSubtotalMinor) ||
          dish.unitSubtotalMinor.length !== dish.unitMinor.length
        )
          return fail();
        return Object.freeze({
          orderItemReference: dish.orderItemReference,
          displayName: dish.displayName,
          roundNumber: dish.roundNumber as number,
          mine: dish.mine,
          unitMinor: Object.freeze(dish.unitMinor.map(amount)),
          unitSubtotalMinor: Object.freeze(dish.unitSubtotalMinor.map(amount)),
        });
      }),
    ),
    rounds: Object.freeze(
      raw.rounds.map((value: unknown) => {
        const round = value as Record<string, unknown>;
        if (!Number.isSafeInteger(round.roundNumber)) return fail();
        return Object.freeze({
          roundNumber: round.roundNumber as number,
          restMinor: amount(round.restMinor),
          restSubtotalMinor: amount(round.restSubtotalMinor),
        });
      }),
    ),
  });
}

function splitOf(value: unknown): TablePaymentView["split"] {
  if (value === undefined || value === null) return null;
  const raw = value as Record<string, unknown>;
  const byGuests = raw.mode === "ByGuests";
  if (
    (raw.mode !== "Even" &&
      raw.mode !== "ByRounds" &&
      raw.mode !== "ByItems" &&
      raw.mode !== "ByGuests") ||
    !Number.isSafeInteger(raw.paidParts) ||
    !Array.isArray(raw.parts) ||
    // Guests paying by dish start with no part and add one each time someone pays.
    raw.parts.length < (byGuests ? 0 : 2) ||
    raw.parts.length > (byGuests ? 100 : 20)
  )
    return fail();
  let previous = 0;
  return Object.freeze({
    mode: raw.mode,
    // An older server: every part paid.
    paidInFull:
      typeof raw.paidInFull === "boolean"
        ? raw.paidInFull
        : raw.parts.length > 0 && raw.paidParts === raw.parts.length,
    paidParts: raw.paidParts as number,
    remainingMinor: amount(raw.remainingMinor),
    parts: Object.freeze(
      raw.parts.map((value: unknown, index: number) => {
        const part = value as Record<string, unknown>;
        // By dish, a part whose payment failed is left out: the numbers that remain go up.
        const numbered = byGuests
          ? Number.isSafeInteger(part.partNumber) && Number(part.partNumber) > previous
          : part.partNumber === index + 1;
        if (!numbered || !["Paid", "Mine", "Paying", "ToPay"].includes(String(part.status)))
          return fail();
        previous = Number(part.partNumber);
        return Object.freeze({
          partNumber: previous,
          amountMinor: amount(part.amountMinor),
          subtotalMinor: amount(part.subtotalMinor),
          dishes: Object.freeze(
            (Array.isArray(part.dishes) ? part.dishes : []).map((value: unknown) => {
              const dish = value as Record<string, unknown>;
              if (
                typeof dish.displayName !== "string" ||
                !Number.isSafeInteger(dish.quantity) ||
                typeof dish.shared !== "boolean"
              )
                return fail();
              return Object.freeze({
                displayName: dish.displayName,
                quantity: dish.quantity as number,
                shared: dish.shared,
              });
            }),
          ),
          status: part.status as "Paid" | "Mine" | "Paying" | "ToPay",
          byYou: part.byYou === true,
        });
      }),
    ),
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
  table_tips_turned_off: "tips-off",
  table_tip_choices_changed: "tip-choices-changed",
  table_rounds_waiting: "rounds-waiting",
  table_dishes_taken: "dishes-taken",
  table_split_by_staff: "split-by-staff",
};

export function createTablePaymentClient(request: typeof fetch = globalThis.fetch) {
  async function post(path: string, body: object, headers: Record<string, string> = {}) {
    const csrf = getCustomerCsrfCredential();
    const current = captureCustomerCsrfContext();
    if (csrf === null || !/^[A-Za-z0-9_-]{43}$/u.test(csrf)) return fail("not-found");
    let answer: Awaited<ReturnType<typeof boundedJsonFetch>>;
    try {
      answer = await boundedJsonFetch(request, "/api/v1/dine-in/table-payment" + path, {
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
    const { response } = answer;
    const payload = answer.payload as {
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
      return parseTablePaymentView(await post("", { action: "Read", ...guestLocale() }));
    },
    /**
     * Pay the whole table — or, for a split bill, one part (WP-2423 item 8 ④) — with this tip;
     * the same operation comes back to the same payment.
     */
    async start(
      operationReference: string,
      tip: TableTip,
      partNumber: number | null = null,
      choice: TablePayChoice | null = null,
    ) {
      return parseTablePaymentView(
        await post("", {
          action: "Start",
          operationReference,
          tip,
          ...(partNumber === null ? {} : { partNumber }),
          ...(choice === null ? {} : { choice }),
          ...guestLocale(),
        }),
      );
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
