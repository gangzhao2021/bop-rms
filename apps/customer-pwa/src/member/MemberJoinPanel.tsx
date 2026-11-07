import { useEffect, useState } from "react";
import { Link } from "react-router";
import { t, useLanguage } from "../i18n/i18n.js";
import { memberCodeProblem, MemberSignIn } from "./MemberSignIn.js";
import { memberClient, type MemberClient, type MemberState } from "./member-client.js";

export const scanToOrderOnlyText = () =>
  t("Points are earned and used only on orders you place by scanning the QR code.");

/**
 * On a receipt: join and earn on this order. Nothing here can get in the way of the receipt: a read
 * that fails shows nothing, and joining can wait until the time it states.
 */
export function MemberJoinPanel({
  orderReference = null,
  automaticOnly = false,
  refresh = 0,
  client = memberClient,
}: {
  readonly orderReference?: string | null;
  /** Where joining isn't offered (the order page): only adds a signed-in member's points. */
  readonly automaticOnly?: boolean;
  /** A change reads again (the order was just paid). */
  readonly refresh?: unknown;
  readonly client?: MemberClient;
}) {
  useLanguage();
  const [state, setState] = useState<MemberState | null>(null);
  const [part, setPart] = useState<number | null>(null);
  const [earned, setEarned] = useState<number | null>(null);
  const [auto, setAuto] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      let current = await client.state(orderReference);
      // A signed-in member who certainly paid: their points, without asking. A failure leaves the
      // button; nothing here can get in the way of the receipt or of paying.
      if (current.signedIn && current.claim) {
        let added = 0;
        for (const part of current.claim.parts)
          if (part.certain === true)
            added += await client
              .claim(part.partNumber, orderReference)
              .then((answer) => answer.earnedPoints)
              .catch(() => 0);
        if (added > 0) {
          if (live) setAuto(added);
          current = await client.state(orderReference);
        }
      }
      if (live) setState(current);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, orderReference, refresh]);
  if (state === null || !state.offered) return null;
  const addedNote =
    auto > 0 ? (
      <p className="member-panel__added" role="status">
        {t("{points} points added for this order.", { points: String(auto) })}{" "}
        <Link to="/member">{t("See your points")}</Link>
      </p>
    ) : null;
  if (automaticOnly) return addedNote;
  if (earned !== null)
    return (
      <section className="member-panel" aria-labelledby="member-panel-title">
        <h2 id="member-panel-title">{t("You’re a member")}</h2>
        <p role="status">
          {earned > 0
            ? t("{points} points added for this order.", { points: String(earned) })
            : t("You’re signed in.")}
        </p>
        <p>
          <Link to="/member">{t("See your points")}</Link>
        </p>
      </section>
    );
  const claim = state.claim ?? null;
  if (claim === null)
    return addedNote !== null ? (
      addedNote
    ) : state.signedIn ? (
      <p className="member-panel__link">
        <Link to="/member">{t("See your points")}</Link>
      </p>
    ) : null;
  const until = new Date(claim.until).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  if (skipped)
    return (
      <p className="member-panel__link" role="status">
        {t("No problem. You can still add this order’s points on this phone until {time}.", {
          time: until,
        })}{" "}
        <button type="button" onClick={() => setSkipped(false)}>
          {t("Join now")}
        </button>
      </p>
    );
  const several = claim.parts.length > 1;
  const chosen = several ? claim.parts.find((entry) => entry.partNumber === part) : claim.parts[0];
  const points = chosen?.points ?? Math.max(...claim.parts.map((entry) => entry.points));
  const partNumber = several ? part : (claim.parts[0]?.partNumber ?? null);
  const add = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setEarned((await client.claim(partNumber, orderReference)).earnedPoints);
    } catch (error) {
      setProblem(memberCodeProblem(error, claim.until));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="member-panel" aria-labelledby="member-panel-title">
      {addedNote}
      <h2 id="member-panel-title">
        {state.signedIn
          ? t("Add {points} points for this order", { points: String(points) })
          : t("Join and earn {points} points on this order", { points: String(points) })}
      </h2>
      <p>{scanToOrderOnlyText()}</p>
      {several ? (
        <fieldset className="member-panel__parts">
          <legend>{t("Which part did you pay?")}</legend>
          {claim.parts.map((entry) => (
            <label key={entry.partNumber}>
              <input
                type="radio"
                name="member-part"
                checked={part === entry.partNumber}
                onChange={() => setPart(entry.partNumber)}
              />{" "}
              {t("Part {number} · {points} points", {
                number: String(entry.partNumber),
                points: String(entry.points),
              })}
            </label>
          ))}
        </fieldset>
      ) : null}
      {several && part === null ? null : state.signedIn ? (
        <>
          {problem === null ? null : <p role="alert">{problem}</p>}
          <button type="button" disabled={busy} onClick={() => void add()}>
            {t("Add my points")}
          </button>
        </>
      ) : (
        <MemberSignIn
          client={client}
          until={claim.until}
          askConsent
          submitLabel={t("Join and add my points")}
          verify={async ({ phone, code, marketingConsent }) => {
            const result = await client.verify({
              phone,
              code,
              marketingConsent,
              claim: true,
              partNumber,
              orderReference,
            });
            setEarned(result.earnedPoints);
          }}
        />
      )}
      {state.signedIn ? null : (
        <button type="button" className="member-panel__skip" onClick={() => setSkipped(true)}>
          {t("Not now")}
        </button>
      )}
    </section>
  );
}
