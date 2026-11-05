import { allergenName, listSeparator, serviceModeText, t } from "./i18n/i18n.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { languageName } from "./staff-text.js";
import { StepUpVerification } from "./StepUpVerification.js";
import type { StoreConfigurationSnapshot } from "./store-configuration-client.js";
import {
  createStoreOpeningDeps,
  emptyOpeningHours,
  loadOpeningFacts,
  openingAnswerProblems,
  openingAnswersFromRecords,
  openingConfirmationFromFacts,
  openingContentOf,
  openingMissing,
  openingPeriodEndsNextDay,
  openingWaitsFromFacts,
  runStoreOpening,
  syncOpeningReferences,
  type OpeningAnswers,
  type OpeningApprover,
  type OpeningConfirmation,
  type OpeningDetails,
  type OpeningFacts,
  type OpeningGate,
  type OpeningHours,
  type OpeningHoursProblem,
  type OpeningMissing,
  type OpeningPeriod,
  type OpeningServiceMode,
  type OpeningStep,
  type OpeningWait,
  type StoreOpeningDeps,
  type StoreOpeningOutcome,
} from "./store-first-opening.js";
import type { StoreSetupScope } from "./store-setup-client.js";
import {
  formatStorePhone,
  provinceNames,
  storePublicProfileFieldErrors,
} from "./StorePublicProfilePanel.js";
import { receiptPrivacyFieldErrors } from "./StoreReceiptPrivacyPanel.js";
import { timeZoneLabel } from "./time-zone-names.js";

/**
 * WP-2423 item 14 (DEC-STORE-FIRST-OPENING): a first Store's page. The Owner answers what only they
 * can answer, reads in full what will be published, and presses one button. Everything else Store
 * setup asks of an established Store follows from those answers (store-first-opening.ts). Shown only
 * until the Store has a published setup; the step-by-step page stays under it, folded.
 */
const weekdays = () => [
  t("Monday"),
  t("Tuesday"),
  t("Wednesday"),
  t("Thursday"),
  t("Friday"),
  t("Saturday"),
  t("Sunday"),
];
const stepWords = (step: OpeningStep): string =>
  step === "StoreDetails"
    ? t("your store's details")
    : step === "ReceiptDetails"
      ? t("your receipt details")
      : step === "Kitchen"
        ? t("the kitchen line")
        : step === "Tips"
          ? t("tips")
          : step === "Answers"
            ? t("your hours and order types")
            : step === "SoleOperator"
              ? t("approving on your own")
              : step === "Payment"
                ? t("the ways to pay")
                : step === "ReceiptTemplate"
                  ? t("the receipt")
                  : step === "AllergenList"
                    ? t("the allergen list")
                    : t("the store setup");
const gateWords = (gate: OpeningGate): string =>
  gate === "ReceiptTemplate"
    ? t("the receipt")
    : gate === "AllergenList"
      ? t("the allergen list")
      : t("the store setup");
const nameOf = (person: OpeningApprover) => person.displayName ?? t("another staff member");
const listOf = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : t("{items} and {last}", {
        items: items.slice(0, -1).join(listSeparator()),
        last: items.at(-1) ?? "",
      });
const peopleOf = (waits: readonly OpeningWait[]) =>
  listOf([...new Set(waits.flatMap((wait) => wait.who.map(nameOf)))]);
const missingWords = (missing: OpeningMissing): string =>
  missing === "TaxRates"
    ? t("Waiting for BOP support to set your tax rates.")
    : t("Waiting for BOP support to approve this store to open.");
const problemWords = (problem: OpeningHoursProblem): string =>
  problem === "NoServiceMode"
    ? t("Choose dine-in, pickup or both.")
    : problem === "NoOpenDay"
      ? t("Choose at least one day you open.")
      : problem === "TimeMissing"
        ? t("Enter when you open and close.")
        : problem === "SameTimes"
          ? t("Opening and closing can't be the same time.")
          : problem === "PeriodsOverlap"
            ? t("The two opening periods overlap.")
            : problem === "LastOrders"
              ? t("Enter last orders as whole minutes, from 0 to 1,440.")
              : t("Enter preparation time as whole minutes, from 0 to 1,440.");
const clock = (value: string) => value.slice(0, 5);
function intervalWords(
  interval: StoreConfigurationSnapshot["weeklySchedule"][number]["intervals"][number],
) {
  return `${clock(interval.startLocalTime)}–${clock(interval.endLocalTime)}${
    interval.endsNextDay ? t(" (next day)") : ""
  }`;
}
/** Consecutive days with the same hours on one line; "Every day" when they all are. */
export function openingHoursLines(
  schedule: StoreConfigurationSnapshot["weeklySchedule"],
): readonly string[] {
  const names = weekdays();
  const words = schedule.map((day) =>
    day.intervals.length === 0
      ? t("closed")
      : day.intervals.map(intervalWords).join(listSeparator()),
  );
  const first = words[0];
  if (first !== undefined && words.every((text) => text === first))
    return [t("Every day: {hours}", { hours: first })];
  const lines: string[] = [];
  for (let from = 0; from < words.length;) {
    let to = from;
    while (to + 1 < words.length && words[to + 1] === words[from]) to += 1;
    const days =
      from === to
        ? (names[from] ?? "")
        : t("{from} to {to}", { from: names[from] ?? "", to: names[to] ?? "" });
    lines.push(t("{days}: {hours}", { days, hours: words[from] ?? "" }));
    from = to + 1;
  }
  return lines;
}
const paymentWords = (payment: OpeningConfirmation["payment"]) => {
  const ways = listOf([
    ...(payment.customerOnlineCardEnabled ? [t("card on the guest's phone")] : []),
    ...(payment.staffTerminalCardPresentEnabled ? [t("card on your card machine")] : []),
    ...(payment.staffTerminalInteracEnabled ? [t("Interac on your card machine")] : []),
  ]);
  // The start of a sentence on the page.
  return ways.charAt(0).toUpperCase() + ways.slice(1);
};
const feeWords = (fees: OpeningConfirmation["fees"]) => {
  const on = (charge: string) =>
    fees.some((fee) => fee.chargeType === charge && fee.state === "Enabled");
  const serviceCharge = on("ServiceCharge"),
    deliveryFee = on("DeliveryFee");
  return !serviceCharge && !deliveryFee
    ? t("Service charge and delivery fee: off.")
    : serviceCharge && deliveryFee
      ? t("Service charge and delivery fee: on, as you set them in the step-by-step settings.")
      : serviceCharge
        ? t("Service charge: on, as you set it in the step-by-step settings. Delivery fee: off.")
        : t("Delivery fee: on, as you set it in the step-by-step settings. Service charge: off.");
};

function OpeningSummary({
  heading,
  confirmation,
  addressText,
  offerTips,
  tierPercents,
  allergens,
}: {
  readonly heading: string;
  readonly confirmation: OpeningConfirmation;
  readonly addressText: string;
  readonly offerTips: boolean;
  readonly tierPercents: readonly number[];
  /** The list's names; null when the Brand already has one, undefined when the brand owner does. */
  readonly allergens: readonly string[] | null | undefined;
}) {
  const rows: readonly (readonly [string, ReactNode])[] = [
    [
      t("Store"),
      `${confirmation.name}, ${addressText}, ${formatStorePhone(confirmation.phone === "" ? null : "+1" + confirmation.phone)}`,
    ],
    [t("Order types"), confirmation.serviceModes.map(serviceModeText).join(listSeparator())],
    [
      t("Opening hours"),
      <>
        {openingHoursLines(confirmation.weeklySchedule).map((line) => (
          <span key={line} className="store-opening__line">
            {line}
          </span>
        ))}
        <span className="store-opening__line">
          {t("Last orders {cutoff} minutes before closing. Preparation {lead} minutes.", {
            cutoff:
              (confirmation.weeklySchedule.flatMap((day) => day.intervals)[0]?.orderCutoffSeconds ??
                0) / 60,
            lead:
              (confirmation.weeklySchedule.flatMap((day) => day.intervals)[0]?.leadTimeSeconds ??
                0) / 60,
          })}
        </span>
      </>,
    ],
    [
      t("Time"),
      t("Times are in {timeZone}. The business day starts at {start}.", {
        timeZone: timeZoneLabel(confirmation.timeZone),
        start: clock(confirmation.businessDayStart),
      }),
    ],
    [
      t("Holidays"),
      confirmation.exceptions.length === 0
        ? t("None yet. You add them later in Hours & ordering.")
        : t("{count} special dates, as saved.", { count: confirmation.exceptions.length }),
    ],
    [
      t("Tips"),
      offerTips
        ? t(
            "Offered at {low}%, {mid}% and {high}% or another amount. Nothing is chosen for the guest, and No tip is always there.",
            { low: tierPercents[0] ?? 0, mid: tierPercents[1] ?? 0, high: tierPercents[2] ?? 0 },
          )
        : t("Not offered."),
    ],
    [t("Charges"), feeWords(confirmation.fees)],
    [t("Tax rates"), t("Set by BOP support for your province.")],
    [
      t("Receipts"),
      t("The standard receipt, in {language}. A tax or legal professional has not checked it.", {
        language: languageName(confirmation.receiptLocale),
      }),
    ],
    [
      t("Ways to pay"),
      t("{ways}. Card payments also need your payment account.", {
        ways: paymentWords(confirmation.payment),
      }),
    ],
    ...(confirmation.serviceModes.includes("Pickup")
      ? ([
          [t("Pickup orders"), t("Up to 20 orders an hour. Ask BOP support to change it.")],
        ] as const)
      : []),
    [
      t("Allergen list"),
      allergens === undefined
        ? t("Your brand owner approves this list.")
        : allergens === null
          ? t("Already approved.")
          : allergens.join(listSeparator()),
    ],
    [t("Takes effect"), t("As soon as it is published, with no end date.")],
  ];
  return (
    <section className="store-opening__summary" aria-labelledby="store-opening-summary">
      <h4 id="store-opening-summary">{heading}</h4>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PeriodsEditor({
  label,
  periods,
  disabled,
  onChange,
}: {
  /** Says whose periods these are to a screen reader (a day's name), when more than one set shows. */
  readonly label: string | null;
  readonly periods: readonly OpeningPeriod[];
  readonly disabled: boolean;
  readonly onChange: (periods: readonly OpeningPeriod[]) => void;
}) {
  const change = (index: number, change: Partial<OpeningPeriod>) =>
    onChange(periods.map((period, at) => (at === index ? { ...period, ...change } : period)));
  return (
    <div className="store-opening__periods">
      {periods.map((period, index) => {
        const prefix = (text: string) => (label === null ? text : `${label} ${text}`);
        return (
          <div className="store-opening__period" key={index}>
            <label>
              <span className={label === null ? undefined : "store-opening__sr"}>
                {prefix(index === 0 ? t("Opens") : t("Opens again"))}
              </span>
              <input
                type="time"
                value={period.start}
                disabled={disabled}
                onChange={(event) => change(index, { start: event.currentTarget.value })}
              />
            </label>
            <label>
              <span className={label === null ? undefined : "store-opening__sr"}>
                {prefix(index === 0 ? t("Closes") : t("Closes again"))}
              </span>
              <input
                type="time"
                value={period.end}
                disabled={disabled}
                onChange={(event) => change(index, { end: event.currentTarget.value })}
              />
            </label>
            {period.start !== "" && period.end !== "" && openingPeriodEndsNextDay(period) ? (
              <span className="store-opening__hint">{t("Closes the next day")}</span>
            ) : null}
            {index > 0 ? (
              <button
                type="button"
                className="store-opening__text-button"
                disabled={disabled}
                onClick={() => onChange(periods.filter((_, at) => at !== index))}
              >
                {t("Remove")}
                <span className="store-opening__sr">{prefix(t("second opening period"))}</span>
              </button>
            ) : null}
          </div>
        );
      })}
      {periods.length < 2 ? (
        <button
          type="button"
          className="store-opening__text-button"
          disabled={disabled}
          onClick={() => onChange([...periods, { start: "", end: "" }])}
        >
          {t("Add a second opening period")}
          {label === null ? null : <span className="store-opening__sr"> {label}</span>}
        </button>
      ) : null}
    </div>
  );
}
function OpeningHoursEditor({
  hours,
  disabled,
  onChange,
}: {
  readonly hours: OpeningHours;
  readonly disabled: boolean;
  readonly onChange: (hours: OpeningHours) => void;
}) {
  const names = weekdays();
  const setDay = (index: number, change: Partial<OpeningHours["days"][number]>) =>
    onChange({
      ...hours,
      days: hours.days.map((day, at) => (at === index ? { ...day, ...change } : day)),
    });
  return (
    <fieldset className="store-opening__part" disabled={disabled}>
      <legend>{t("Opening hours")}</legend>
      <div className="store-opening__choices" role="radiogroup" aria-label={t("Opening hours")}>
        <label>
          <input
            type="radio"
            name="store-opening-same-hours"
            checked={hours.sameEveryDay}
            onChange={() => onChange({ ...hours, sameEveryDay: true })}
          />
          {t("The same hours every day I open")}
        </label>
        <label>
          <input
            type="radio"
            name="store-opening-same-hours"
            checked={!hours.sameEveryDay}
            onChange={() =>
              onChange({
                ...hours,
                sameEveryDay: false,
                // Starts from the same hours: most days only differ a little.
                days: hours.days.map((day) => ({ ...day, periods: hours.everyDay })),
              })
            }
          />
          {t("Different hours by day")}
        </label>
      </div>
      {hours.sameEveryDay ? (
        <>
          <PeriodsEditor
            label={null}
            periods={hours.everyDay}
            disabled={disabled}
            onChange={(everyDay) => onChange({ ...hours, everyDay })}
          />
          <fieldset className="store-opening__days">
            <legend>{t("Days you open")}</legend>
            {names.map((name, index) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={hours.days[index]?.open ?? false}
                  onChange={(event) => setDay(index, { open: event.currentTarget.checked })}
                />
                {name}
              </label>
            ))}
          </fieldset>
        </>
      ) : (
        <div className="store-opening__by-day">
          {names.map((name, index) => {
            const day = hours.days[index];
            if (day === undefined) return null;
            return (
              <div className="store-opening__day" key={name}>
                <label className="store-opening__day-name">
                  <input
                    type="checkbox"
                    checked={day.open}
                    onChange={(event) => setDay(index, { open: event.currentTarget.checked })}
                  />
                  {name}
                </label>
                {day.open ? (
                  <PeriodsEditor
                    label={name}
                    periods={day.periods}
                    disabled={disabled}
                    onChange={(periods) => setDay(index, { periods })}
                  />
                ) : (
                  <span className="store-opening__hint">{t("Closed")}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="store-opening__row">
        <label>
          {t("Last orders (minutes before closing)")}
          <input
            inputMode="numeric"
            value={hours.lastOrdersMinutes}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...hours, lastOrdersMinutes: event.currentTarget.value })
            }
          />
        </label>
        <label>
          {t("Preparation time (minutes)")}
          <input
            inputMode="numeric"
            value={hours.preparationMinutes}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...hours, preparationMinutes: event.currentTarget.value })
            }
          />
        </label>
      </div>
    </fieldset>
  );
}

const emptyDetails = (): OpeningDetails => ({
  names: {},
  addressLines: ["", ""],
  locality: "",
  regionCode: "",
  postalCode: "",
  phone: "",
  businessName: "",
  gstHstNumber: "",
  qstNumber: "",
  pstNumber: "",
});
function detailsFrom(facts: OpeningFacts): OpeningDetails {
  const current = facts.profile.current;
  const lines = [...(current?.address.addressLines ?? [])];
  while (lines.length < 2) lines.push("");
  return {
    names: Object.fromEntries(
      facts.profile.locales.map((locale) => [
        locale,
        current?.names.find((entry) => entry.locale === locale)?.storeDisplayName ?? "",
      ]),
    ),
    addressLines: lines,
    locality: current?.address.locality ?? "",
    regionCode: current?.address.regionCode ?? "",
    postalCode: current?.address.postalCode ?? "",
    phone: formatStorePhone(current?.businessPhone ?? null),
    // The Brand's name is offered until the Owner saves the business's own.
    businessName: facts.receipts.issuer.businessName ?? facts.receipts.issuer.suggestedBusinessName,
    gstHstNumber: facts.receipts.details.gstHstNumber ?? "",
    qstNumber: facts.receipts.details.qstNumber ?? "",
    pstNumber: facts.receipts.details.pstNumber ?? "",
  };
}
function answersFrom(facts: OpeningFacts): OpeningAnswers {
  const recorded = openingAnswersFromRecords(openingContentOf(facts), facts.live.current);
  return {
    serviceModes: recorded?.serviceModes ?? [],
    hours: recorded?.hours ?? emptyOpeningHours(),
    offerTips: facts.features.tips.enabled,
  };
}
const pstProvinces: ReadonlySet<string> = new Set(["BC", "SK", "MB"]);
function stopWords(outcome: Extract<StoreOpeningOutcome, { kind: "Stopped" }>): string {
  const carryOn = t(
    "What was done stays. Press Continue, here or on another device; nothing is done twice.",
  );
  switch (outcome.code) {
    case "Denied":
      return t("Your sign-in does not allow {step}. Ask the Owner to open this page.", {
        step: stepWords(outcome.step),
      });
    case "SoleOperatorNeedsVerification":
      return t("Your check is more than 15 minutes old. Press Continue and enter a new code.");
    case "NeedsPhone":
      return t("Enter the store's phone number, then press the button again.");
    case "HoursNotAnswered":
      return t("Answer the opening hours and order types, then press the button again.");
    case "AnotherAuthorDraft":
      return t(
        "Someone else started publishing this and has not sent it yet. They open this page and press the button to carry on.",
      );
    case "OpenChangeByAnother":
      return t(
        "Someone else's change to this store is still waiting. It has to be approved or declined first; see All settings, step by step.",
      );
    case "NoAllergenTemplate":
      return t("BOP support has to set up the allergen list for your country first.");
    case "NotBrandOwner":
      return t("Only the brand owner can approve these alone. Ask them to open this page.");
    case "ChecksFailed":
      return t("{step} can't be published yet: {checks}. {carryOn}", {
        step: stepWords(outcome.step),
        checks: (outcome.failedChecks ?? [])
          .map((code) =>
            code === "Tax"
              ? t("your tax rates are not in force")
              : code === "GoLive"
                ? t("BOP support has not approved this store to open")
                : code === "Hours"
                  ? t("the opening hours need another look")
                  : t("a setting differs from the live store"),
          )
          .join(listSeparator()),
        carryOn,
      });
    case "OutcomeUnknown":
      return t("We couldn't confirm {step}. {carryOn}", {
        step: stepWords(outcome.step),
        carryOn,
      });
    default:
      return t("This stopped at {step}. {carryOn}", { step: stepWords(outcome.step), carryOn });
  }
}

export function StoreFirstOpeningPanel({
  scope,
  locale,
  csrf,
  fetcher,
  onChanged,
  onPublished,
  onNoFirstConfiguration,
  registerProfileSync,
}: {
  readonly scope: StoreSetupScope;
  readonly locale: string;
  readonly csrf: string;
  readonly fetcher?: typeof fetch;
  /** What is saved moved on: the folded settings read again. */
  readonly onChanged: () => void;
  readonly onPublished: (outcome: Extract<StoreOpeningOutcome, { kind: "Published" }>) => void;
  /** A Store with no configuration to start from: only the step-by-step settings can go on. */
  readonly onNoFirstConfiguration: () => void;
  /** The folded name-and-address panel published: Store setup's own records follow it. */
  readonly registerProfileSync: (sync: (() => void) | null) => void;
}) {
  const operations = useRef<StoreOpeningDeps["operations"]>(new Map());
  const deps = useRef<StoreOpeningDeps | null>(null);
  const [state, setState] = useState<"Loading" | "Ready" | "Failed">("Loading");
  const [facts, setFacts] = useState<OpeningFacts | null>(null);
  const [details, setDetails] = useState<OpeningDetails>(emptyDetails);
  const [answers, setAnswers] = useState<OpeningAnswers>(() => ({
    serviceModes: [],
    hours: emptyOpeningHours(),
    offerTips: true,
  }));
  const touched = useRef(false);
  // The tick is given to what was shown, and to nothing else: the summary it was given to, exactly.
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  const [verifiedUntil, setVerifiedUntil] = useState<string | null>(null);
  const [progress, setProgress] = useState<OpeningStep | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<StoreOpeningOutcome | null>(null);
  const [saved, setSaved] = useState(false);
  const openCode = useRef<(() => void) | null>(null);
  const afterCode = useRef<(() => void) | null>(null);
  const read = useCallback(
    async (fill: "All" | "Untouched" | "Profile") => {
      const current = deps.current;
      if (current === null) return;
      try {
        const next = await loadOpeningFacts(current);
        if (current.signal.aborted) return;
        setFacts(next);
        if (fill === "All" || (fill === "Untouched" && !touched.current)) {
          setDetails(detailsFrom(next));
          setAnswers(answersFrom(next));
        } else if (fill === "Profile") {
          const from = detailsFrom(next);
          setTickedFor(null);
          setDetails((old) => ({
            ...from,
            businessName: old.businessName,
            gstHstNumber: old.gstHstNumber,
            qstNumber: old.qstNumber,
            pstNumber: old.pstNumber,
          }));
        }
        setVerifiedUntil((held) => held ?? next.soleOperator?.verifiedUntil ?? null);
        setState("Ready");
        if (next.live.current === null) onNoFirstConfiguration();
      } catch {
        // Once the page is up a failed read changes nothing on it: what was typed stays, and the
        // next press reads again.
        if (!current.signal.aborted) setState((old) => (old === "Ready" ? old : "Failed"));
      }
    },
    [onNoFirstConfiguration],
  );
  const scopeKey = canonical(scope);
  useEffect(() => {
    const controller = new AbortController();
    deps.current = createStoreOpeningDeps({
      scope,
      csrf,
      locale,
      signal: controller.signal,
      operations: operations.current,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
    setState("Loading");
    void read("All");
    registerProfileSync(() => {
      const held = deps.current;
      if (held === null) return;
      // A later press repairs a failure here: it syncs the same records first.
      void held.profile
        .load()
        .then(async (view) => {
          if (view.current !== null) await syncOpeningReferences(held, view.current);
        })
        .catch(() => undefined)
        .finally(() => void read("Profile"));
    });
    return () => {
      registerProfileSync(null);
      controller.abort();
    };
  }, [scopeKey, csrf, locale, fetcher, read, registerProfileSync]);

  const edit = {
    details: (change: Partial<OpeningDetails>) => {
      touched.current = true;
      setTickedFor(null);
      setDetails((old) => ({ ...old, ...change }));
    },
    answers: (change: Partial<OpeningAnswers>) => {
      touched.current = true;
      setTickedFor(null);
      setAnswers((old) => ({ ...old, ...change }));
    },
  };
  const profileErrors = useMemo(() => {
    const errors = storePublicProfileFieldErrors({
      names: { ...details.names },
      addressLines: [...details.addressLines],
      locality: details.locality,
      regionCode: details.regionCode,
      postalCode: details.postalCode,
      phone: details.phone,
    });
    // The contact Store setup records comes from it, and guests call it about their order.
    if (details.phone.trim() === "") errors.phone = t("Enter the store's phone number.");
    return errors;
  }, [details]);
  const receiptErrors = useMemo(
    () =>
      receiptPrivacyFieldErrors({
        businessName: details.businessName,
        gstHstNumber: details.gstHstNumber,
        qstNumber: details.qstNumber,
        pstNumber: details.pstNumber,
        privacyNoticeUrl: "",
      }),
    [details],
  );
  const problems = useMemo(() => openingAnswerProblems(answers), [answers]);

  if (state === "Loading")
    return (
      <section id="store-opening" className="store-opening" aria-busy="true">
        <p role="status">{t("Loading your store…")}</p>
      </section>
    );
  if (state === "Failed" || facts === null)
    return (
      <section id="store-opening" className="store-opening">
        <p role="alert">{t("This didn't load. Try again.")}</p>
        <button
          type="button"
          className="store-opening__primary"
          onClick={() => {
            setState("Loading");
            void read("All");
          }}
        >
          {t("Try again")}
        </button>
      </section>
    );
  if (facts.live.current === null)
    return (
      <section id="store-opening" className="store-opening">
        <p role="note">
          {t(
            "BOP support has not installed this store's first settings yet, so the short way is not available. The step-by-step settings below still work.",
          )}
        </p>
      </section>
    );

  const missing = openingMissing(facts.live);
  const { forYou, forOthers } = openingWaitsFromFacts(facts);
  // Who decides what: a gate nobody else holds is this Owner's alone, and takes the tick.
  const aloneFor = {
    receiptTemplate: facts.approvers.receiptTemplate.length === 0,
    storeSetup: facts.approvers.storeSetup.length === 0,
    allergenList:
      facts.approvers.allergenList.length === 0 &&
      facts.allergens?.permissions.mayManageRegistry === true,
  };
  const aloneGates: readonly OpeningGate[] = [
    ...(aloneFor.receiptTemplate ? (["ReceiptTemplate"] as const) : []),
    ...(aloneFor.allergenList ? (["AllergenList"] as const) : []),
    ...(aloneFor.storeSetup ? (["StoreSetup"] as const) : []),
  ];
  const approvesAlone = aloneGates.length > 0;
  const soleOperatorOff = facts.soleOperator?.state !== "On";
  // Sole operator is the Brand Owner's to turn on; anyone else can only ask them.
  const needsBrandOwner = approvesAlone && facts.soleOperator === null;
  const detailsValid =
    Object.keys(profileErrors).length === 0 && Object.keys(receiptErrors).length === 0;
  const answered = problems.length === 0;
  const saveOnly = missing.length > 0;
  const confirmation =
    !saveOnly && answered && detailsValid
      ? openingConfirmationFromFacts(facts, details, answers)
      : null;
  const ticked = confirmation !== null && tickedFor === canonical(confirmation);
  const verified = verifiedUntil !== null && Date.parse(verifiedUntil) > Date.now();
  const needsCode = !saveOnly && approvesAlone;
  const allergenNames =
    facts.allergens === null
      ? undefined
      : facts.allergens.registry !== null
        ? null
        : facts.allergens.registryTemplate.allergens.map((entry) =>
            allergenName(entry.code, entry.name),
          );
  const addressText = [
    details.addressLines.filter((line) => line.trim() !== "").join(", "),
    details.locality,
    details.regionCode,
    details.postalCode,
  ]
    .filter((part) => part !== "")
    .join(", ");

  const start = async (input: Parameters<typeof runStoreOpening>[1]) => {
    const current = deps.current;
    if (current === null || running) return;
    setRunning(true);
    setOutcome(null);
    setSaved(false);
    const result = await runStoreOpening(current, input, setProgress);
    setRunning(false);
    setProgress(null);
    if (current.signal.aborted) return;
    onChanged();
    if (result.kind === "Published") {
      onPublished(result);
      return;
    }
    setOutcome(result);
    if (result.kind === "DetailsSaved") setSaved(true);
    if (result.kind === "ConfirmAgain") setTickedFor(null);
    // The server says the check has run out, whatever this page last knew: ask for a new code.
    if (result.kind === "Stopped" && result.code === "SoleOperatorNeedsVerification")
      setVerifiedUntil(null);
    // All saved: the page shows it as the server keeps it. Otherwise what was typed stays on the page.
    if (result.kind === "Waiting" || (result.kind === "DetailsSaved" && problems.length === 0))
      touched.current = false;
    await read("Untouched");
  };
  const pressAnswers = () => {
    const input = {
      details,
      answers,
      confirmed: confirmation,
      approveAlone: needsCode,
      approveOthers: false,
      approvers: facts.approvers,
    };
    if (needsCode && !verified) {
      afterCode.current = () => void start(input);
      openCode.current?.();
      return;
    }
    void start(input);
  };
  const pressApprove = () =>
    void start({
      details: null,
      answers: null,
      confirmed: null,
      approveAlone: false,
      approveOthers: true,
      approvers: facts.approvers,
    });

  const waitingLine =
    forOthers.length > 0
      ? t("Waiting for {people} to approve {what}. They open Store setup and press Approve.", {
          people: peopleOf(forOthers),
          what: listOf(forOthers.map((wait) => gateWords(wait.what))),
        })
      : null;
  const recordedAnswers: Pick<OpeningAnswers, "serviceModes" | "hours"> | null = (() => {
    // What the other Owner saved, for whoever reads it next.
    const content = openingContentOf(facts);
    return content.weeklySchedule.state === "Configured" &&
      content.enabledServiceModes.state === "Configured"
      ? openingAnswersFromRecords(content, null)
      : null;
  })();
  const recordedSummary =
    recordedAnswers === null
      ? null
      : openingConfirmationFromFacts(facts, detailsFrom(facts), recordedAnswers);
  const summaryOf = (heading: string, value: OpeningConfirmation, shownAddress: string) => (
    <OpeningSummary
      heading={heading}
      confirmation={value}
      addressText={shownAddress}
      offerTips={answers.offerTips}
      tierPercents={facts.features.tips.tierPercents}
      allergens={allergenNames}
    />
  );
  const profileAddress = (() => {
    const address = facts.profile.current?.address;
    return address === undefined
      ? ""
      : [address.addressLines.join(", "), address.locality, address.regionCode, address.postalCode]
          .filter((part) => part !== "")
          .join(", ");
  })();
  const status = (
    <>
      {running && progress !== null ? (
        <p role="status" className="store-opening__progress">
          {t("Working on {step}…", { step: stepWords(progress) })}
        </p>
      ) : null}
      {outcome?.kind === "Stopped" ? (
        outcome.code === "FullSignInRequired" ? (
          <FullSignInPrompt csrf={csrf} {...(fetcher === undefined ? {} : { fetcher })} />
        ) : (
          <p role="alert">{stopWords(outcome)}</p>
        )
      ) : null}
      {outcome?.kind === "ConfirmAgain" ? (
        <p role="alert">
          {t("Something changed since you checked this list. Read it again and tick the box.")}
        </p>
      ) : null}
    </>
  );

  if (forYou.length > 0)
    return (
      <section id="store-opening" className="store-opening" aria-labelledby="store-opening-heading">
        <h3 id="store-opening-heading">{t("Open your store")}</h3>
        <p className="store-opening__lead">
          {t("Waiting for you: {what}.", { what: listOf(forYou.map(gateWords)) })}{" "}
          {t(
            "The other Owner answered these. Check them; pressing Approve records it as approved by you.",
          )}
        </p>
        {recordedSummary === null
          ? null
          : summaryOf(t("What you are approving"), recordedSummary, profileAddress)}
        {status}
        <div className="store-opening__actions">
          <button
            type="button"
            className="store-opening__primary"
            disabled={running}
            onClick={pressApprove}
          >
            {running ? t("Working…") : t("Approve and continue")}
          </button>
        </div>
      </section>
    );
  if (waitingLine !== null)
    return (
      <section id="store-opening" className="store-opening" aria-labelledby="store-opening-heading">
        <h3 id="store-opening-heading">{t("Open your store")}</h3>
        <p className="store-opening__lead">{waitingLine}</p>
        {recordedSummary === null
          ? null
          : summaryOf(t("What was sent"), recordedSummary, profileAddress)}
        {status}
        <div className="store-opening__actions">
          <button
            type="button"
            className="store-opening__text-button"
            disabled={running}
            onClick={() => void read("Untouched")}
          >
            {t("Check again")}
          </button>
        </div>
      </section>
    );

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (next: string) => void,
    options: {
      readonly error?: string | undefined;
      readonly hint?: string;
      readonly autoComplete?: string;
      readonly tel?: boolean;
    } = {},
  ) => {
    const domId = "store-opening-" + id;
    // An empty field is only asked for by the list under the button; a wrong one is said here.
    const error = value.trim() === "" ? undefined : options.error;
    const described = [
      options.hint === undefined ? null : domId + "-hint",
      error === undefined ? null : domId + "-error",
    ].filter((item) => item !== null);
    return (
      <div className="store-opening__field" key={id}>
        <label htmlFor={domId}>{label}</label>
        <input
          id={domId}
          type={options.tel === true ? "tel" : "text"}
          inputMode={options.tel === true ? "tel" : "text"}
          autoComplete={options.autoComplete ?? "off"}
          value={value}
          disabled={running}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={described.length > 0 ? described.join(" ") : undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        {options.hint === undefined ? null : (
          <p id={domId + "-hint"} className="store-opening__hint">
            {options.hint}
          </p>
        )}
        {error === undefined ? null : (
          <p id={domId + "-error"} className="store-opening__error">
            {error}
          </p>
        )}
      </div>
    );
  };
  const blockers = [
    ...(detailsValid ? [] : [t("your store's name, address, phone and business name")]),
    ...(answers.serviceModes.length === 0 ? [t("dine-in, pickup or both")] : []),
    ...(problems.some((problem) => problem !== "NoServiceMode") ? [t("your opening hours")] : []),
    ...(!saveOnly && !needsBrandOwner && approvesAlone && !ticked ? [t("the box above")] : []),
  ];
  const canPress = saveOnly
    ? Object.keys(profileErrors).length === 0 && Object.keys(receiptErrors).length === 0
    : blockers.length === 0 && !needsBrandOwner;
  const othersNamed = peopleOf(
    (["ReceiptTemplate", "StoreSetup", "AllergenList"] as const).flatMap((what) => {
      const who =
        what === "ReceiptTemplate"
          ? facts.approvers.receiptTemplate
          : what === "StoreSetup"
            ? facts.approvers.storeSetup
            : facts.approvers.allergenList;
      return who.length > 0 ? [{ what, who }] : [];
    }),
  );
  return (
    <section id="store-opening" className="store-opening" aria-labelledby="store-opening-heading">
      <h3 id="store-opening-heading">{t("Open your store")}</h3>
      <p className="store-opening__lead">
        {t(
          "Answer these once and press the button at the end. Guests can order after that, once your menu is listed and your tables have codes.",
        )}
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canPress && !running) pressAnswers();
        }}
      >
        <fieldset className="store-opening__part" disabled={running}>
          <legend>{t("Your store")}</legend>
          {facts.profile.locales.map((language) =>
            field(
              "name-" + language,
              facts.profile.locales.length > 1
                ? t("Store name customers see ({locale})", { locale: languageName(language) })
                : t("Store name customers see"),
              details.names[language] ?? "",
              (next) => edit.details({ names: { ...details.names, [language]: next } }),
              { error: profileErrors["name-" + language] },
            ),
          )}
          {field(
            "line-0",
            t("Street address"),
            details.addressLines[0] ?? "",
            (next) =>
              edit.details({
                addressLines: details.addressLines.map((line, at) => (at === 0 ? next : line)),
              }),
            { error: profileErrors["line-0"], autoComplete: "address-line1" },
          )}
          {field(
            "line-1",
            t("Unit or suite (optional)"),
            details.addressLines[1] ?? "",
            (next) =>
              edit.details({
                addressLines: details.addressLines.map((line, at) => (at === 1 ? next : line)),
              }),
            { error: profileErrors["line-1"], autoComplete: "address-line2" },
          )}
          <div className="store-opening__row">
            {field(
              "locality",
              t("City or town"),
              details.locality,
              (next) => edit.details({ locality: next }),
              { error: profileErrors.locality, autoComplete: "address-level2" },
            )}
            <div className="store-opening__field">
              <label htmlFor="store-opening-regionCode">{t("Province or territory")}</label>
              <select
                id="store-opening-regionCode"
                value={details.regionCode}
                disabled={running}
                onChange={(event) => edit.details({ regionCode: event.currentTarget.value })}
              >
                <option value="">{t("Choose…")}</option>
                {facts.profile.regionCodes.map((code) => (
                  <option key={code} value={code}>
                    {provinceNames[code] ?? code}
                  </option>
                ))}
              </select>
            </div>
            {field(
              "postalCode",
              t("Postal code"),
              details.postalCode,
              (next) => edit.details({ postalCode: next }),
              { error: profileErrors.postalCode, autoComplete: "postal-code" },
            )}
          </div>
          {field(
            "phone",
            t("Store phone number"),
            details.phone,
            (next) => edit.details({ phone: next }),
            {
              error: profileErrors.phone,
              hint: t("Guests call this number about their order, and it goes on your receipts."),
              autoComplete: "tel",
              tel: true,
            },
          )}
        </fieldset>
        <fieldset className="store-opening__part" disabled={running}>
          <legend>{t("Receipts")}</legend>
          {field(
            "businessName",
            t("Business name on receipts"),
            details.businessName,
            (next) => edit.details({ businessName: next }),
            {
              error: receiptErrors.businessName,
              hint: t("The legal or operating name of the business, as registered."),
            },
          )}
          {field(
            "gstHstNumber",
            t("GST/HST registration number"),
            details.gstHstNumber,
            (next) => edit.details({ gstHstNumber: next }),
            {
              error: receiptErrors.gstHstNumber,
              hint: t(
                "For example 123456789RT0001. Leave empty if the business is not registered.",
              ),
            },
          )}
          {details.regionCode === "QC"
            ? field(
                "qstNumber",
                t("QST registration number (Québec only)"),
                details.qstNumber,
                (next) => edit.details({ qstNumber: next }),
                { error: receiptErrors.qstNumber },
              )
            : null}
          {pstProvinces.has(details.regionCode)
            ? field(
                "pstNumber",
                t("PST registration number (BC, Saskatchewan or Manitoba only)"),
                details.pstNumber,
                (next) => edit.details({ pstNumber: next }),
                { error: receiptErrors.pstNumber },
              )
            : null}
        </fieldset>
        {/* DEC-STORE-FIRST-OPENING: the store type step (a store type choice and optional feature
            templates, designed separately) goes here. It presets the answers below. */}
        <fieldset className="store-opening__part" disabled={running}>
          <legend>{t("Order types")}</legend>
          <div className="store-opening__choices">
            {(["DineIn", "Pickup"] as const).map((mode: OpeningServiceMode) => (
              <label key={mode}>
                <input
                  type="checkbox"
                  checked={answers.serviceModes.includes(mode)}
                  onChange={(event) =>
                    edit.answers({
                      serviceModes: event.currentTarget.checked
                        ? [...answers.serviceModes, mode]
                        : answers.serviceModes.filter((value) => value !== mode),
                    })
                  }
                />
                {serviceModeText(mode)}
              </label>
            ))}
          </div>
        </fieldset>
        <OpeningHoursEditor
          hours={answers.hours}
          disabled={running}
          onChange={(hours) => edit.answers({ hours })}
        />
        {problems.some((problem) => problem === "SameTimes" || problem === "PeriodsOverlap") ? (
          <p className="store-opening__error">
            {problemWords(problems.includes("SameTimes") ? "SameTimes" : "PeriodsOverlap")}
          </p>
        ) : null}
        <fieldset className="store-opening__part" disabled={running}>
          <legend>{t("Tips")}</legend>
          <label className="store-opening__tick">
            <input
              type="checkbox"
              checked={answers.offerTips}
              onChange={(event) => edit.answers({ offerTips: event.currentTarget.checked })}
            />
            <span>
              {t("Offer tips")}
              <span className="store-opening__hint">
                {t(
                  "Guests choose {low}%, {mid}%, {high}%, another amount or No tip; nothing is chosen for them. You can switch this at any time in Store features, and it works at once.",
                  {
                    low: facts.features.tips.tierPercents[0],
                    mid: facts.features.tips.tierPercents[1],
                    high: facts.features.tips.tierPercents[2],
                  },
                )}
              </span>
            </span>
          </label>
        </fieldset>
        {saveOnly ? (
          <section className="store-opening__waiting" aria-label={t("What you are waiting for")}>
            {missing.map((entry) => (
              <p key={entry} role="status">
                {missingWords(entry)}{" "}
                {saved || facts.profile.current !== null
                  ? t("Come back here once they have: nothing else is needed from you now.")
                  : t("Save your details first: they need your province.")}
              </p>
            ))}
          </section>
        ) : null}
        {confirmation === null
          ? null
          : summaryOf(t("What you are approving"), confirmation, addressText)}
        {needsBrandOwner && !saveOnly ? (
          <p role="note">
            {t("Only the brand owner can approve these alone. Ask them to open this page.")}
          </p>
        ) : null}
        {!saveOnly && othersNamed !== "" ? (
          <p className="store-opening__hint">
            {t("{people} also approves here, so they check what you send before it is published.", {
              people: othersNamed,
            })}
          </p>
        ) : null}
        {!saveOnly && approvesAlone && !needsBrandOwner ? (
          <label className="store-opening__tick">
            <input
              type="checkbox"
              checked={ticked}
              disabled={running || confirmation === null}
              onChange={(event) =>
                setTickedFor(
                  event.currentTarget.checked && confirmation !== null
                    ? canonical(confirmation)
                    : null,
                )
              }
            />
            <span>
              {othersNamed !== ""
                ? t(
                    "Only I can approve {what} here. I checked it and approve it on my own; it needs my code and is recorded as approved by me alone.",
                    { what: listOf(aloneGates.map(gateWords)) },
                  )
                : soleOperatorOff
                  ? t(
                      "I run this business on my own and approve the above. I will approve my own prices, menus, recipes, allergen lists, Store setup and larger refunds; each needs my code and is recorded as approved by me alone. If I add a second owner, they approve instead.",
                    )
                  : t(
                      "I checked the above and approve it on my own. Each is recorded as approved by me alone.",
                    )}
            </span>
          </label>
        ) : null}
        {status}
        <div className="store-opening__actions">
          <button
            type="submit"
            className="store-opening__primary"
            disabled={running || !canPress}
            aria-describedby={blockers.length > 0 ? "store-opening-blockers" : undefined}
          >
            {running
              ? t("Working…")
              : saveOnly
                ? t("Save my details")
                : outcome?.kind === "Stopped"
                  ? t("Continue")
                  : approvesAlone
                    ? t("Publish my store setup")
                    : t("Send for approval")}
          </button>
          {blockers.length > 0 && !saveOnly ? (
            <p id="store-opening-blockers" className="store-opening__hint">
              {t("Still to do: {items}.", { items: blockers.join(listSeparator()) })}
            </p>
          ) : null}
        </div>
      </form>
      {/* Not in the form: the verification dialog holds its own form. */}
      {needsCode ? (
        <StepUpVerification
          mode="dialog"
          openRef={openCode}
          purpose={soleOperatorOff ? "SoleOperatorSetting" : "SoleOperatorApproval"}
          csrf={csrf}
          verifiedUntil={verifiedUntil}
          loadServerStatus={false}
          label={t("Verify to approve on your own")}
          fetcher={fetcher}
          onVerified={(until) => {
            setVerifiedUntil(until);
            const next = afterCode.current;
            afterCode.current = null;
            next?.();
          }}
        />
      ) : null}
      {problems.includes("TimeMissing") || problems.length === 0 ? null : (
        <span className="store-opening__sr">{problems.map(problemWords).join(" ")}</span>
      )}
    </section>
  );
}
