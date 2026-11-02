import { useCallback, useEffect, useState } from "react";
import { t, useLanguage } from "../i18n/i18n.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { formatDateTime } from "../journey/format.js";
import { scanToOrderOnlyText } from "./MemberJoinPanel.js";
import { MemberSignIn } from "./MemberSignIn.js";
import {
  MemberClientError,
  memberClient,
  type MemberClient,
  type MemberHistoryEntry,
  type MemberHome,
} from "./member-client.js";

const historyText = (entry: MemberHistoryEntry): string => {
  switch (entry.type) {
    case "Earn":
      return t("Earned on an order");
    case "Redeem":
      return t("Used on a bill");
    case "Reverse":
      return t("Taken back after a refund");
    case "Return":
      return entry.reasonCode === "BILL_WRITTEN_OFF"
        ? t("Returned: the bill wasn’t paid")
        : t("Returned after a refund");
    default:
      return entry.reasonCode === "LEFT_PROGRAM" ? t("Gone when you left") : t("Expired");
  }
};
const signed = (entry: MemberHistoryEntry) =>
  (entry.type === "Earn" || entry.type === "Return" ? "+" : "−") + String(entry.points);

/** CUST-LOYALTY: balance, history, what can be redeemed, and leaving, for the member themself. */
export function MemberPage({
  store,
  client = memberClient,
}: {
  readonly store?: CustomerStoreContext | undefined;
  readonly client?: MemberClient;
}) {
  useLanguage();
  const [state, setState] = useState<
    | { kind: "Loading" }
    | { kind: "SignIn"; offered: boolean }
    | { kind: "NoVisit" }
    | { kind: "Failed" }
    | { kind: "Left" }
    | { kind: "Ready"; home: MemberHome }
  >({ kind: "Loading" });
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setState({ kind: "Ready", home: await client.home() });
    } catch (error) {
      const code = error instanceof MemberClientError ? error.code : null;
      if (code === "member_sign_in_required") {
        const current = await client.state(null).catch(() => null);
        setState({ kind: "SignIn", offered: current?.offered === true });
      } else setState({ kind: code === "member_not_found" ? "NoVisit" : "Failed" });
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const body = () => {
    if (state.kind === "Loading") return <p role="status">{t("Loading your points")}</p>;
    if (state.kind === "NoVisit")
      return <p>{t("Scan the QR code at your table to see your points.")}</p>;
    if (state.kind === "Failed")
      return (
        <div role="alert">
          <p>{t("We couldn’t load your points. Check your connection and try again.")}</p>
          <button type="button" onClick={() => void load()}>
            {t("Try again")}
          </button>
        </div>
      );
    if (state.kind === "Left")
      return <p role="status">{t("You’ve left. Your phone number is deleted.")}</p>;
    if (state.kind === "SignIn")
      return (
        <>
          <p>
            {state.offered
              ? t("Sign in or join with your mobile number.")
              : t(
                  "This restaurant doesn’t offer points right now. If you’re a member, sign in to see your points or leave.",
                )}
          </p>
          <p>{scanToOrderOnlyText()}</p>
          <MemberSignIn
            client={client}
            until={null}
            askConsent={state.offered}
            submitLabel={t("Sign in")}
            verify={async ({ phone, code, marketingConsent }) => {
              await client.verify({
                phone,
                code,
                marketingConsent,
                claim: false,
                partNumber: null,
                orderReference: null,
              });
              await load();
            }}
          />
        </>
      );
    const { home } = state;
    const toggle = async () => {
      setBusy(true);
      try {
        await client.setMarketingConsent(!home.marketingConsent);
        await load();
      } catch {
        setProblem(t("We couldn’t do that. Check your connection and try again."));
      } finally {
        setBusy(false);
      }
    };
    const leave = async () => {
      setBusy(true);
      setProblem(null);
      try {
        await client.leave();
        setState({ kind: "Left" });
      } catch {
        setProblem(t("We couldn’t do that. Check your connection and try again."));
      } finally {
        setBusy(false);
      }
    };
    return (
      <>
        <section className="member-page__balance" aria-labelledby="member-balance">
          <h2 id="member-balance">
            {t("{points} points", { points: String(home.availablePoints) })}
          </h2>
          <p>{t("Number ending in {last4}", { last4: home.phoneLast4 })}</p>
          {home.pointsOwed > 0 ? (
            <p>
              {t("{points} points are owed from a refunded order. New points pay this off first.", {
                points: String(home.pointsOwed),
              })}
            </p>
          ) : null}
          {home.expiresAt !== null ? (
            <p role={home.expiresSoon ? "alert" : undefined}>
              {home.expiresSoon
                ? t("Your points expire on {date}. Earn or use any before then to keep them.", {
                    date: formatDateTime(home.expiresAt),
                  })
                : t("Your points expire on {date} if you don’t earn or use any before then.", {
                    date: formatDateTime(home.expiresAt),
                  })}
            </p>
          ) : null}
          {home.offeredHere ? null : (
            <p>{t("This restaurant doesn’t offer points right now. Your points stay yours.")}</p>
          )}
        </section>
        <section aria-labelledby="member-how">
          <h2 id="member-how">{t("How points work")}</h2>
          <p>
            {t(
              "{earn} points for every $1 of dishes you pay for. {redeem} points take $1 off dishes, from {minimum} points. Tax, tips and discounted dishes don’t earn.",
              {
                earn: String(home.rule.earnPointsPerDollar),
                redeem: String(home.rule.redeemPointsPerDollar),
                minimum: String(home.rule.minimumRedemptionPoints),
              },
            )}
          </p>
          <p>{scanToOrderOnlyText()}</p>
          {home.rule.rewards.length > 0 ? (
            <>
              <h3>{t("Dishes you can get with points")}</h3>
              <ul>
                {home.rule.rewards.map((reward) => (
                  <li key={reward.productReference}>
                    {t("{dish} · {points} points", {
                      dish: reward.displayName,
                      points: String(reward.pointsCost),
                    })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
        <section aria-labelledby="member-history">
          <h2 id="member-history">{t("Your points history")}</h2>
          {home.history.length === 0 ? (
            <p>{t("Nothing yet.")}</p>
          ) : (
            <ul className="member-page__history">
              {home.history.map((entry) => (
                <li key={entry.occurredAt + entry.type + String(entry.points)}>
                  <span>{historyText(entry)}</span>
                  <span>{formatDateTime(entry.occurredAt)}</span>
                  <strong>{signed(entry)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="member-yours">
          <h2 id="member-yours">{t("Your details")}</h2>
          <label className="member-form__consent">
            <input
              type="checkbox"
              checked={home.marketingConsent}
              disabled={busy}
              onChange={() => void toggle()}
            />{" "}
            {t("Text me offers from this restaurant. Optional; you can stop any time.")}
          </label>
          {problem === null ? null : <p role="alert">{problem}</p>}
          <div className="member-form__actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void client.signOut().then(
                  () => load(),
                  () => undefined,
                )
              }
            >
              {t("Sign out")}
            </button>
            <button type="button" disabled={busy} onClick={() => setLeaving(true)}>
              {t("Leave and delete my details")}
            </button>
          </div>
          {leaving ? (
            <div role="group" aria-label={t("Confirm leaving")}>
              <p>
                {t(
                  "Your phone number is deleted right away and your {points} points are gone. If you join again you start at 0. This can’t be undone.",
                  {
                    points: String(home.availablePoints),
                  },
                )}
              </p>
              <button type="button" disabled={busy} onClick={() => void leave()}>
                {t("Leave and delete")}
              </button>{" "}
              <button type="button" disabled={busy} onClick={() => setLeaving(false)}>
                {t("Stay a member")}
              </button>
            </div>
          ) : null}
        </section>
      </>
    );
  };
  return (
    <CustomerPage
      step="other"
      store={store}
      className="member-page"
      fallbackTitle={t("Your points")}
    >
      <PageHeading title={t("Your points")} />
      {body()}
    </CustomerPage>
  );
}
