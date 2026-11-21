import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { t } from "./i18n/i18n.js";
import { serviceOperationReference } from "./service-control-client.js";
import { WorkspacePage } from "./WorkspacePage.js";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS (Section 88 LOY-PROGRAM-LIST): a Brand's points: the rules, who
 * has joined (only the last four digits of a phone) and what was issued, used and is outstanding.
 */
interface Reward {
  readonly productReference: string;
  readonly displayName: string;
  readonly pointsCost: number;
}
interface Rule {
  readonly version: number;
  readonly earnPointsPerDollar: number;
  readonly redeemPointsPerDollar: number;
  readonly minimumRedemptionPoints: number;
  readonly redemptionIncrementPoints: number;
  readonly inactivityExpiryDays: number;
  readonly expiryNoticeDays: number;
  readonly rewards: readonly Reward[];
}
interface View {
  /** Dishes the rule can offer for points (empty for who can't change the rules). */
  readonly dishChoices?: readonly {
    readonly productReference: string;
    readonly displayName: string;
  }[];
  readonly canManage: boolean;
  readonly offeredHere: boolean;
  readonly rule: Rule;
  readonly members: readonly {
    readonly accountReference: string;
    readonly phoneLast4: string | null;
    readonly availablePoints: number;
    readonly pointsDebt: number;
    readonly lifetimeEarnedPoints: number;
    readonly joinedAt: string;
    readonly lastActivityAt: string;
    readonly marketingConsent: boolean;
  }[];
  readonly report: {
    readonly members: number;
    readonly issuedPoints: number;
    readonly usedPoints: number;
    readonly returnedPoints: number;
    readonly reversedPoints: number;
    readonly expiredPoints: number;
    readonly forfeitedPoints: number;
    readonly outstandingPoints: number;
    readonly owedPoints: number;
    readonly usedValueMinor: string;
  };
}
const money = (minor: string) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(
    Number(minor) / 100,
  );
const date = (instant: string) => new Date(instant).toLocaleDateString();
const fields = [
  ["earnPointsPerDollar", () => t("Points for each $1 of dishes paid")],
  ["redeemPointsPerDollar", () => t("Points that take $1 off")],
  ["minimumRedemptionPoints", () => t("Fewest points a guest can use")],
  ["redemptionIncrementPoints", () => t("Points go up in steps of")],
  ["inactivityExpiryDays", () => t("Points expire after this many days with no activity")],
  ["expiryNoticeDays", () => t("Text the guest this many days before")],
] as const;
type Field = (typeof fields)[number][0];

/** WP-2423 M135: the same limits the server checks (domain `memberPointsRuleProblems`). */
const limits: Record<Field, readonly [number, number]> = {
  earnPointsPerDollar: [0, 100],
  redeemPointsPerDollar: [1, 10_000],
  minimumRedemptionPoints: [1, 1_000_000],
  redemptionIncrementPoints: [1, 1_000_000],
  inactivityExpiryDays: [90, 3650],
  expiryNoticeDays: [7, 89],
};
export interface RuleProblem {
  readonly field: Field;
  readonly rule: "WholeNumber" | "AtLeast" | "AtMost" | "BelowExpiry";
  readonly limit: number | null;
}
export function ruleProblems(values: Readonly<Record<Field, number>>): readonly RuleProblem[] {
  const problems: RuleProblem[] = [];
  for (const [field] of fields) {
    const value = values[field];
    const [minimum, maximum] = limits[field];
    if (!Number.isSafeInteger(value)) problems.push({ field, rule: "WholeNumber", limit: null });
    else if (value < minimum) problems.push({ field, rule: "AtLeast", limit: minimum });
    else if (value > maximum) problems.push({ field, rule: "AtMost", limit: maximum });
    else if (field === "expiryNoticeDays" && value >= values.inactivityExpiryDays)
      problems.push({ field, rule: "BelowExpiry", limit: values.inactivityExpiryDays });
  }
  return problems;
}
export function ruleProblemText(problem: RuleProblem): string {
  switch (problem.rule) {
    case "WholeNumber":
      return t("Use a whole number.");
    case "AtLeast":
      return t("Must be at least {limit}.", { limit: String(problem.limit) });
    case "AtMost":
      return t("Must be at most {limit}.", { limit: String(problem.limit) });
    case "BelowExpiry":
      return t("Must be fewer days than the expiry ({limit}).", { limit: String(problem.limit) });
  }
}
/** The server's 422 problems, kept only when each is one this page knows. */
export function parseRuleProblems(value: unknown): readonly RuleProblem[] | null {
  const body = value as { error?: unknown; problems?: unknown } | null;
  if (body?.error !== "rule_invalid" || !Array.isArray(body.problems)) return null;
  const known = new Set<string>(fields.map(([field]) => field));
  const problems = body.problems.filter(
    (problem): problem is RuleProblem =>
      problem !== null &&
      typeof problem === "object" &&
      known.has((problem as RuleProblem).field) &&
      ["WholeNumber", "AtLeast", "AtMost", "BelowExpiry"].includes((problem as RuleProblem).rule) &&
      ((problem as RuleProblem).limit === null ||
        Number.isSafeInteger((problem as RuleProblem).limit)),
  );
  return problems.length === body.problems.length ? problems : null;
}
/**
 * WP-2423 M135: what the earn and redeem numbers give back, e.g. "About 1% back: a guest earns 1
 * point per $1 and 100 points take $1 off." (one decimal, from the exact ratio).
 */
export function pointsRateText(earn: number, redeem: number): string | null {
  if (!Number.isSafeInteger(earn) || !Number.isSafeInteger(redeem) || redeem < 1 || earn < 0)
    return null;
  if (earn === 0) return t("Guests earn no points with these numbers.");
  const tenths = Math.round((earn * 1000) / redeem);
  const percent = tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
  const text =
    earn === 1
      ? t("About {percent}% back: a guest earns 1 point per $1 and {redeem} points take $1 off.", {
          percent,
          redeem: String(redeem),
        })
      : t(
          "About {percent}% back: a guest earns {earn} points per $1 and {redeem} points take $1 off.",
          { percent, earn: String(earn), redeem: String(redeem) },
        );
  return tenths > 100 ? text + " " + t("That gives back more than most stores (2–5%).") : text;
}

export function MemberPointsPage({
  csrf,
  storeFeaturesHref,
  fetcher = fetch,
}: {
  readonly csrf: string;
  readonly storeFeaturesHref: string | null;
  readonly fetcher?: typeof fetch;
}) {
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const [operation, setOperation] = useState(() => serviceOperationReference());
  const [message, setMessage] = useState<string | null>(null);
  const [problems, setProblems] = useState<readonly RuleProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const showProblems = (found: readonly RuleProblem[]) => {
    setProblems(found);
    const first = found[0];
    if (first !== undefined)
      requestAnimationFrame(() => document.getElementById("member-rule-" + first.field)?.focus());
  };
  const load = useCallback(async () => {
    try {
      const response = await fetcher("/merchant/member-points", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("member points");
      setView((await response.json()) as View);
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [fetcher]);
  useEffect(() => {
    void load();
  }, [load]);
  const values = useMemo(() => {
    if (view === null) return null;
    const current = {} as Record<Field, number>;
    for (const [key] of fields) current[key] = Number(draft[key] ?? view.rule[key]);
    return current;
  }, [draft, view]);
  const [draftRewards, setDraftRewards] = useState<readonly Reward[] | null>(null);
  const [newDish, setNewDish] = useState("");
  const [newCost, setNewCost] = useState("");
  const rewards = draftRewards ?? view?.rule.rewards ?? [];
  const addReward = () => {
    const dish = view?.dishChoices?.find((entry) => entry.productReference === newDish);
    const pointsCost = Number(newCost);
    if (dish === undefined || !Number.isInteger(pointsCost) || pointsCost < 1) return;
    setDraftRewards([...rewards, { ...dish, pointsCost }]);
    setNewDish("");
    setNewCost("");
  };
  const save = async () => {
    if (view === null || values === null) return;
    // The same checks the server makes, before anything is sent.
    const local = ruleProblems(values);
    showProblems(local);
    if (local.length > 0) {
      setMessage(t("Some numbers can't be used. Each one says why below it."));
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetcher("/merchant/member-points/rule", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify({
          operationReference: operation,
          expectedVersion: view.rule.version,
          change: { ...values, rewards },
        }),
      });
      if (response.ok) {
        setMessage(t("Saved. New points and uses follow these rules from now on."));
        setDraft({});
        setDraftRewards(null);
        setOperation(serviceOperationReference());
        await load();
      } else if (response.status === 409) {
        setMessage(t("Someone else changed the rules just now. Here is what they are now."));
        setOperation(serviceOperationReference());
        setDraft({});
        setDraftRewards(null);
        await load();
      } else if (response.status === 422) {
        const found = parseRuleProblems(await response.json().catch(() => null));
        if (found !== null && found.length > 0) {
          showProblems(found);
          setMessage(t("Some numbers can't be used. Each one says why below it."));
        } else setMessage(t("Those numbers can't be used. Check them and try again."));
        setOperation(serviceOperationReference());
      } else
        setMessage(
          t("We couldn't confirm that went through. Check your connection and try again."),
        );
    } catch {
      setMessage(t("We couldn't confirm that went through. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <WorkspacePage title={t("Points")}>
      {state === "loading" ? <p role="status">{t("Loading points…")}</p> : null}
      {state === "failed" ? (
        <div role="alert">
          <p>{t("We can't show points right now. Nothing was changed.")}</p>
          <button type="button" onClick={() => void load()}>
            {t("Try again")}
          </button>
        </div>
      ) : null}
      {view === null || values === null ? null : (
        <div className="member-points">
          <p>
            {view.offeredHere
              ? t(
                  "Guests at this Store can join and earn after they pay. Points work at every Store of this brand that has them on.",
                )
              : t(
                  "Points are off at this Store: guests aren't asked to join, and can't earn or use points here. Members keep their points.",
                )}{" "}
            {storeFeaturesHref === null ? null : (
              <Link to={storeFeaturesHref}>{t("Store features")}</Link>
            )}
          </p>
          <p>
            {t(
              "Only for orders guests place by scanning the QR code. Orders on your own register don't earn.",
            )}
          </p>

          <section aria-labelledby="member-report">
            <h2 id="member-report">{t("Points so far")}</h2>
            <dl className="member-points__report">
              {(
                [
                  [t("Members"), view.report.members],
                  [t("Issued"), view.report.issuedPoints],
                  [t("Used"), view.report.usedPoints],
                  [t("Given back on refunds"), view.report.returnedPoints],
                  [t("Taken back on refunds"), view.report.reversedPoints],
                  [t("Expired"), view.report.expiredPoints],
                  [t("Gone when members left"), view.report.forfeitedPoints],
                  [t("Outstanding"), view.report.outstandingPoints],
                  [t("Owed by members"), view.report.owedPoints],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value.toLocaleString()}</dd>
                </div>
              ))}
              <div>
                <dt>{t("Value of points used, tax included")}</dt>
                <dd>{money(view.report.usedValueMinor)}</dd>
              </div>
            </dl>
            <p className="bop-muted">
              {t(
                "Points used are discounts on the bill. The sale stays recorded at its price; reports show them as points used.",
              )}
            </p>
          </section>

          <section aria-labelledby="member-rules">
            <h2 id="member-rules">{t("Rules")}</h2>
            <form
              className="member-points__rules"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              {fields.map(([key, label]) => {
                const problem = problems.find((entry) => entry.field === key);
                return (
                  <label key={key}>
                    {label()}
                    <input
                      id={"member-rule-" + key}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      disabled={!view.canManage || busy}
                      value={draft[key] ?? String(view.rule[key])}
                      aria-invalid={problem === undefined ? undefined : true}
                      aria-describedby={
                        problem === undefined ? undefined : "member-rule-" + key + "-problem"
                      }
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, [key]: event.target.value }));
                        setProblems((current) => current.filter((entry) => entry.field !== key));
                      }}
                    />
                    {problem === undefined ? null : (
                      <span id={"member-rule-" + key + "-problem"} className="field-problem">
                        {ruleProblemText(problem)}
                      </span>
                    )}
                    {key === "redeemPointsPerDollar" ? (
                      <span className="bop-muted">
                        {pointsRateText(values.earnPointsPerDollar, values.redeemPointsPerDollar)}
                      </span>
                    ) : null}
                  </label>
                );
              })}
              <h3>{t("Dishes guests can get with points")}</h3>
              {rewards.length === 0 ? (
                <p className="bop-muted">
                  {t("No dishes yet. Guests can still use points on the bill.")}
                </p>
              ) : (
                <ul>
                  {rewards.map((reward) => (
                    <li key={reward.productReference}>
                      {t("{dish} · {points} points", {
                        dish: reward.displayName,
                        points: String(reward.pointsCost),
                      })}
                      {view.canManage ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={t("Remove {dish}", { dish: reward.displayName })}
                            onClick={() =>
                              setDraftRewards(
                                rewards.filter(
                                  (entry) => entry.productReference !== reward.productReference,
                                ),
                              )
                            }
                          >
                            {t("Remove")}
                          </button>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {view.canManage ? (
                <div role="group" aria-label={t("Add a dish")}>
                  <label>
                    {t("Dish")}
                    <select
                      value={newDish}
                      disabled={busy}
                      onChange={(event) => setNewDish(event.target.value)}
                    >
                      <option value="">{t("Choose a dish")}</option>
                      {(view.dishChoices ?? [])
                        .filter(
                          (dish) =>
                            !rewards.some(
                              (entry) => entry.productReference === dish.productReference,
                            ),
                        )
                        .map((dish) => (
                          <option key={dish.productReference} value={dish.productReference}>
                            {dish.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    {t("Points it costs")}
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      disabled={busy}
                      value={newCost}
                      onChange={(event) => setNewCost(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || newDish === "" || !(Number(newCost) >= 1)}
                    onClick={addReward}
                  >
                    {t("Add this dish")}
                  </button>
                </div>
              ) : null}
              {view.canManage ? (
                <button
                  type="submit"
                  disabled={busy || (Object.keys(draft).length === 0 && draftRewards === null)}
                >
                  {t("Save rules")}
                </button>
              ) : (
                <p role="note">{t("Only the Owner can change the rules.")}</p>
              )}
              {message === null ? null : <p role="status">{message}</p>}
            </form>
          </section>

          <section aria-labelledby="member-list">
            <h2 id="member-list">{t("Members")}</h2>
            {view.members.length === 0 ? (
              <p>{t("No members yet.")}</p>
            ) : (
              <table className="member-points__members">
                <thead>
                  <tr>
                    <th scope="col">{t("Phone")}</th>
                    <th scope="col">{t("Points")}</th>
                    <th scope="col">{t("Earned in all")}</th>
                    <th scope="col">{t("Joined")}</th>
                    <th scope="col">{t("Last activity")}</th>
                    <th scope="col">{t("Offers by text")}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.members.map((member) => (
                    <tr key={member.accountReference}>
                      <td data-label={t("Phone")}>•••• {member.phoneLast4 ?? ""}</td>
                      <td data-label={t("Points")}>
                        {member.pointsDebt > 0
                          ? t("{points} owed", { points: String(member.pointsDebt) })
                          : member.availablePoints.toLocaleString()}
                      </td>
                      <td data-label={t("Earned in all")}>
                        {member.lifetimeEarnedPoints.toLocaleString()}
                      </td>
                      <td data-label={t("Joined")}>{date(member.joinedAt)}</td>
                      <td data-label={t("Last activity")}>{date(member.lastActivityAt)}</td>
                      <td data-label={t("Offers by text")}>
                        {member.marketingConsent ? t("Yes") : t("No")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </WorkspacePage>
  );
}
