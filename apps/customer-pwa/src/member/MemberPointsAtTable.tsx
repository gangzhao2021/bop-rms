import { useCallback, useEffect, useState } from "react";
import { t, useLanguage } from "../i18n/i18n.js";
import { formatMoney } from "../journey/format.js";
import { memberCodeProblem, MemberSignIn } from "./MemberSignIn.js";
import {
  MemberClientError,
  memberClient,
  type MemberClient,
  type MemberRedemptionOptions,
  type MemberState,
} from "./member-client.js";

const uuidV7 = () => {
  const now = Date.now().toString(16).padStart(12, "0");
  const random = crypto.getRandomValues(new Uint8Array(10));
  const hex = [...random].map((value) => value.toString(16).padStart(2, "0")).join("");
  const variant = ((random[2] ?? 0) & 0x3f) | 0x80;
  return `${now.slice(0, 8)}-${now.slice(8)}-7${hex.slice(0, 3)}-${variant.toString(16)}${hex.slice(6, 8)}-${hex.slice(8, 20)}`;
};

/**
 * While the table can still pay: use points on the bill. Paying never depends on it: a failed read
 * shows nothing and the bill can be paid as it stands.
 */
export function MemberPointsAtTable({
  onBillChanged,
  client = memberClient,
}: {
  onBillChanged(): void;
  readonly client?: MemberClient;
}) {
  useLanguage();
  const [state, setState] = useState<MemberState | null>(null);
  const [options, setOptions] = useState<MemberRedemptionOptions | null>(null);
  const [points, setPoints] = useState<number | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [confirming, setConfirming] = useState<
    | null
    | { kind: "Points"; points: number }
    | { kind: "Reward"; productReference: string; name: string; points: number }
  >(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await client.state(null);
      setState(next);
      if (next.offered && next.signedIn) {
        const available = await client.redemptionOptions();
        setOptions(available);
        setPoints(available.largestPoints ?? null);
      }
    } catch {
      setState(null);
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  if (state === null || !state.offered) return null;
  if (!state.signedIn)
    return (
      <div className="member-at-table">
        {signingIn ? (
          <MemberSignIn
            client={client}
            until={null}
            askConsent={false}
            submitLabel={t("Sign in")}
            verify={async ({ phone, code }) => {
              await client.verify({
                phone,
                code,
                marketingConsent: false,
                claim: false,
                partNumber: null,
                orderReference: null,
              });
              await load();
            }}
          />
        ) : (
          <button type="button" onClick={() => setSigningIn(true)}>
            {t("Have points? Sign in to use them")}
          </button>
        )}
      </div>
    );
  if (options === null || !options.available) return null;
  const rule = options.rule;
  const dollars = (value: number) =>
    rule === undefined
      ? ""
      : formatMoney(String(Math.floor((value * 100) / rule.redeemPointsPerDollar)), "CAD");
  const redeem = async () => {
    if (confirming === null || operation === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await client.redeem(
        confirming.kind === "Points"
          ? { operationReference: operation, points: confirming.points }
          : { operationReference: operation, rewardProductReference: confirming.productReference },
      );
      setDone(t("{points} points used on this bill.", { points: String(result.points) }));
      setConfirming(null);
      onBillChanged();
      await load();
    } catch (error) {
      const code = error instanceof MemberClientError ? error.code : "member_unavailable";
      setProblem(
        code === "member_redeem_split"
          ? t(
              "The bill has been split. Ask a staff member to put it back on one bill to use points.",
            )
          : code === "member_not_enough_points"
            ? t("You don’t have that many points any more.")
            : code === "member_redeem_paid"
              ? t("This bill is already settled.")
              : code === "member_redeem_guest_paying"
                ? t("Someone at your table is paying now. Try again if they stop.")
                : memberCodeProblem(error, null),
      );
      setConfirming(null);
      void load();
    } finally {
      setBusy(false);
    }
  };
  const steps: number[] = [];
  if (rule !== undefined && (options.largestPoints ?? 0) > 0)
    for (
      let value = rule.minimumRedemptionPoints;
      value <= (options.largestPoints as number);
      value += rule.redemptionIncrementPoints
    )
      steps.push(value);
  return (
    <section className="member-at-table" aria-labelledby="member-at-table-title">
      <h3 id="member-at-table-title">
        {t("You have {points} points", { points: String(options.availablePoints ?? 0) })}
      </h3>
      {done === null ? null : <p role="status">{done}</p>}
      {problem === null ? null : <p role="alert">{problem}</p>}
      {options.blockedBySplit ? (
        <p>
          {t(
            "The bill has been split. Ask a staff member to put it back on one bill to use points.",
          )}
        </p>
      ) : confirming !== null ? (
        <div role="group" aria-label={t("Confirm using points")}>
          <p>
            {confirming.kind === "Points"
              ? t(
                  "Use {points} points for {amount} off the dishes? Tax is worked out on what’s left. You can’t undo this yourself.",
                  {
                    points: String(confirming.points),
                    amount: dollars(confirming.points),
                  },
                )
              : t("Use {points} points to get {dish} free? You can’t undo this yourself.", {
                  points: String(confirming.points),
                  dish: confirming.name,
                })}
          </p>
          <button type="button" disabled={busy} onClick={() => void redeem()}>
            {t("Use my points")}
          </button>{" "}
          <button type="button" disabled={busy} onClick={() => setConfirming(null)}>
            {t("Keep my points")}
          </button>
        </div>
      ) : (
        <>
          {steps.length > 0 ? (
            <div className="member-at-table__use">
              <label>
                {t("Points to use")}
                <select
                  value={String(points ?? steps[steps.length - 1])}
                  onChange={(event) => setPoints(Number(event.target.value))}
                >
                  {steps.map((value) => (
                    <option key={value} value={value}>
                      {t("{points} points, {amount} off", {
                        points: String(value),
                        amount: dollars(value),
                      })}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  setOperation(uuidV7());
                  setConfirming({
                    kind: "Points",
                    points: points ?? (steps[steps.length - 1] as number),
                  });
                }}
              >
                {t("Use points")}
              </button>
            </div>
          ) : rule !== undefined ? (
            <p>
              {t("You can use points from {points} points, on dishes not already discounted.", {
                points: String(rule.minimumRedemptionPoints),
              })}
            </p>
          ) : null}
          {(options.rewards ?? []).map((reward) => (
            <button
              key={reward.productReference}
              type="button"
              onClick={() => {
                setOperation(uuidV7());
                setConfirming({
                  kind: "Reward",
                  productReference: reward.productReference,
                  name: reward.displayName,
                  points: reward.pointsCost,
                });
              }}
            >
              {t("{dish} free for {points} points", {
                dish: reward.displayName,
                points: String(reward.pointsCost),
              })}
            </button>
          ))}
        </>
      )}
    </section>
  );
}
