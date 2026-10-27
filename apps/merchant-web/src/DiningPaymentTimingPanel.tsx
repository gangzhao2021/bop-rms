import { t } from "./i18n/i18n.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { serviceOperationReference } from "./service-control-client.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (Owner 2026-10-26): when dine-in guests pay — before each round
 * goes to the kitchen, or once for the whole table at the end. Shown to whoever edits the Store's
 * settings (Owner, Store Manager); a change applies to tables opened after it, never to tables
 * already open. It is a setting, not money: saved in one step, no confirmation box.
 */
export type DiningPaymentTiming = "PayFirst" | "PayLater";
export interface DiningPaymentTimingView {
  readonly paymentTiming: DiningPaymentTiming;
  readonly version: number;
  readonly changedAt: string | null;
}
export class DiningPaymentTimingError extends Error {
  constructor(readonly code: "PermissionDenied" | "Unavailable") {
    super("dining payment timing unavailable");
  }
}
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export function parseDiningPaymentTimingView(value: unknown): DiningPaymentTimingView {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DiningPaymentTimingError("Unavailable");
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "changedAt,paymentTiming,version")
    throw new DiningPaymentTimingError("Unavailable");
  if (
    (raw.paymentTiming !== "PayFirst" && raw.paymentTiming !== "PayLater") ||
    typeof raw.version !== "number" ||
    !Number.isSafeInteger(raw.version) ||
    raw.version < 0 ||
    (raw.changedAt !== null && (typeof raw.changedAt !== "string" || !instant.test(raw.changedAt)))
  )
    throw new DiningPaymentTimingError("Unavailable");
  return Object.freeze({
    paymentTiming: raw.paymentTiming,
    version: raw.version,
    changedAt: raw.changedAt as string | null,
  });
}

export function createDiningPaymentTimingClient(fetcher: typeof fetch = fetch) {
  const post = async (path: string, csrf: string, body: unknown, signal?: AbortSignal) => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new DiningPaymentTimingError("Unavailable");
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: signal ?? null,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new DiningPaymentTimingError("Unavailable");
    }
    if (response.status === 401 || response.status === 403)
      throw new DiningPaymentTimingError("PermissionDenied");
    if (!response.ok || response.headers.get("cache-control") !== "no-store")
      throw new DiningPaymentTimingError("Unavailable");
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new DiningPaymentTimingError("Unavailable");
    }
  };
  return Object.freeze({
    async load(csrf: string, signal?: AbortSignal) {
      return parseDiningPaymentTimingView(
        await post("/merchant/dining/payment-timing", csrf, {}, signal),
      );
    },
    async change(
      csrf: string,
      command: {
        readonly operationReference: string;
        readonly paymentTiming: DiningPaymentTiming;
        readonly expectedVersion: number;
      },
    ) {
      const raw = await post("/merchant/dining/payment-timing/change", csrf, command);
      if (raw === null || typeof raw !== "object")
        throw new DiningPaymentTimingError("Unavailable");
      const { status, timing } = raw as { status?: unknown; timing?: unknown };
      if (status !== "Changed" && status !== "AlreadyChanged" && status !== "Conflict")
        throw new DiningPaymentTimingError("Unavailable");
      return Object.freeze({ status, timing: parseDiningPaymentTimingView(timing) });
    },
  });
}

export function DiningPaymentTimingPanel({
  csrf,
  fetcher,
}: {
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createDiningPaymentTimingClient(fetcher), [fetcher]);
  const [view, setView] = useState<DiningPaymentTimingView | null>(null);
  const [state, setState] = useState<
    "Loading" | "Ready" | "Saving" | "PermissionDenied" | "Unavailable"
  >("Loading");
  const [chosen, setChosen] = useState<DiningPaymentTiming | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A lost answer is sent again with the same operation, so it is never applied twice.
  const operation = useRef<{ key: string; reference: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client.load(csrf, controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) return;
        setView(loaded);
        setChosen(loaded.paymentTiming);
        setState("Ready");
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState(
          error instanceof DiningPaymentTimingError && error.code === "PermissionDenied"
            ? "PermissionDenied"
            : "Unavailable",
        );
      },
    );
    return () => controller.abort();
  }, [client, csrf]);
  // Only people who may change it see it (the server checks again).
  if (state === "PermissionDenied") return null;
  const save = async () => {
    if (view === null || chosen === null || state === "Saving") return;
    const key = `${chosen}:${view.version}`;
    if (operation.current?.key !== key)
      operation.current = { key, reference: serviceOperationReference() };
    setState("Saving");
    setMessage(null);
    try {
      const result = await client.change(csrf, {
        operationReference: operation.current.reference,
        paymentTiming: chosen,
        expectedVersion: view.version,
      });
      operation.current = null;
      setView(result.timing);
      setChosen(result.timing.paymentTiming);
      setMessage(
        result.status === "Conflict"
          ? t("Someone changed it meanwhile. This is the current choice; choose again if needed.")
          : t("Saved. Tables opened from now on use it; tables already open keep theirs."),
      );
    } catch {
      setMessage(t("Not saved. Check your connection and save again."));
    } finally {
      setState("Ready");
    }
  };
  const option = (value: DiningPaymentTiming, title: string, detail: string) => (
    <label className="dining-payment-timing__option">
      <input
        type="radio"
        name="dining-payment-timing"
        value={value}
        checked={chosen === value}
        disabled={state !== "Ready"}
        onChange={() => setChosen(value)}
      />
      <span>
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
    </label>
  );
  return (
    <section className="dining-payment-timing" aria-labelledby="dining-payment-timing-title">
      <h2 id="dining-payment-timing-title">{t("Dine-in payment")}</h2>
      {state === "Loading" ? (
        <p role="status">{t("Loading…")}</p>
      ) : state === "Unavailable" || view === null ? (
        <p role="status">{t("The dine-in payment setting could not be read. Refresh to retry.")}</p>
      ) : (
        <>
          <fieldset>
            <legend className="visually-hidden">{t("When dine-in guests pay")}</legend>
            {option(
              "PayLater",
              t("Pay at the end"),
              t(
                "Guests order rounds that go straight to the kitchen. Staff take one payment for the whole table at the end, on the card machine or in cash.",
              ),
            )}
            {option(
              "PayFirst",
              t("Pay before each round"),
              t("Each round is paid before it goes to the kitchen."),
            )}
          </fieldset>
          <button
            type="button"
            className="dining-payment-timing__save"
            disabled={state !== "Ready" || chosen === view.paymentTiming}
            onClick={() => void save()}
          >
            {state === "Saving" ? t("Saving…") : t("Save")}
          </button>
          <p className="dining-payment-timing__note">
            {t("A change applies to tables opened after it; tables already open keep theirs.")}
          </p>
        </>
      )}
      <p role="status" className="dining-payment-timing__message">
        {message}
      </p>
    </section>
  );
}
