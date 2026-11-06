import { displayLocale, t } from "./i18n/i18n.js";
import { useEffect, useRef, useState } from "react";
import {
  createDiningHostTransferClient,
  DiningHostClientError,
  type DiningHostSelection,
} from "./dining-host-transfer-client.js";
import { serviceOperationReference } from "./service-control-client.js";
type Operation = ReturnType<ReturnType<typeof createDiningHostTransferClient>["prepare"]>;
export function DiningHostTransferAction({
  diningSessionReference,
  csrf,
  disabled,
  onLocked,
}: {
  readonly diningSessionReference: string;
  readonly csrf: string;
  readonly disabled: boolean;
  readonly onLocked: (locked: boolean) => void;
}) {
  const [source, setSource] = useState<DiningHostSelection | null>(null),
    [target, setTarget] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [state, setState] = useState<"Idle" | "Loading" | "Submitting" | "Unknown">("Idle"),
    [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null),
    operation = useRef<Operation | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const locked = disabled || state !== "Idle";
  const load = async () => {
    if (disabled || pending.current || operation.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Loading");
    onLocked(true);
    setSource(null);
    setTarget("");
    setConfirmed(false);
    setMessage("");
    try {
      const result = await createDiningHostTransferClient().selection(
        diningSessionReference,
        csrf,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setSource(result);
        if (!result.participants.some((p) => !p.isHost))
          setMessage(
            t(
              "No other active participants are available. Ask the guest to join this table first.",
            ),
          );
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(
          error instanceof DiningHostClientError && error.code === "Denied"
            ? t("Your current permissions do not allow host transfer.")
            : t("Participants unavailable. Refresh to try again."),
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!controller.signal.aborted) {
          setState("Idle");
          onLocked(false);
        }
      }
    }
  };
  const execute = async () => {
    if (
      disabled ||
      pending.current ||
      (!operation.current && (!source || !target || !confirmed || state !== "Idle"))
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    onLocked(true);
    setMessage("");
    let unresolved = false;
    try {
      if (!operation.current) {
        if (!source) return;
        operation.current = createDiningHostTransferClient().prepare(
          source,
          target,
          serviceOperationReference(),
        );
      }
      const result = await operation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        operation.current = null;
        setSource(null);
        setTarget("");
        setConfirmed(false);
        setMessage(
          t("Recorded at {value}. Refresh phones to see which phone sends the cart.", {
            value: new Date(result.transferredAt).toLocaleString(displayLocale()),
          }),
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        unresolved = error instanceof DiningHostClientError && error.code === "Unknown";
        if (!unresolved) {
          operation.current = null;
          setSource(null);
          setTarget("");
          setConfirmed(false);
        }
        setMessage(
          unresolved
            ? t(
                "The result is unknown. Retry the same host transfer before choosing another table or operation.",
              )
            : error instanceof DiningHostClientError && error.code === "Denied"
              ? t("Your access doesn't allow moving the host. Ask a manager.")
              : t("The host wasn't moved. Refresh the guests and try again."),
        );
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!controller.signal.aborted) {
          setState(unresolved ? "Unknown" : "Idle");
          onLocked(unresolved);
        }
      }
    }
  };
  return (
    <section aria-label={t("Dining host transfer")}>
      {/* M144: guest words, not "host" or "participant". */}
      <h3>{t("Who can send the table's cart")}</h3>
      <p>
        {t(
          "One phone sends the table's shared cart to the kitchen. You can let another phone send it.",
        )}
      </p>
      <button disabled={locked} onClick={() => void load()}>
        {t("Refresh phones")}
      </button>
      {source ? (
        <>
          <ul>
            {source.participants.map((p, index) => (
              <li key={p.participantReference}>
                {t("Phone {value} · Joined {value2}{value3}", {
                  value: index + 1,
                  value2: new Date(p.joinedAt).toLocaleString(displayLocale()),
                  value3: p.isHost ? t(" · Sends the cart") : "",
                })}
              </li>
            ))}
          </ul>
          <label>
            {t("Phone that sends the cart")}
            <select
              value={target}
              disabled={locked}
              onChange={(event) => {
                setTarget(event.target.value);
                setConfirmed(false);
              }}
            >
              <option value="">{t("Choose a phone")}</option>
              {source.participants.map((p, index) =>
                p.isHost ? null : (
                  <option key={p.participantReference} value={p.participantReference}>
                    {t("Phone {value} · Joined {value2}", {
                      value: index + 1,
                      value2: new Date(p.joinedAt).toLocaleString(displayLocale()),
                    })}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked || !target}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t("I checked with the guest holding this phone")}
          </label>
        </>
      ) : null}
      <button
        disabled={
          disabled ||
          state === "Loading" ||
          state === "Submitting" ||
          (state !== "Unknown" && (!source || !target || !confirmed))
        }
        onClick={() => void execute()}
      >
        {state === "Unknown"
          ? t("Retry same host transfer")
          : state === "Submitting"
            ? t("Transferring…")
            : t("Let this phone send the cart")}
      </button>
      <p role="status">{state === "Loading" ? t("Loading participants…") : message}</p>
    </section>
  );
}
