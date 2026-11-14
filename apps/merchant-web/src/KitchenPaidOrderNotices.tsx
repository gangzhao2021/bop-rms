import { useEffect, useState } from "react";
import { Link } from "react-router";
import { t } from "./i18n/i18n.js";
import { kitchenOrderText, type KitchenBoardView } from "./kitchen-board.js";
import { notSentReasonText } from "./paid-order-watch.js";

/** How often a paid order that needs a person rings while nobody said they saw it. */
export const kitchenNeedsPersonRepeatMs = 20_000;

/** "Table 4 · Order 12 · has alcohol": each paid order that did not come straight here. */
export function kitchenNeedsPersonLines(view: KitchenBoardView): readonly string[] {
  // For a day after it is turned off too: whoever switched it off may not have told the kitchen.
  if (!view.paidOrderWatch?.on && !view.paidOrderWatch?.recentlyOn) return [];
  return (view.awaitingAcceptance ?? []).map((label) =>
    label.notSent === undefined
      ? kitchenOrderText(label)
      : `${kitchenOrderText(label)} · ${notSentReasonText(label.notSent.reason, label.notSent.itemCount)}`,
  );
}

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: at a Store sending paid orders straight to the kitchen, the
 * board is the screen staff look at. A paid order the System left for a person is said here, and
 * rings until someone says they saw it; the kitchen role can't accept, so it says who can. A silent
 * board now means an unseen order, so sound being off is an alert. Stores without it see nothing.
 */
export function KitchenPaidOrderNotices({
  view,
  soundOn,
  soundResumes,
  onSoundOn,
  onRing,
}: {
  readonly view: KitchenBoardView;
  readonly soundOn: boolean;
  readonly soundResumes: boolean;
  readonly onSoundOn: (() => void) | undefined;
  readonly onRing: () => void;
}) {
  const lines = kitchenNeedsPersonLines(view);
  const key = lines.join("|");
  const [seen, setSeen] = useState("");
  const unseen = lines.length > 0 && key !== seen;
  useEffect(() => {
    if (!unseen || !soundOn) return;
    onRing();
    const timer = setInterval(onRing, kitchenNeedsPersonRepeatMs);
    return () => clearInterval(timer);
    // The ring follows what is unseen, not the parent's redraws.
  }, [key, unseen, soundOn]);
  const watch = view.paidOrderWatch;
  if (watch === undefined || watch === null) return null;
  return (
    <>
      {watch.on && !soundOn && !soundResumes && onSoundOn !== undefined ? (
        <section className="kitchen-arrivals" role="alert">
          <div>
            <h3>
              {t("Paid orders now come straight here. Sound is off, so nobody will hear them.")}
            </h3>
          </div>
          <button type="button" onClick={onSoundOn}>
            {t("Tap to turn it on")}
          </button>
        </section>
      ) : null}
      {unseen ? (
        <section className="kitchen-arrivals" role="alert">
          <div>
            <h3>{t("Paid, needs a person")}</h3>
            <ul>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>
              {watch.canAcceptOrders ? (
                <Link to="/operations/orders">{t("Accept on Orders")}</Link>
              ) : (
                t("Ask someone at the counter to accept it on Orders.")
              )}
            </p>
          </div>
          <button type="button" onClick={() => setSeen(key)}>
            {t("Seen")}
          </button>
        </section>
      ) : null}
    </>
  );
}
