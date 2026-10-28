import { useState } from "react";
import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  TableCheckoutError,
  type TableBill,
  type createTableCheckoutClient,
} from "./table-checkout-client.js";

/**
 * WP-2423 item 8 ④ DEC-DINE-IN-SPLIT-BILL (Figma "分单 / AA · v3"): at checkout, staff choose how
 * the table pays — together, evenly by people, or each phone its own rounds (staff rounds can go to
 * any part) — and then collect each part with its own tip and method. The server computes every
 * part from the Order; the split is locked once a part is paid or a guest is paying.
 */
const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });

export const partMethodText = (method: "CardMachine" | "Cash" | "Online") =>
  method === "Cash" ? t("cash") : method === "Online" ? t("guest's phone") : t("card machine");

/** Each round's part by default: one part per phone, staff rounds with the first part. */
export function defaultRoundParts(bill: TableBill): ReadonlyMap<number, number> {
  const phones = [
    ...new Set(
      bill.rounds
        .filter((round) => round.totalMinor !== "0" && round.orderedBy !== null)
        .map((round) => round.orderedBy as number),
    ),
  ].sort((a, b) => a - b);
  return new Map(
    bill.rounds
      .filter((round) => round.totalMinor !== "0")
      .map((round) => [
        round.roundNumber,
        round.orderedBy === null ? 1 : phones.indexOf(round.orderedBy) + 1,
      ]),
  );
}

export function TableSplitControls({
  bill,
  csrf,
  client,
  disabled,
  selectedPart,
  onSelectPart,
  onBill,
  onProblem,
}: {
  readonly bill: TableBill;
  readonly csrf: string;
  readonly client: ReturnType<typeof createTableCheckoutClient>;
  readonly disabled: boolean;
  readonly selectedPart: number | null;
  readonly onSelectPart: (part: number | null) => void;
  readonly onBill: (bill: TableBill) => void;
  readonly onProblem: (text: string | null) => void;
}) {
  const split = bill.split;
  const locked =
    (split?.paidParts ?? 0) > 0 ||
    split?.parts.some((part) => part.guestPaying) === true ||
    bill.onlinePayment?.status === "InProgress";
  const [mode, setMode] = useState<"Whole" | "Even" | "ByRounds">(split?.mode ?? "Whole");
  const [people, setPeople] = useState(split?.mode === "Even" ? split.parts.length : 2);
  const [partOf, setPartOf] = useState<ReadonlyMap<number, number>>(() =>
    split?.mode === "ByRounds"
      ? new Map(
          split.parts.flatMap((part) =>
            part.roundNumbers.map((round) => [round, part.partNumber] as const),
          ),
        )
      : defaultRoundParts(bill),
  );
  const [busy, setBusy] = useState(false);
  const owing = bill.rounds.filter((round) => round.totalMinor !== "0");
  const apply = async (next: "Whole" | "Even" | "ByRounds", count = people) => {
    if (busy || disabled || locked) return;
    setBusy(true);
    onProblem(null);
    try {
      const updated = await client.split(csrf, {
        operationReference: serviceOperationReference(),
        diningSessionReference: bill.diningSessionReference,
        mode: next,
        people: next === "Even" ? count : null,
        rounds:
          next === "ByRounds"
            ? owing.map((round) => ({
                roundNumber: round.roundNumber,
                partNumber: partOf.get(round.roundNumber) ?? 1,
              }))
            : null,
      });
      onSelectPart(null);
      onBill(updated);
    } catch (error) {
      onProblem(
        error instanceof TableCheckoutError && error.code === "SplitLocked"
          ? t("A part is already paid or a guest is paying, so the split can't change now.")
          : t("The bill couldn't be split. Read the bill again and try once more."),
      );
    } finally {
      setBusy(false);
    }
  };
  const partCount = Math.max(1, ...owing.map((round) => partOf.get(round.roundNumber) ?? 1));
  const byRoundsValid =
    partCount >= 2 &&
    Array.from({ length: partCount }, (_, index) => index + 1).every((part) =>
      owing.some((round) => (partOf.get(round.roundNumber) ?? 1) === part),
    );
  return (
    <section className="table-split" aria-labelledby="table-split-title">
      <h4 id="table-split-title">{t("Split the bill")}</h4>
      {locked && split !== null ? (
        // Once a part is paid (or a guest is paying) the split stays as it is.
        <p className="table-split__locked">
          {split.mode === "Even"
            ? t("Split evenly · {count} parts", { count: String(split.parts.length) })
            : t("Each pays own rounds · {count} parts", { count: String(split.parts.length) })}
        </p>
      ) : (
        <div className="table-split__modes" role="group" aria-label={t("Split the bill")}>
          {(["Whole", "Even", "ByRounds"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={disabled || busy || locked}
              onClick={() => {
                setMode(value);
                if (value === "Whole" && split !== null) void apply("Whole");
              }}
            >
              {value === "Whole"
                ? t("All together")
                : value === "Even"
                  ? t("Split evenly")
                  : t("Each pays own rounds")}
            </button>
          ))}
        </div>
      )}
      {mode === "Even" && !locked ? (
        <div className="table-split__people">
          <span>{t("People")}</span>
          <button
            type="button"
            aria-label={t("Fewer people")}
            disabled={disabled || busy || people <= 2}
            onClick={() => setPeople((value) => Math.max(2, value - 1))}
          >
            −
          </button>
          <output aria-live="polite">{people}</output>
          <button
            type="button"
            aria-label={t("More people")}
            disabled={disabled || busy || people >= 20}
            onClick={() => setPeople((value) => Math.min(20, value + 1))}
          >
            +
          </button>
          <button
            type="button"
            className="table-split__apply"
            disabled={disabled || busy}
            onClick={() => void apply("Even")}
          >
            {split?.mode === "Even" && split.parts.length === people && !split.stale
              ? t("Split again")
              : t("Split in {count}", { count: String(people) })}
          </button>
        </div>
      ) : null}
      {mode === "ByRounds" && !locked ? (
        <div className="table-split__rounds">
          <p>{t("Each phone pays the rounds it sent; move a round to another part if needed.")}</p>
          <ul>
            {owing.map((round) => (
              <li key={round.roundNumber}>
                <span>
                  {t("Round {number}", { number: String(round.roundNumber) })} ·{" "}
                  {round.orderedBy === null
                    ? t("entered by staff")
                    : t("phone {number}", { number: String(round.orderedBy) })}{" "}
                  · {cad(round.totalMinor)}
                </span>
                <label>
                  <span className="sr-only">
                    {t("Part for round {number}", { number: String(round.roundNumber) })}
                  </span>
                  <select
                    value={partOf.get(round.roundNumber) ?? 1}
                    disabled={disabled || busy}
                    onChange={(event) =>
                      setPartOf(
                        new Map(partOf).set(round.roundNumber, Number(event.currentTarget.value)),
                      )
                    }
                  >
                    {Array.from({ length: Math.min(20, owing.length) }, (_, index) => (
                      <option key={index + 1} value={index + 1}>
                        {t("Part {number}", { number: String(index + 1) })}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="table-split__apply"
            disabled={disabled || busy || !byRoundsValid}
            onClick={() => void apply("ByRounds")}
          >
            {t("Split by rounds")}
          </button>
          {byRoundsValid ? null : (
            <p className="table-split__hint">{t("Use at least two parts, each with a round.")}</p>
          )}
        </div>
      ) : null}
      {split !== null ? (
        <>
          {split.stale ? (
            <p role="alert">
              {t("The bill changed after it was split. Split it again before taking payments.")}
            </p>
          ) : null}
          <ol className="table-split__parts" aria-label={t("Parts")}>
            {split.parts.map((part) => (
              <li key={part.partNumber} data-selected={selectedPart === part.partNumber}>
                <div>
                  <strong>
                    {t("Part {number}", { number: String(part.partNumber) })} ·{" "}
                    {cad(part.amountMinor)}
                  </strong>
                  <span
                    className="table-split__status"
                    data-tone={
                      part.payment !== null ? "done" : part.guestPaying ? "waiting" : "open"
                    }
                  >
                    {part.payment !== null
                      ? t("Paid {amount} · {method}", {
                          amount: cad(part.payment.totalMinor),
                          method: partMethodText(part.payment.method),
                        })
                      : part.guestPaying
                        ? t("A guest is paying on their phone")
                        : t("To collect")}
                  </span>
                </div>
                {part.payment === null && !part.guestPaying && !split.stale ? (
                  <button
                    type="button"
                    className="table-split__collect"
                    aria-pressed={selectedPart === part.partNumber}
                    disabled={disabled}
                    onClick={() =>
                      onSelectPart(selectedPart === part.partNumber ? null : part.partNumber)
                    }
                  >
                    {t("Collect this part")}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="table-split__progress">
            {t("{paid} of {count} parts paid · {amount} to go", {
              paid: String(split.paidParts),
              count: String(split.parts.length),
              amount: cad(split.remainingMinor),
            })}
          </p>
          <p className="table-split__hint">
            {t(
              "The table closes when every part is paid. If the network is down, take each part as usual, note the part number on paper and record it later.",
            )}
          </p>
        </>
      ) : null}
    </section>
  );
}
