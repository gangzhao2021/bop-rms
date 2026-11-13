import { useState } from "react";
import { t, saidTable } from "./i18n/i18n.js";
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

/**
 * Each round's part by default: one part per phone, staff rounds with the first part. WP-2423
 * item 8 ⑨: a table with tables merged into it pays one part per table — each table's rounds
 * (its phones' and those staff entered for it) together, this table's first.
 */
export function defaultRoundParts(bill: TableBill): ReadonlyMap<number, number> {
  const owing = bill.rounds.filter((round) => round.totalMinor !== "0");
  if (owing.some((round) => round.fromTableLabel !== null)) {
    const tables = [...new Set(owing.map((round) => round.fromTableLabel ?? ""))].sort((a, b) =>
      a === "" ? -1 : b === "" ? 1 : 0,
    );
    return new Map(
      owing.map((round) => [round.roundNumber, tables.indexOf(round.fromTableLabel ?? "") + 1]),
    );
  }
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
  // Rounds only divide a bill between people when different phones or merged tables sent them.
  const offersByRounds =
    split?.mode === "ByRounds" || new Set(defaultRoundParts(bill).values()).size >= 2;
  const [mode, setMode] = useState<"Whole" | "Even" | "ByRounds" | "ByItems">(
    split === null || split.mode === "ByGuests" ? "Whole" : split.mode,
  );
  const owingUnits = bill.rounds
    .filter((round) => round.totalMinor !== "0")
    .flatMap((round) =>
      round.items.flatMap((item) =>
        Array.from({ length: item.quantity }, (_, index) => ({
          orderItemReference: item.orderItemReference,
          unit: index + 1,
          quantity: item.quantity,
          displayName: item.displayName,
          unitMinor: BigInt(item.totalMinor) / BigInt(item.quantity),
        })),
      ),
    );
  const [dishPart, setDishPart] = useState<ReadonlyMap<string, number | null>>(
    () =>
      new Map(
        (split?.dishChoices ?? []).map((choice) => [
          `${choice.orderItemReference}:${choice.unit}`,
          choice.partNumber,
        ]),
      ),
  );
  const partOfUnit = (key: string) => {
    const part = dishPart.get(key) ?? null;
    return part !== null && part <= people ? part : null;
  };
  const [people, setPeople] = useState(
    split?.mode === "Even" || split?.mode === "ByItems" ? split.parts.length : 2,
  );
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
  const apply = async (next: "Whole" | "Even" | "ByRounds" | "ByItems", count = people) => {
    if (busy || disabled || locked) return;
    setBusy(true);
    onProblem(null);
    try {
      const updated = await client.split(csrf, {
        operationReference: serviceOperationReference(),
        diningSessionReference: bill.diningSessionReference,
        mode: next,
        people: next === "Even" || next === "ByItems" ? count : null,
        rounds:
          next === "ByRounds"
            ? owing.map((round) => ({
                roundNumber: round.roundNumber,
                partNumber: partOf.get(round.roundNumber) ?? 1,
              }))
            : null,
        dishes:
          next === "ByItems"
            ? owingUnits.map((unit) => ({
                orderItemReference: unit.orderItemReference,
                unit: unit.unit,
                partNumber: partOfUnit(`${unit.orderItemReference}:${unit.unit}`),
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
  const evenApplied = split?.mode === "Even" && split.parts.length === people && !split.stale;
  const changePeople = (count: number) => {
    setPeople(count);
    if (mode === "Even") void apply("Even", count);
  };
  const chosenParts = new Set(
    owingUnits.map((unit) => partOfUnit(`${unit.orderItemReference}:${unit.unit}`)),
  );
  // Every part pays for something: a dish of its own, or its share of one.
  const byItemsValid =
    chosenParts.has(null) ||
    Array.from({ length: people }, (_, index) => index + 1).every((part) => chosenParts.has(part));
  const byItemsApplied =
    split?.mode === "ByItems" &&
    !split.stale &&
    split.parts.length === people &&
    owingUnits.every(
      (unit) =>
        split.dishChoices.find(
          (choice) =>
            choice.orderItemReference === unit.orderItemReference && choice.unit === unit.unit,
        )?.partNumber === partOfUnit(`${unit.orderItemReference}:${unit.unit}`),
    );
  const partCount = Math.max(1, ...owing.map((round) => partOf.get(round.roundNumber) ?? 1));
  const byRoundsValid =
    partCount >= 2 &&
    Array.from({ length: partCount }, (_, index) => index + 1).every((part) =>
      owing.some((round) => (partOf.get(round.roundNumber) ?? 1) === part),
    );
  // WP-2423 同桌结账: guests paying by dish on their phones — what each paid or is paying, and the
  // rest staff take at the counter (below, as the table's payment).
  if (split !== null && split.mode === "ByGuests" && split.parts.length > 0)
    return (
      <section className="table-split" aria-labelledby="table-split-title">
        <h4 id="table-split-title">{t("Guests paying by dish")}</h4>
        <ol className="table-split__parts" aria-label={t("Payments by dish")}>
          {split.parts.map((part) => (
            <li key={part.partNumber}>
              <div>
                <strong>{cad(part.amountMinor)}</strong>
                <span
                  className="table-split__status"
                  data-tone={part.payment !== null ? "done" : part.guestPaying ? "waiting" : "open"}
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
                <span className="table-split__dishes">
                  {part.dishes
                    .map(
                      (dish) => (dish.quantity > 1 ? `${dish.quantity} × ` : "") + dish.displayName,
                    )
                    .join(", ")}
                </span>
              </div>
            </li>
          ))}
        </ol>
        <p className="table-split__progress">
          {split.paidInFull
            ? t("Every dish is paid.")
            : split.restUnavailable
              ? t(
                  "We couldn't work out what is left to pay just now. Refresh the bill and try again.",
                )
              : split.restMinor === null
                ? t("Every dish is chosen; waiting for the guests' payments to finish.")
                : t("Not chosen yet · {amount}. Take it at the counter below.", {
                    amount: cad(split.restMinor),
                  })}
        </p>
        <p className="table-split__hint">
          {t(
            "Each dish is paid once. If a guest's card fails, their dishes come back here. If the network is down, take the rest as usual and record it later.",
          )}
        </p>
      </section>
    );
  return (
    <section className="table-split" aria-labelledby="table-split-title">
      <h4 id="table-split-title">{t("Split the bill")}</h4>
      {locked && split !== null ? (
        // Once a part is paid (or a guest is paying) the split stays as it is.
        <p className="table-split__locked">
          {split.mode === "Even"
            ? t("Split evenly · {count} parts", { count: String(split.parts.length) })
            : split.mode === "ByItems"
              ? t("By dish · {count} parts", { count: String(split.parts.length) })
              : t("Each pays own rounds · {count} parts", { count: String(split.parts.length) })}
        </p>
      ) : (
        <div className="table-split__modes" role="group" aria-label={t("Split the bill")}>
          {(offersByRounds
            ? (["Whole", "Even", "ByItems", "ByRounds"] as const)
            : (["Whole", "Even", "ByItems"] as const)
          ).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={disabled || busy || locked}
              onClick={() => {
                setMode(value);
                if (value === "Whole" && split !== null) void apply("Whole");
                if (value === "Even" && !evenApplied) void apply("Even");
              }}
            >
              {value === "Whole"
                ? t("All together")
                : value === "Even"
                  ? t("Split evenly")
                  : value === "ByItems"
                    ? t("By dish")
                    : t("Each pays own rounds")}
            </button>
          ))}
        </div>
      )}
      {(mode === "Even" || mode === "ByItems") && !locked ? (
        <div className="table-split__people">
          <span>{t("People")}</span>
          <button
            type="button"
            aria-label={t("Fewer people")}
            disabled={disabled || busy || people <= 2}
            onClick={() => changePeople(people - 1)}
          >
            −
          </button>
          <output aria-live="polite">{people}</output>
          <button
            type="button"
            aria-label={t("More people")}
            disabled={disabled || busy || people >= 20}
            onClick={() => changePeople(people + 1)}
          >
            +
          </button>
          {/* Choosing Even or a number splits at once; this remains to retry or follow a bill change. */}
          {mode !== "Even" || evenApplied || busy ? null : (
            <button
              type="button"
              className="table-split__apply"
              disabled={disabled}
              onClick={() => void apply("Even")}
            >
              {split?.mode === "Even" && split.parts.length === people
                ? t("Split again")
                : t("Split in {count}", { count: String(people) })}
            </button>
          )}
        </div>
      ) : null}
      {mode === "ByItems" && !locked ? (
        <div className="table-split__rounds">
          <ul aria-label={t("Dishes")}>
            {owingUnits.map((unit) => {
              const key = `${unit.orderItemReference}:${unit.unit}`;
              const name =
                unit.quantity === 1
                  ? unit.displayName
                  : `${unit.displayName} (${unit.unit}/${unit.quantity})`;
              return (
                <li key={key}>
                  <span>
                    {name} · {cad(unit.unitMinor.toString())}
                  </span>
                  <label>
                    <span className="sr-only">{t("Who pays for {dish}", { dish: name })}</span>
                    <select
                      value={partOfUnit(key) ?? 0}
                      disabled={disabled || busy}
                      onChange={(event) => {
                        const value = Number(event.currentTarget.value);
                        setDishPart(new Map(dishPart).set(key, value === 0 ? null : value));
                      }}
                    >
                      <option value={0}>{t("Everyone shares")}</option>
                      {Array.from({ length: people }, (_, index) => (
                        <option key={index + 1} value={index + 1}>
                          {t("Part {number}", { number: String(index + 1) })}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              );
            })}
          </ul>
          {byItemsApplied ? null : (
            <button
              type="button"
              className="table-split__apply"
              disabled={disabled || busy || !byItemsValid}
              onClick={() => void apply("ByItems")}
            >
              {t("Split this way")}
            </button>
          )}
          {byItemsValid ? null : (
            <p className="table-split__hint">
              {t("Give every part a dish, or let everyone share one.")}
            </p>
          )}
        </div>
      ) : null}
      {mode === "ByRounds" && !locked ? (
        <div className="table-split__rounds">
          <p>
            {owing.some((round) => round.fromTableLabel !== null)
              ? t(
                  "Each table that was merged pays its own rounds; move a round to another part if needed.",
                )
              : t("Each phone pays the rounds it sent; move a round to another part if needed.")}
          </p>
          <ul>
            {owing.map((round) => (
              <li key={round.roundNumber}>
                <span>
                  {t("Round {number}", { number: String(round.roundNumber) })} ·{" "}
                  {round.orderedBy === null
                    ? t("entered by staff")
                    : t("phone {number}", { number: String(round.orderedBy) })}{" "}
                  {round.fromTableLabel === null
                    ? null
                    : t("· from table {table}", { table: saidTable(round.fromTableLabel) }) + " "}
                  {/* DEC-TAX-WHOLE-RECEIPT: with its share of the bill's tax rounding, so the
                      parts add up to the bill (checkout lists rounds as ordered). */}
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
          {owing.length === 1 ? (
            <p className="table-split__hint">
              {t(
                "This table has one round, so it can't be split by rounds. Split it evenly instead.",
              )}
            </p>
          ) : byRoundsValid ? null : (
            <p className="table-split__hint">{t("Use at least two parts, each with a round.")}</p>
          )}
        </div>
      ) : null}
      {split !== null && split.stale ? (
        // b13: a split the bill outgrew (a comp before any part was paid) lists no old parts: their
        // amounts no longer add up to the bill, so only the whole bill as it stands is said.
        <p role="alert">
          {t(
            "The bill changed after it was split: it is now {amount} for the whole table. Split it again before taking payments.",
            { amount: cad(split.remainingMinor) },
          )}
        </p>
      ) : split !== null ? (
        <>
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
                  {part.dishes.length === 0 ? null : (
                    <span className="table-split__dishes">
                      {part.dishes
                        .map(
                          (dish) =>
                            (dish.quantity > 1 ? `${dish.quantity} × ` : "") +
                            dish.displayName +
                            (dish.shared ? ` (${t("shared")})` : ""),
                        )
                        .join(", ")}
                    </span>
                  )}
                </div>
                {part.payment === null && !part.guestPaying ? (
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
