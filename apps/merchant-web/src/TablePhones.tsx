import { t } from "./i18n/i18n.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { orderWhen } from "./CurrentOrderQueuePage.js";
import { serviceOperationReference } from "./service-control-client.js";
import { useStoreBusinessDay } from "./StoreBusinessDay.js";
import {
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
 * "Remove from this table" and "Pause joining by scan" right there. Staff can pause or resume
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
                {t("Remove from this table")}
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
                {t("Remove from this table")}
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
