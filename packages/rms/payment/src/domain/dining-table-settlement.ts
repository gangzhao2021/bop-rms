/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: a table that paid once at the end. One payment (card machine
 * recorded after approval, or cash) is split into one line per round the table owed, joined by
 * the settlement's reference. Each line takes its round's total (tax included); the tip and — cash
 * only — the rounding to 5 cents go on one line, the last round's, so the lines add up to what was
 * taken. The rounding is its own amount: prices, tax and sales are unchanged.
 */
/** S4: "Online" — the guest paid the whole table on their phone (one Provider transaction). */
export type DiningTableSettlementMethod = "CardMachine" | "Cash" | "Online";

export class DiningTableSettlementError extends Error {
  constructor(
    readonly code:
      | "DINING_TABLE_SETTLEMENT_INVALID"
      | "DINING_TABLE_SETTLEMENT_TENDER_SHORT"
      | "DINING_TABLE_SETTLEMENT_NOTHING_OWED",
  ) {
    super("dining table settlement is invalid");
    this.name = "DiningTableSettlementError";
  }
}

const fail = (code: DiningTableSettlementError["code"] = "DINING_TABLE_SETTLEMENT_INVALID") => {
  throw new DiningTableSettlementError(code);
};
const MAXIMUM = 9223372036854775807n;
const amount = (value: bigint, minimum = 0n) =>
  typeof value === "bigint" && value >= minimum && value <= MAXIMUM ? value : fail();

/**
 * Canada's cash rounding (the 1-cent coin is withdrawn): the amount due in cash is rounded to the
 * nearest 5 cents by its last digit — 1, 2 down to 0; 3, 4 up to 5; 6, 7 down to 5; 8, 9 up to 10.
 * Card payments are never rounded.
 */
export function roundCashTotal(totalMinor: bigint): {
  readonly roundedMinor: bigint;
  readonly roundingMinor: bigint;
} {
  const total = amount(totalMinor);
  const digit = total % 10n;
  const rounding =
    digit === 0n || digit === 5n
      ? 0n
      : digit <= 2n
        ? -digit
        : digit <= 4n
          ? 5n - digit
          : digit <= 7n
            ? 5n - digit
            : 10n - digit;
  return Object.freeze({ roundedMinor: total + rounding, roundingMinor: rounding });
}

export interface DiningTableSettlementRound {
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  /** The round's place in the table's Order (1, 2, …). */
  readonly sequence: number;
  /** What the round comes to, tax included. */
  readonly roundMinor: bigint;
}

export interface DiningTableSettlementPlan {
  readonly method: DiningTableSettlementMethod;
  readonly roundsMinor: bigint;
  readonly tipMinor: bigint;
  readonly roundingMinor: bigint;
  /** What the table pays: rounds + tip + rounding. */
  readonly totalMinor: bigint;
  /** Cash only: what the guest handed over and the change given back. */
  readonly tenderedMinor: bigint | null;
  readonly changeMinor: bigint | null;
  readonly lines: readonly {
    readonly orderBatchReference: string;
    readonly submissionReference: string;
    readonly roundMinor: bigint;
    readonly tipMinor: bigint;
    readonly roundingMinor: bigint;
  }[];
}

/** The split of one table payment into its rounds' lines (tip and rounding on the last round). */
export function planDiningTableSettlement(input: {
  readonly method: DiningTableSettlementMethod;
  readonly rounds: readonly DiningTableSettlementRound[];
  readonly tipMinor: bigint;
  readonly tenderedMinor: bigint | null;
}): DiningTableSettlementPlan {
  if (input.method !== "CardMachine" && input.method !== "Cash" && input.method !== "Online")
    return fail();
  if (!Array.isArray(input.rounds) || input.rounds.length > 200) return fail();
  if (input.rounds.length === 0) return fail("DINING_TABLE_SETTLEMENT_NOTHING_OWED");
  const seen = new Set<string>();
  for (const round of input.rounds) {
    if (
      typeof round.orderBatchReference !== "string" ||
      typeof round.submissionReference !== "string" ||
      seen.has(round.orderBatchReference) ||
      !Number.isSafeInteger(round.sequence) ||
      round.sequence < 1
    )
      return fail();
    seen.add(round.orderBatchReference);
    amount(round.roundMinor, 1n);
  }
  const ordered = [...input.rounds].sort((a, b) => a.sequence - b.sequence);
  if (new Set(ordered.map((round) => round.sequence)).size !== ordered.length) return fail();
  const tip = amount(input.tipMinor);
  const roundsMinor = ordered.reduce((sum, round) => sum + round.roundMinor, 0n);
  amount(roundsMinor + tip, 1n);
  const { roundedMinor, roundingMinor } =
    input.method === "Cash"
      ? roundCashTotal(roundsMinor + tip)
      : { roundedMinor: roundsMinor + tip, roundingMinor: 0n };
  let tenderedMinor: bigint | null = null,
    changeMinor: bigint | null = null;
  if (input.method === "Cash") {
    if (input.tenderedMinor === null) return fail();
    tenderedMinor = amount(input.tenderedMinor, 1n);
    if (tenderedMinor < roundedMinor) return fail("DINING_TABLE_SETTLEMENT_TENDER_SHORT");
    changeMinor = tenderedMinor - roundedMinor;
  } else if (input.tenderedMinor !== null) return fail();
  const last = ordered.length - 1;
  return Object.freeze({
    method: input.method,
    roundsMinor,
    tipMinor: tip,
    roundingMinor,
    totalMinor: roundedMinor,
    tenderedMinor,
    changeMinor,
    lines: Object.freeze(
      ordered.map((round, index) =>
        Object.freeze({
          orderBatchReference: round.orderBatchReference,
          submissionReference: round.submissionReference,
          roundMinor: round.roundMinor,
          tipMinor: index === last ? tip : 0n,
          roundingMinor: index === last ? roundingMinor : 0n,
        }),
      ),
    ),
  });
}
