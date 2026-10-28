import { t } from "./i18n/i18n.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { orderWhen } from "./CurrentOrderQueuePage.js";
import { serviceOperationReference } from "./service-control-client.js";
import { useStoreBusinessDay } from "./StoreBusinessDay.js";
import type { StaffHeldRound } from "./dining-session-client.js";
import { heldRoundReasonText } from "./table-needs.js";
import {
  createHeldRoundClient,
  createTablePhonesClient,
  TablePhonesError,
  type TablePhone,
  type TablePhones,
} from "./table-phones-client.js";

/** Decision 3: a phone that joined in the last 10 minutes is pointed out to staff. */
export const newPhoneMinutes = 10;

export function newPhones(phones: readonly TablePhone[], now: number): readonly TablePhone[] {
  return phones.filter(
    (phone) => !phone.left && now - Date.parse(phone.joinedAt) < newPhoneMinutes * 60_000,
  );
}

/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN (decisions 2–4): on the table page, the phones at the
 * table, numbered in the order they joined. A phone that just joined is pointed out, with
 * "Remove phone N from this table" and "Pause joining by scan" right there. Staff can pause or resume
 * joining by scan at any time; while paused, new guests need a code from staff or the host.
 */
export function TablePanelPhones({
  diningSessionReference,
  csrf,
  timeZone,
  now,
  locked,
  refreshKey,
  onRounds,
  fetcher,
}: {
  readonly diningSessionReference: string;
  readonly csrf: string;
  readonly timeZone: string | undefined;
  readonly now: number;
  readonly locked: boolean;
  readonly refreshKey: string;
  /** Which phone sent each round, for the round headings. */
  readonly onRounds?: ((rounds: ReadonlyMap<string, number | null>) => void) | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createTablePhonesClient(fetcher), [fetcher]);
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const [state, setState] = useState<TablePhones | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  // One reference per intended change, kept until it is answered (pressing again never repeats it).
  const pending = useRef<{ readonly key: string; readonly reference: string } | null>(null);
  const roundsRef = useRef(onRounds);
  roundsRef.current = onRounds;
  useEffect(() => {
    const controller = new AbortController();
    void client
      .read(csrf, diningSessionReference, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setState(next);
        roundsRef.current?.(next.rounds);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof TablePhonesError && error.code === "PermissionDenied") setHidden(true);
        else
          setProblem(
            t("The phones at this table could not be read. They are read again with the table."),
          );
      });
    return () => controller.abort();
  }, [client, csrf, diningSessionReference, refreshKey]);
  if (hidden || state === null)
    return problem ? <p className="table-panel__notice">{problem}</p> : null;
  const run = async (key: string, action: (reference: string) => Promise<TablePhones>) => {
    if (busy) return;
    if (pending.current?.key !== key)
      pending.current = { key, reference: serviceOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const next = await action(pending.current.reference);
      pending.current = null;
      setConfirming(null);
      setState(next);
      roundsRef.current?.(next.rounds);
    } catch (error) {
      setProblem(
        error instanceof TablePhonesError && error.code === "OutcomeUnknown"
          ? t(
              "We couldn't confirm the result. Check the connection and press the button again: it is never recorded twice.",
            )
          : t("That didn't go through. Read the table again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  const pause = (paused: boolean) =>
    void run(paused ? "pause" : "resume", (operationReference) =>
      client.setPaused(csrf, { diningSessionReference, paused, operationReference }),
    );
  const remove = (phone: TablePhone) =>
    void run("remove:" + phone.participantReference, (operationReference) =>
      client.remove(csrf, {
        diningSessionReference,
        participantReference: phone.participantReference,
        operationReference,
      }),
    );
  const fresh = newPhones(state.phones, now);
  const disabled = locked || busy;
  const atTable = state.phones.filter((phone) => !phone.left).length;
  return (
    <section className="table-phones" aria-label={t("Phones at this table")}>
      {fresh.map((phone) => (
        <div key={phone.participantReference} className="table-phones__new" role="note">
          <p>{t("Phone {number} just joined.", { number: String(phone.phoneNumber) })}</p>
          {confirming === phone.participantReference ? null : (
            <div className="table-phones__actions">
              <button
                type="button"
                disabled={disabled}
                onClick={() => setConfirming(phone.participantReference)}
              >
                {t("Remove phone {number} from this table", { number: String(phone.phoneNumber) })}
              </button>
              {state.paused ? null : (
                <button type="button" disabled={disabled} onClick={() => pause(true)}>
                  {t("Pause joining by scan")}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      <header className="table-phones__head">
        <h3>
          {atTable === 1
            ? t("1 phone at this table")
            : t("{count} phones at this table", { count: String(atTable) })}
        </h3>
        <button type="button" disabled={disabled} onClick={() => pause(!state.paused)}>
          {state.paused ? t("Resume joining by scan") : t("Pause joining by scan")}
        </button>
      </header>
      <p className="table-phones__mode">
        {state.paused
          ? t("Joining by scan is paused. New guests need a table code from you or the host.")
          : t("Guests join by scanning the table's QR code.")}
      </p>
      <ul className="table-phones__list">
        {state.phones.map((phone) => (
          <li key={phone.participantReference}>
            <span>
              {t("Phone {number}", { number: String(phone.phoneNumber) })}
              {" · "}
              {phone.removed
                ? t("removed")
                : phone.left
                  ? t("left")
                  : t("joined {time}", { time: orderWhen(phone.joinedAt, timeZone, today) })}
            </span>
            {phone.left ? null : confirming === phone.participantReference ? (
              <span className="table-phones__confirm" role="group">
                <span>
                  {t(
                    "Remove phone {number}? It can no longer see this table or order. Its rounds stay on the bill.",
                    { number: String(phone.phoneNumber) },
                  )}
                </span>
                <button type="button" onClick={() => setConfirming(null)}>
                  {t("Keep")}
                </button>
                <button
                  type="button"
                  className="table-phones__danger"
                  disabled={disabled}
                  onClick={() => remove(phone)}
                >
                  {t("Remove phone {number}", { number: String(phone.phoneNumber) })}
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={() => setConfirming(phone.participantReference)}
              >
                {t("Remove phone {number} from this table", { number: String(phone.phoneNumber) })}
              </button>
            )}
          </li>
        ))}
      </ul>
      {problem ? (
        <p className="table-panel__notice" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/**
 * WP-2423 item 8 ⑤ decisions 5–7: guest rounds at this table waiting for staff before the
 * kitchen. Nothing sends or cancels them on their own; staff "Send to kitchen" or "Cancel this
 * round" (asked once more; it stays on the records as cancelled, nothing was made or paid).
 */
export function TableHeldRounds({
  rounds,
  csrf,
  timeZone,
  locked,
  onChanged,
  fetcher,
}: {
  readonly rounds: readonly StaffHeldRound[];
  readonly csrf: string;
  readonly timeZone: string | undefined;
  readonly locked: boolean;
  readonly onChanged: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createHeldRoundClient(fetcher), [fetcher]);
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = useRef<{ readonly key: string; readonly reference: string } | null>(null);
  if (rounds.length === 0) return null;
  const decide = async (round: StaffHeldRound, action: "Confirm" | "Cancel") => {
    if (busy) return;
    const key = action + ":" + round.orderBatchReference;
    if (pending.current?.key !== key)
      pending.current = { key, reference: serviceOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      await client.decide(csrf, {
        action,
        orderReference: round.orderReference,
        orderBatchReference: round.orderBatchReference,
        operationReference: pending.current.reference,
      });
      pending.current = null;
      setConfirming(null);
      onChanged();
    } catch (error) {
      setProblem(
        error instanceof TablePhonesError && error.code === "OutcomeUnknown"
          ? t(
              "We couldn't confirm the result. Check the connection and press the button again: it is never recorded twice.",
            )
          : t("That didn't go through. Read the table again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  const name = (round: StaffHeldRound) =>
    round.roundNumber === null
      ? t("A round")
      : t("Round {number}", { number: String(round.roundNumber) });
  return (
    <section className="table-held-rounds" aria-label={t("Rounds waiting for your OK")}>
      {rounds.map((round) => (
        <div key={round.orderBatchReference} className="table-held-rounds__round">
          <p>
            <strong>{t("{round} is waiting for your OK", { round: name(round) })}</strong> ·{" "}
            {heldRoundReasonText(round.reason)} · {orderWhen(round.heldAt, timeZone, today)}
          </p>
          <p className="table-held-rounds__note">
            {t(
              "It has not gone to the kitchen. Check it with the table, then send it or cancel it.",
            )}
          </p>
          {confirming === round.orderBatchReference ? (
            <div className="table-held-rounds__actions" role="group">
              <span>
                {t(
                  "Cancel {round}? Nothing was made or paid; it stays on the records as cancelled.",
                  { round: name(round).toLowerCase() },
                )}
              </span>
              <button type="button" onClick={() => setConfirming(null)}>
                {t("Keep")}
              </button>
              <button
                type="button"
                className="table-phones__danger"
                disabled={locked || busy}
                onClick={() => void decide(round, "Cancel")}
              >
                {t("Cancel this round")}
              </button>
            </div>
          ) : (
            <div className="table-held-rounds__actions">
              <button
                type="button"
                className="table-held-rounds__send"
                disabled={locked || busy}
                onClick={() => void decide(round, "Confirm")}
              >
                {t("Send to kitchen")}
              </button>
              <button
                type="button"
                disabled={locked || busy}
                onClick={() => setConfirming(round.orderBatchReference)}
              >
                {t("Cancel this round")}
              </button>
            </div>
          )}
        </div>
      ))}
      {problem ? (
        <p className="table-panel__notice" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/**
 * WP-2423 item 8 ⑤ decision 5: the Store's "a new phone's first round waits for staff" (tables
 * that pay at the end). Everyone running tables sees it; a manager changes it.
 */
export function RoundHoldSettingControl({
  csrf,
  locked,
  fetcher,
}: {
  readonly csrf: string;
  readonly locked: boolean;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createHeldRoundClient(fetcher), [fetcher]);
  const [setting, setSetting] = useState<{
    readonly version: number;
    readonly firstRoundNeedsStaff: boolean;
    readonly canChange: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void client
      .setting(csrf)
      .then((value) => {
        if (live) setSetting(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, csrf]);
  if (setting === null) return null;
  const change = async (on: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      setSetting(
        await client.setting(csrf, {
          expectedVersion: setting.version,
          firstRoundNeedsStaff: on,
          operationReference: serviceOperationReference(),
        }),
      );
    } catch {
      setProblem(t("That didn't go through. Read the table again and retry."));
      setSetting(await client.setting(csrf).catch(() => setting));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="round-hold-setting" aria-label={t("Ordering from guests' phones")}>
      <label>
        <input
          type="checkbox"
          checked={setting.firstRoundNeedsStaff}
          disabled={!setting.canChange || locked || busy}
          onChange={(event) => void change(event.target.checked)}
        />{" "}
        {t("A new phone's first round waits for staff OK before the kitchen")}
      </label>
      <p className="round-hold-setting__note">
        {setting.canChange
          ? t(
              "Tables that pay at the end. Rapid ordering always waits: a phone's 4th round or a table's 7th within 10 minutes.",
            )
          : t("A manager changes this.")}
      </p>
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}

/**
 * WP-2423 item 8 ⑤ decision 4: which phone sent each round of a table's Order (Orders page), read
 * from the table's phone list. Empty while it is read, for staff who may not read it, or on error.
 */
export function useRoundPhones(
  csrf: string | null,
  diningSessionReference: string | null,
  fetcher?: typeof fetch,
): ReadonlyMap<string, number | null> {
  const client = useMemo(() => createTablePhonesClient(fetcher), [fetcher]);
  const [rounds, setRounds] = useState<ReadonlyMap<string, number | null>>(new Map());
  useEffect(() => {
    if (csrf === null || diningSessionReference === null) return;
    const controller = new AbortController();
    void client
      .read(csrf, diningSessionReference, controller.signal)
      .then((state) => {
        if (!controller.signal.aborted) setRounds(state.rounds);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, csrf, diningSessionReference]);
  return rounds;
}

/** Render-prop form of `useRoundPhones` for places that render inside a callback. */
export function WithRoundPhones({
  csrf,
  diningSessionReference,
  fetcher,
  children,
}: {
  readonly csrf: string | null;
  readonly diningSessionReference: string | null;
  readonly fetcher?: typeof fetch | undefined;
  readonly children: (phones: ReadonlyMap<string, number | null>) => React.ReactNode;
}) {
  return <>{children(useRoundPhones(csrf, diningSessionReference, fetcher))}</>;
}
