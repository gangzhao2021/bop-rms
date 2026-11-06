import { allergenName, listSeparator, serviceModeText, t } from "./i18n/i18n.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
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
  openingAnswersInput,
  openingApprovableGates,
  openingApprovalPlan,
  openingApproveInput,
  openingConfirmationFromFacts,
  openingContentOf,
  openingListAfterPublish,
  openingMissing,
  openingPeriodEndsNextDay,
  openingSentSummary,
  openingWaitsFromFacts,
  runStoreOpening,
  sendOpeningBack,
  syncOpeningReferences,
  type OpeningAnswers,
  type OpeningApprover,
  type OpeningConfirmation,
  type OpeningDetails,
  type OpeningFacts,
  type OpeningGate,
  type OpeningHours,
  type OpeningHoursProblem,
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
const allergensHref = "/app/compliance/allergens";
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
  allergenRow,
}: {
  readonly heading: string;
  readonly confirmation: OpeningConfirmation;
  readonly addressText: string;
  readonly offerTips: boolean;
  readonly tierPercents: readonly number[];
  /** The list, and who approves it, as this page says it to this person. */
  readonly allergenRow: ReactNode;
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
    [t("Allergen list"), allergenRow],
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
  problems,
  disabled,
  onChange,
}: {
  readonly hours: OpeningHours;
  readonly problems: readonly OpeningHoursProblem[];
  readonly disabled: boolean;
  readonly onChange: (hours: OpeningHours) => void;
}) {
  const names = weekdays();
  // An empty box is asked for by the list under the button; what can't be read is said here.
  const minutes = (
    id: string,
    label: string,
    value: string,
    problem: "LastOrders" | "Preparation",
    change: (next: string) => void,
  ) => {
    const wrong = value.trim() !== "" && problems.includes(problem);
    return (
      <label>
        {label}
        <input
          inputMode="numeric"
          value={value}
          disabled={disabled}
          aria-invalid={wrong ? true : undefined}
          aria-describedby={wrong ? id : undefined}
          onChange={(event) => change(event.currentTarget.value)}
        />
        {wrong ? (
          <span id={id} className="store-opening__error store-opening__line">
            {problemWords(problem)}
          </span>
        ) : null}
      </label>
    );
  };
  const noDay = problems.includes("NoOpenDay") ? (
    <p className="store-opening__error">{problemWords("NoOpenDay")}</p>
  ) : null;
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
            {noDay}
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
          {noDay}
        </div>
      )}
      {problems.some((problem) => problem === "SameTimes" || problem === "PeriodsOverlap") ? (
        <p className="store-opening__error">
          {problemWords(problems.includes("SameTimes") ? "SameTimes" : "PeriodsOverlap")}
        </p>
      ) : null}
      <div className="store-opening__row">
        {minutes(
          "store-opening-last-orders-error",
          t("Last orders (minutes before closing)"),
          hours.lastOrdersMinutes,
          "LastOrders",
          (lastOrdersMinutes) => onChange({ ...hours, lastOrdersMinutes }),
        )}
        {minutes(
          "store-opening-preparation-error",
          t("Preparation time (minutes)"),
          hours.preparationMinutes,
          "Preparation",
          (preparationMinutes) => onChange({ ...hours, preparationMinutes }),
        )}
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
/** A publication check that failed, as what to do and who does it. */
export function checkWords(code: string): string {
  switch (code) {
    case "Tax":
      return t(
        "Waiting for BOP support: your tax rates are not in force. Tell BOP support, and come back here once they have set them; what you entered stays.",
      );
    case "GoLive":
      return t(
        "Waiting for BOP support: they have not approved this store to open yet. Tell BOP support, and come back here once they have; what you entered stays.",
      );
    case "Hours":
      return t(
        "The opening hours need another look: each day you open needs its times, for an order type you offer. Fix them above, then press the button again.",
      );
    case "Fees":
      return t(
        "A charge set under All settings, step by step is for an order type this store does not offer. Turn it off there, or offer that order type here, then press the button again.",
      );
    default:
      // The Brand's settings, the time zone, the business day start and the start date are not
      // asked on this page: BOP support sets them up.
      return t(
        "One of this store's settings does not match how BOP support set the store up. Tell BOP support what time this happened; what you entered stays.",
      );
  }
}
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
      // Each check says who acts: BOP support's never ends in "press Continue", which would only
      // stop the same way again.
      return [
        t("{step} can't be published yet.", { step: stepWords(outcome.step) }),
        ...new Set((outcome.failedChecks ?? []).map(checkWords)),
      ].join(" ");
    case "OutcomeUnknown":
      return t("We couldn't confirm {step}. {carryOn}", {
        step: stepWords(outcome.step),
        carryOn,
      });
    default:
      return t("This stopped at {step}. {carryOn}", { step: stepWords(outcome.step), carryOn });
  }
}

/** The Store is published, by this press or already when it began. */
export type OpeningPublished = Extract<
  StoreOpeningOutcome,
  { readonly kind: "Published" | "AlreadyPublished" }
>;
/** Once published, who the allergen list still waits for, in words: this Owner, or the people named. */
export type OpeningListStill =
  { readonly kind: "You" } | { readonly kind: "Others"; readonly people: string } | null;
const listStill = (wait: OpeningWait | null): OpeningListStill =>
  wait === null
    ? null
    : wait.who.length === 0
      ? Object.freeze({ kind: "You" as const })
      : Object.freeze({ kind: "Others" as const, people: peopleOf([wait]) });
const testAllergenTemplate = "CA_PRIORITY_TEST";
export function StoreFirstOpeningPanel({
  scope,
  locale,
  csrf,
  fetcher,
  onChanged,
  onPublished,
  registerProfileSync,
}: {
  readonly scope: StoreSetupScope;
  readonly locale: string;
  readonly csrf: string;
  readonly fetcher?: typeof fetch;
  /** What is saved moved on: the folded settings read again. */
  readonly onChanged: () => void;
  /** Published, by this press or by anyone since this page last read: this page is over. */
  readonly onPublished: (outcome: OpeningPublished, list: OpeningListStill) => void;
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
  const [pressed, setPressed] = useState<"Answers" | "Approve" | null>(null);
  const [saved, setSaved] = useState(false);
  // Back on the form after something was sent, to correct it.
  const [changing, setChanging] = useState(false);
  const [sendBack, setSendBack] = useState<"Closed" | "Asking" | "Failed">("Closed");
  const openCode = useRef<(() => void) | null>(null);
  const afterCode = useRef<(() => void) | null>(null);
  const read = useCallback(
    async (fill: "All" | "Untouched" | "Profile") => {
      const current = deps.current;
      if (current === null) return;
      try {
        const next = await loadOpeningFacts(current);
        if (current.signal.aborted) return;
        // Published since this page last read, on another device or by the other Owner.
        if (next.live.current?.setupBasis !== undefined) {
          onPublished(
            Object.freeze({ kind: "Published", waits: Object.freeze([]) }),
            listStill(openingListAfterPublish(next, [])),
          );
          return;
        }
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
      } catch {
        // Once the page is up a failed read changes nothing on it: what was typed stays, and the
        // next press reads again.
        if (!current.signal.aborted) setState((old) => (old === "Ready" ? old : "Failed"));
      }
    },
    [onPublished],
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
        {/* The Store's settings can't be read at all once its approval to open has run out. */}
        <p>
          {t(
            "If it still doesn't load, tell BOP support: they may need to renew this store's approval to open.",
          )}
        </p>
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

  const missing = openingMissing(
    facts.live,
    facts.workspace.scope.actorReference,
    facts.taxRatesSet,
  );
  const waits = openingWaitsFromFacts(facts);
  // Who decides what, and what a press does about it: the same answer the press works from.
  const plan = openingApprovalPlan(facts);
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
  const needsCode = !saveOnly && plan.approveAlone;
  const addressText = [
    details.addressLines.filter((line) => line.trim() !== "").join(", "),
    details.locality,
    details.regionCode,
    details.postalCode,
  ]
    .filter((part) => part !== "")
    .join(", ");

  const start = async (
    input: Parameters<typeof runStoreOpening>[1],
    press: "Answers" | "Approve",
  ) => {
    const current = deps.current;
    if (current === null || running) return;
    setRunning(true);
    setOutcome(null);
    setSaved(false);
    setPressed(press);
    const result = await runStoreOpening(current, input, setProgress);
    setRunning(false);
    setProgress(null);
    if (current.signal.aborted) return;
    onChanged();
    if (result.kind === "Published" || result.kind === "AlreadyPublished") {
      onPublished(
        result,
        result.kind === "Published"
          ? listStill(openingListAfterPublish(facts, result.waits))
          : null,
      );
      return;
    }
    setOutcome(result);
    if (result.kind === "DetailsSaved") setSaved(true);
    if (result.kind === "ConfirmAgain") setTickedFor(null);
    // The server says the check has run out, whatever this page last knew: ask for a new code.
    if (result.kind === "Stopped" && result.code === "SoleOperatorNeedsVerification")
      setVerifiedUntil(null);
    // All saved: the page shows it as the server keeps it. Otherwise what was typed stays on the page.
    if (result.kind === "Waiting" || (result.kind === "DetailsSaved" && problems.length === 0)) {
      touched.current = false;
      setChanging(false);
    }
    await read("Untouched");
  };
  const pressAnswers = () => {
    const input = openingAnswersInput(facts, details, answers, confirmation);
    if (needsCode && !verified) {
      afterCode.current = () => void start(input, "Answers");
      openCode.current?.();
      return;
    }
    void start(input, "Answers");
  };
  const pressApprove = () => void start(openingApproveInput(facts), "Approve");
  const pressSendBack = () => {
    const current = deps.current;
    if (current === null || running) return;
    setRunning(true);
    void sendOpeningBack(current)
      .then(
        () => {
          touched.current = false;
          setSendBack("Closed");
        },
        () => setSendBack("Failed"),
      )
      .finally(() => {
        setRunning(false);
        onChanged();
        void read("Untouched");
      });
  };

  const listWho = (waits.listForOthers ?? plan.others.find((wait) => wait.what === "AllergenList"))
    ?.who;
  const allergenRow = () => {
    const list = facts.allergens;
    if (list === null) return t("Your brand owner approves this list.");
    if (list.registry !== null) return t("Already approved.");
    const note = waits.listForYou
      ? t("Someone else recorded this list. It is waiting for your approval on Allergens.")
      : plan.allergenListLater
        ? t("You approve this list on Allergens, after your store setup is published.")
        : listWho !== undefined && !waits.forYou.includes("AllergenList")
          ? t("{people} approves this list.", {
              people: peopleOf([{ what: "AllergenList", who: listWho }]),
            })
          : null;
    return (
      <>
        <span className="store-opening__line">
          {list.registryTemplate.allergens
            .map((entry) => allergenName(entry.code, entry.name))
            .join(listSeparator())}
        </span>
        {list.registryTemplate.template === testAllergenTemplate ? (
          <span className="store-opening__line">
            {t(
              "This is a test list based on Health Canada's priority allergens. Check it against current Health Canada guidance before real customers rely on it.",
            )}
          </span>
        ) : null}
        {note === null ? null : <span className="store-opening__line">{note}</span>}
      </>
    );
  };
  const waitingLine =
    waits.forOthers.length > 0
      ? t("Waiting for {people} to approve {what}. They open Store setup and press Approve.", {
          people: peopleOf(waits.forOthers),
          what: listOf(waits.forOthers.map((wait) => gateWords(wait.what))),
        })
      : null;
  // Nothing else waits on the list: said, with the way on still there.
  const listLine =
    waits.listForOthers !== null ? (
      <p className="store-opening__hint">
        {t("The allergen list is waiting for {people}. They approve it on Allergens.", {
          people: peopleOf([waits.listForOthers]),
        })}
      </p>
    ) : null;
  const sent = openingSentSummary(facts);
  const summaryOf = (heading: string, value: OpeningConfirmation, shownAddress: string) => (
    <OpeningSummary
      heading={heading}
      confirmation={value}
      addressText={shownAddress}
      offerTips={saveOnly || !changing ? facts.features.tips.enabled : answers.offerTips}
      tierPercents={facts.features.tips.tierPercents}
      allergenRow={allergenRow()}
    />
  );
  // The address as it was sent: from the records the version waiting points at, when one is.
  const sentAddress = (value: OpeningConfirmation) =>
    [
      value.address.lines.join(", "),
      value.address.locality,
      value.address.regionCode,
      // Kept without its space, for comparing: shown as Canada Post writes it.
      /^[A-Z]\d[A-Z]\d[A-Z]\d$/u.test(value.address.postalCode)
        ? value.address.postalCode.slice(0, 3) + " " + value.address.postalCode.slice(3)
        : value.address.postalCode,
    ]
      .filter((part) => part !== "")
      .join(", ");
  const tickShown = needsCode;
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
          {tickShown && pressed === "Answers"
            ? t("Something changed since you checked this list. Read it again and tick the box.")
            : t("Something changed since you read this. Read it again, then press the button.")}
        </p>
      ) : null}
    </>
  );
  // A press of the answers that stopped stays on what was typed, with Continue.
  const stoppedAnswers = outcome?.kind === "Stopped" && pressed === "Answers";
  const backToForm = () => {
    setOutcome(null);
    setChanging(true);
  };

  const approvable = openingApprovableGates(facts);
  const changedNote = waits.sentChanged ? (
    <p role="note">
      {waits.forYou.includes("StoreSetup")
        ? t(
            "The store's name, address or phone was changed after the store setup was sent, so it can't be approved as it is. Ask whoever sent it to open Store setup and send it again, or send it back.",
          )
        : t(
            "Your store's name, address or phone was changed after this was sent. Press Change my answers and send it again, so what is approved is what customers see.",
          )}
    </p>
  ) : null;
  if (waits.forYou.length > 0 && !changing && !stoppedAnswers)
    return (
      <section id="store-opening" className="store-opening" aria-labelledby="store-opening-heading">
        <h3 id="store-opening-heading">{t("Open your store")}</h3>
        <p className="store-opening__lead">
          {t("Waiting for you: {what}.", { what: listOf(waits.forYou.map(gateWords)) })}{" "}
          {t(
            "These were sent for your approval. Check them; pressing Approve records it as approved by you.",
          )}
        </p>
        {waitingLine === null ? null : <p>{waitingLine}</p>}
        {changedNote}
        {sent === null || waits.sentChanged
          ? null
          : summaryOf(t("What you are approving"), sent, sentAddress(sent))}
        {status}
        <div className="store-opening__actions">
          {approvable.length === 0 ? null : (
            <button
              type="button"
              className="store-opening__primary"
              disabled={running}
              onClick={pressApprove}
            >
              {running ? t("Working…") : t("Approve and continue")}
            </button>
          )}
          {!waits.forYou.includes("StoreSetup") ? (
            <button
              type="button"
              className="store-opening__text-button"
              disabled={running}
              onClick={backToForm}
            >
              {t("Change the answers")}
            </button>
          ) : sendBack === "Closed" ? (
            <button
              type="button"
              className="store-opening__text-button"
              disabled={running}
              onClick={() => setSendBack("Asking")}
            >
              {t("Send it back")}
            </button>
          ) : (
            <div className="store-opening__actions" role="group" aria-label={t("Send it back")}>
              {sendBack === "Failed" ? (
                <p role="alert">{t("This wasn't sent back. Try again.")}</p>
              ) : null}
              <p>
                {t(
                  "Send this back? It stays in the history and can't be approved or published. The answers then open here, to change and send again.",
                )}
              </p>
              <button
                type="button"
                className="store-opening__text-button"
                disabled={running}
                onClick={pressSendBack}
              >
                {t("Send it back now")}
              </button>
              <button
                type="button"
                className="store-opening__text-button"
                disabled={running}
                onClick={() => setSendBack("Closed")}
              >
                {t("Keep it")}
              </button>
            </div>
          )}
        </div>
      </section>
    );
  if (waitingLine !== null && !changing && !stoppedAnswers)
    return (
      <section id="store-opening" className="store-opening" aria-labelledby="store-opening-heading">
        <h3 id="store-opening-heading">{t("Open your store")}</h3>
        <p className="store-opening__lead">{waitingLine}</p>
        {listLine}
        {changedNote}
        {sent === null || waits.sentChanged
          ? null
          : summaryOf(t("What was sent"), sent, sentAddress(sent))}
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
          <button
            type="button"
            className="store-opening__text-button"
            disabled={running}
            onClick={backToForm}
          >
            {t("Change my answers")}
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
  // Named one by one: a faded button with no reason stops a new Owner on the first screen.
  const detailBlockers = [
    ...(Object.keys(profileErrors).some((key) => key.startsWith("name-"))
      ? [t("the store name")]
      : []),
    ...(profileErrors["line-0"] !== undefined || profileErrors["line-1"] !== undefined
      ? [t("the street address")]
      : []),
    ...(profileErrors.locality === undefined ? [] : [t("the city or town")]),
    ...(profileErrors.regionCode === undefined ? [] : [t("the province or territory")]),
    ...(profileErrors.postalCode === undefined ? [] : [t("the postal code")]),
    ...(profileErrors.phone === undefined ? [] : [t("the store phone number")]),
    ...(receiptErrors.businessName === undefined ? [] : [t("the business name on receipts")]),
    ...(receiptErrors.gstHstNumber === undefined ? [] : [t("the GST/HST number")]),
    ...(receiptErrors.qstNumber === undefined ? [] : [t("the QST number")]),
    ...(receiptErrors.pstNumber === undefined ? [] : [t("the PST number")]),
  ];
  // Saving needs only the details: half an answer about hours stays on the page until it is finished.
  const blockers = saveOnly
    ? detailBlockers
    : [
        ...detailBlockers,
        ...(answers.serviceModes.length === 0 ? [t("dine-in, pickup or both")] : []),
        ...(problems.includes("NoOpenDay") ? [t("the days you open")] : []),
        ...(problems.includes("TimeMissing") ? [t("when you open and close")] : []),
        ...(problems.includes("SameTimes") || problems.includes("PeriodsOverlap")
          ? [t("your opening hours")]
          : []),
        ...(problems.includes("LastOrders") ? [t("last orders")] : []),
        ...(problems.includes("Preparation") ? [t("preparation time")] : []),
        ...(needsCode && !ticked ? [t("the box above")] : []),
      ];
  const canPress = blockers.length === 0 && (saveOnly || !plan.needsBrandOwner);
  const storeOthers = peopleOf(plan.others.filter((wait) => wait.what !== "AllergenList"));
  return (
    <section id="store-opening" className="store-opening" aria-labelledby="store-opening-heading">
      <h3 id="store-opening-heading">{t("Open your store")}</h3>
      <p className="store-opening__lead">
        {changing
          ? t("Change what needs changing, then save. Whoever approves it sees the new answers.")
          : t(
              "Answer these once and press the button at the end. Guests can order after that, once your menu is listed and your tables have codes.",
            )}
      </p>
      {waits.ranOut ? (
        <p role="note">
          {t(
            "What was sent earlier ran out: it has to be approved and published within 14 days. Check these and press the button to send it again.",
          )}
        </p>
      ) : null}
      {waits.sentBack ? (
        <p role="note">{t("This was sent back. Change what needs changing and send it again.")}</p>
      ) : null}
      {waits.beforeAnswers.length > 0 ? (
        <p role="note">
          {t(
            "Someone sent {what} for your approval. Answer these first; you can then approve it on this page.",
            { what: listOf(waits.beforeAnswers.map(gateWords)) },
          )}
        </p>
      ) : null}
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
          problems={problems}
          disabled={running}
          onChange={(hours) => edit.answers({ hours })}
        />
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
            {missing.map((entry) =>
              entry === "TaxRates" ? (
                <p key={entry} role="status">
                  {t("Waiting for BOP support to set your tax rates.")}{" "}
                  {saved || facts.profile.current !== null
                    ? t("Come back here once they have: nothing else is needed from you now.")
                    : t("Save your details first: they need your province.")}
                </p>
              ) : (
                <p key={entry} role="status">
                  {t(
                    "Someone else's change to this store's hours is still waiting. It has to be approved or declined before this can go further.",
                  )}{" "}
                  <Link to={`/app/organization/stores/${scope.storeReference}/service`}>
                    {t("Decide it on Hours & ordering")}
                  </Link>
                </p>
              ),
            )}
          </section>
        ) : null}
        {confirmation === null
          ? null
          : summaryOf(t("What you are approving"), confirmation, addressText)}
        {plan.needsBrandOwner && !saveOnly ? (
          <p role="note">
            {t("Only the brand owner can approve these alone. Ask them to open this page.")}
          </p>
        ) : null}
        {!saveOnly && storeOthers !== "" ? (
          <p className="store-opening__hint">
            {t("{people} also approves here, so they check what you send before it is published.", {
              people: storeOthers,
            })}
          </p>
        ) : null}
        {!saveOnly && plan.allergenListLater ? (
          <p className="store-opening__hint">
            {t(
              "Only you hold allergen list approval, so it does not go to anyone with this. You approve it after your store setup is published.",
            )}{" "}
            <Link to={allergensHref}>{t("Open Allergens")}</Link>
          </p>
        ) : null}
        {waits.listForYou ? (
          <p className="store-opening__hint">
            {t("The allergen list is waiting for your approval.")}{" "}
            <Link to={allergensHref}>{t("Approve it on Allergens")}</Link>
          </p>
        ) : null}
        {listLine}
        {!saveOnly &&
        waits.listForOthers === null &&
        listWho !== undefined &&
        storeOthers === "" ? (
          <p className="store-opening__hint">
            {t("{people} approves the allergen list, on Allergens. It does not hold this up.", {
              people: peopleOf([{ what: "AllergenList", who: listWho }]),
            })}
          </p>
        ) : null}
        {needsCode ? (
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
              {plan.turnsOnSoleOperator
                ? t(
                    "I run this business on my own and approve the above. This turns on approving on my own for the whole business: wherever nobody else holds the approval, I approve my own prices, menus, recipes, allergen lists, Store setup and larger refunds. Each needs my code and is recorded as approved by me alone. If I add a second owner, they approve instead.",
                  )
                : plan.others.length > 0
                  ? t(
                      "Only I can approve {what} here. I checked it and approve it on my own; it needs my code and is recorded as approved by me alone.",
                      { what: listOf(plan.alone.map(gateWords)) },
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
              : changing
                ? t("Save my changes")
                : saveOnly
                  ? t("Save my details")
                  : outcome?.kind === "Stopped"
                    ? t("Continue")
                    : plan.publishes
                      ? t("Publish my store setup")
                      : t("Send for approval")}
          </button>
          {blockers.length > 0 ? (
            <p id="store-opening-blockers" className="store-opening__hint">
              {t("Still to do: {items}.", { items: blockers.join(listSeparator()) })}
            </p>
          ) : null}
          {changing ? (
            <button
              type="button"
              className="store-opening__text-button"
              disabled={running}
              onClick={() => {
                touched.current = false;
                setChanging(false);
                void read("All");
              }}
            >
              {t("Keep what was sent")}
            </button>
          ) : null}
        </div>
      </form>
      {/* Not in the form: the verification dialog holds its own form. */}
      {needsCode ? (
        <StepUpVerification
          mode="dialog"
          openRef={openCode}
          purpose={plan.turnsOnSoleOperator ? "SoleOperatorSetting" : "SoleOperatorApproval"}
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
    </section>
  );
}
