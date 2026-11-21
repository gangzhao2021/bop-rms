import { useEffect, useState } from "react";
import { formatContactPhone } from "./contact-phone.js";
import { t } from "./i18n/i18n.js";
import { timeLeftWords } from "./operations-alert-words.js";
import { useStaffSessionLive } from "./staff-session-reads.js";

/**
 * AGENTS.md "Warn before timeouts": in its last day, ordering at this Store is about to stop because
 * BOP has not renewed it. The Owner and Store Manager have a row on Home; everyone else works on
 * Tables, Kitchen, Orders and Pickup, and must not learn it from guests. Any signed-in staff member of
 * the Store reads this one fact (DEC-PILOT-ALERTS-BACKUP correction 2), never the alert board.
 */
export interface OrderingEnding {
  readonly endsAt: string;
  readonly support: { readonly phone: string; readonly testOnly: boolean } | null;
}

/** The fact appears a day ahead and leaves minutes after a renewal: no need to ask each minute. */
export const ORDERING_ENDING_READ_MS = 5 * 60_000;
const COUNTDOWN_MS = 60_000;

const invalid = (): never => {
  throw new Error("ORDERING_ENDING_UNAVAILABLE");
};
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
    ? (value as Record<string, unknown>)
    : invalid();

/** The server's answer; null when ordering is not about to stop. Anything else is refused. */
export function parseOrderingEnding(value: unknown): OrderingEnding | null {
  const answer = exact(value, ["endsAt", "support"]);
  if (answer.endsAt === null) return null;
  if (
    typeof answer.endsAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u.test(answer.endsAt) ||
    !Number.isFinite(Date.parse(answer.endsAt))
  )
    return invalid();
  if (answer.support === null) return { endsAt: answer.endsAt, support: null };
  const contact = exact(answer.support, ["phone", "testOnly"]);
  if (
    typeof contact.phone !== "string" ||
    !/^\+[1-9][0-9]{6,14}$/u.test(contact.phone) ||
    typeof contact.testOnly !== "boolean"
  )
    return invalid();
  return { endsAt: answer.endsAt, support: { phone: contact.phone, testOnly: contact.testOnly } };
}

export async function loadOrderingEnding(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OrderingEnding | null> {
  const response = await fetcher("/merchant/ordering-ending", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
  )
    return invalid();
  const body = await response.text();
  if (body.length > 4096) return invalid();
  return parseOrderingEnding(JSON.parse(body) as unknown);
}

/** The words for a moment: the time left, and what to do then, for whoever is reading. */
export function orderingEndingWords(endsAt: string, now: number) {
  const left = Date.parse(endsAt) - now;
  return left > 0
    ? {
        announce: t("Ordering at this Store is about to stop"),
        title: t("Ordering at this Store stops in {duration}", {
          duration: timeLeftWords(left),
        }),
        detail: t(
          "Only BOP support can renew it: call them now, or tell your manager. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.",
        ),
      }
    : {
        announce: t("Ordering at this Store has stopped"),
        title: t("Ordering at this Store has stopped"),
        detail: t(
          "Only BOP support can renew it: call them now, or tell your manager. Keep taking orders on your own POS or on paper, and take payment on the card machine.",
        ),
      };
}

/**
 * Reads now and every ORDERING_ENDING_READ_MS while the screen is in view. A read that fails says
 * nothing, so the screen keeps what it last knew: no read is not an all-clear, and the end does not
 * move unless BOP renews. Returns what stops it.
 */
export function trackOrderingEnding(options: {
  load(signal: AbortSignal): Promise<OrderingEnding | null>;
  onEnding(ending: OrderingEnding | null): void;
  inView(): boolean;
}): () => void {
  const controller = new AbortController();
  const read = () => {
    options
      .load(controller.signal)
      .then((ending) => {
        if (!controller.signal.aborted) options.onEnding(ending);
      })
      .catch(() => undefined);
  };
  read();
  const timer = setInterval(() => {
    if (options.inView()) read();
  }, ORDERING_ENDING_READ_MS);
  return () => {
    clearInterval(timer);
    controller.abort();
  };
}

/** What the notice says at a moment. */
export function OrderingEndingLine({
  ending,
  now,
}: {
  readonly ending: OrderingEnding;
  readonly now: number;
}) {
  const words = orderingEndingWords(ending.endsAt, now);
  return (
    <section className="ordering-ending-notice" aria-label={t("Ordering at this Store")}>
      {/* Heard once; the countdown beside it stays quiet. */}
      <p className="visually-hidden" role="alert">
        {words.announce}
      </p>
      <p className="ordering-ending-notice__title">{words.title}</p>
      <p>{words.detail}</p>
      {ending.support === null ? null : (
        <p>
          <a href={`tel:${ending.support.phone}`}>
            {t("Call BOP support: {value}", { value: formatContactPhone(ending.support.phone) })}
          </a>
          {ending.support.testOnly ? ` ${t("(test number)")}` : null}
        </p>
      )}
    </section>
  );
}

/** Above the screen staff work in. */
export function OrderingEndingNotice({ fetcher }: { readonly fetcher?: typeof fetch | undefined }) {
  const [ending, setEnding] = useState<OrderingEnding | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // No reads once this screen's sign-in has ended; again at once if it is live.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!live) return;
    return trackOrderingEnding({
      load: (signal) => loadOrderingEnding(fetcher, signal),
      onEnding: (value) => {
        setEnding(value);
        setNow(Date.now());
      },
      inView: () => document.visibilityState === "visible",
    });
  }, [fetcher, live]);
  const shown = ending !== null;
  useEffect(() => {
    if (!shown) return;
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_MS);
    return () => clearInterval(timer);
  }, [shown]);
  return ending === null ? null : <OrderingEndingLine ending={ending} now={now} />;
}
