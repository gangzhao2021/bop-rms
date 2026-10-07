import { useEffect, useMemo, useRef, useState } from "react";
import { AppFrame } from "@bop-rms/ui";
import { TaxConfigMaterialPanel } from "./TaxConfigMaterialPanel.js";
import { TaxConfigEvidenceMaterialPanel } from "./TaxConfigEvidenceMaterialPanel.js";
import { TaxConfigCandidatePanel } from "./TaxConfigCandidatePanel.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createTaxConfigAuthoringClient,
  parseTaxConfigAuthoringContent,
  TaxConfigAuthoringClientError,
  type TaxConfigAuthoringScope,
  type TaxConfigAuthoringCurrent,
  type TaxConfigAuthoringRoster,
  type TaxConfigAuthoringContent,
  type TaxConfigAuthoringRule,
  type TaxConfigAuthoringCursor,
  type PreparedTaxConfigAuthoringCommand,
  type TaxConfigClassificationChoices,
  type TaxConfigAuthoringSimulation,
} from "./tax-config-authoring-client.js";
import {
  createTaxConfigAuthoringPendingJournal,
  type TaxConfigAuthoringPendingJournal,
} from "./tax-config-authoring-pending-journal.js";
type Client = ReturnType<typeof createTaxConfigAuthoringClient>;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const scopeOf = (c: TaxConfigAuthoringCurrent): TaxConfigAuthoringScope =>
  Object.freeze({
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    storeReference: c.storeReference,
    actorReference: c.actorReference,
  });
const assertScope = (c: TaxConfigAuthoringCurrent, s: TaxConfigAuthoringScope) => {
  if (!same(scopeOf(c), s)) throw new TaxConfigAuthoringClientError("ScopeChanged");
};
/** Fresh scope and CAS precede durable reservation. Every failure after reservation retains the original. */
export async function saveTaxConfigDraft(input: {
  client: Client;
  journal: TaxConfigAuthoringPendingJournal;
  scope: TaxConfigAuthoringScope;
  baseline: TaxConfigAuthoringCurrent;
  content: TaxConfigAuthoringContent;
  operationReference: string;
  csrf: string;
  signal: AbortSignal;
  onReserved?: (p: PreparedTaxConfigAuthoringCommand) => void;
}) {
  const { client, journal, scope, baseline, signal, csrf } = input;
  const selected = await client.scope({ storeReference: scope.storeReference, signal });
  assertScope(selected, scope);
  if (await journal.load()) throw new TaxConfigAuthoringClientError("OutcomeUnknown");
  const current = await client.current(
    { scope, configurationReference: baseline.configurationReference },
    { signal },
  );
  if (!same(current.state, baseline.state)) throw new TaxConfigAuthoringClientError("Conflict");
  const snapshot = baseline.state?.snapshot;
  const prepared = await client.prepare(
    scope,
    {
      action: snapshot ? "ReplaceDraft" : "CreateDraft",
      operationReference: input.operationReference,
      configurationReference: snapshot?.configurationReference ?? null,
      expectedAggregateVersion: snapshot?.aggregateVersion ?? null,
      content: input.content,
    },
    { signal },
  );
  await journal.reserve(prepared.cursor);
  input.onReserved?.(prepared);
  return finishTaxConfigDraftOriginal({
    client,
    journal,
    cursor: prepared.cursor,
    prepared,
    csrf,
    signal,
  });
}
export async function finishTaxConfigDraftOriginal(input: {
  client: Client;
  journal: TaxConfigAuthoringPendingJournal;
  cursor: TaxConfigAuthoringCursor;
  prepared?: PreparedTaxConfigAuthoringCommand;
  csrf: string;
  signal: AbortSignal;
}) {
  const { client, journal, cursor, csrf, signal } = input;
  if (
    input.prepared &&
    (!same(input.prepared.cursor, cursor) || !same(input.prepared.scope, cursor.scope))
  )
    throw new TaxConfigAuthoringClientError("Invalid");
  const receipt = input.prepared
    ? await client.execute(cursor.scope, input.prepared.command, { csrf, signal })
    : await client.resolve(
        cursor.scope,
        {
          action: cursor.action,
          operationReference: cursor.operationReference,
          configurationReference: cursor.configurationReference,
          expectedAggregateVersion: cursor.expectedAggregateVersion,
          intentDigest: cursor.intentDigest,
        },
        { csrf, signal },
      );
  const current = await client.current(
    {
      scope: cursor.scope,
      configurationReference:
        receipt.snapshot?.configurationReference ?? cursor.configurationReference,
    },
    { signal },
  );
  await journal.complete(cursor, receipt, current);
  return { receipt, current };
}
export function taxConfigUtcBoundary(instant: string, timeZone: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant) ||
    !Number.isFinite(Date.parse(instant)) ||
    new Date(instant).toISOString() !== instant
  )
    throw new TaxConfigAuthoringClientError("Invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (key: string) => parts.find((p) => p.type === key)?.value ?? "";
  const localDateTime = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${instant.slice(19, 23)}`;
  return {
    instant,
    localDateTime,
    utcOffsetMinutes: (Date.parse(localDateTime + "Z") - Date.parse(instant)) / 60000,
  };
}
export function taxConfigDraftContentFromUtc(input: {
  stableCode: string;
  timeZone: string;
  effectiveFrom: string;
  effectiveUntil: string;
  rules: readonly TaxConfigAuthoringRule[];
}): TaxConfigAuthoringContent {
  if (!input.timeZone) throw new TaxConfigAuthoringClientError("Invalid");
  return parseTaxConfigAuthoringContent({
    stableCode: input.stableCode,
    effectivePeriod: {
      timeZone: input.timeZone,
      effectiveFrom: taxConfigUtcBoundary(input.effectiveFrom, input.timeZone),
      effectiveUntil: input.effectiveUntil
        ? taxConfigUtcBoundary(input.effectiveUntil, input.timeZone)
        : null,
    },
    rules: input.rules,
  });
}
const blankRule = (): TaxConfigAuthoringRule => ({
  taxClassificationReference: "",
  orderType: "Pickup",
  chargeType: "Sellable",
  taxComponentCode: "",
  treatment: "Taxable",
  rate: "",
  priceInclusion: "Exclusive",
  roundingMode: "HalfUp",
  calculationOrder: 1,
  compoundOnPriorTax: false,
  exceptionEvidenceReference: null,
  receiptPresentationCode: "",
});
const errorText = (error: unknown) =>
  error instanceof TaxConfigAuthoringClientError
    ? {
        Invalid: "Check the entered fields and explicit UTC instants.",
        Denied: "Permission denied. The original operation remains available for recovery.",
        FeatureDisabled: "Tax configuration is disabled for this scope.",
        Conflict:
          "The saved Draft changed. Refresh it before making another change. A pending original must be recovered first.",
        Unavailable:
          "The current source or durable recovery storage is unavailable. No new save can be confirmed.",
        OutcomeUnknown:
          "The original result is unknown. Recover the original operation before editing.",
        ScopeChanged:
          "The Store or reader changed. Return to the original scope to recover its operation.",
        Stale: "The source observation expired. Refresh before continuing.",
      }[error.code]
    : "The request could not be confirmed. Pending recovery is retained.";
const journalDefault = createTaxConfigAuthoringPendingJournal;
export function TaxConfigDraftPage({
  storeReference,
  csrf,
  client: provided,
  journalFactory = journalDefault,
}: {
  storeReference: string;
  csrf: string;
  client?: Client;
  journalFactory?: (scope: TaxConfigAuthoringScope) => TaxConfigAuthoringPendingJournal;
}) {
  const client = useMemo(() => provided ?? createTaxConfigAuthoringClient(), [provided]);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    alert = useRef<HTMLParagraphElement | null>(null);
  const [scope, setScope] = useState<TaxConfigAuthoringScope | null>(null),
    [current, setCurrent] = useState<TaxConfigAuthoringCurrent | null>(null),
    [roster, setRoster] = useState<TaxConfigAuthoringRoster | null>(null),
    [choices, setChoices] = useState<TaxConfigClassificationChoices | null>(null),
    [pending, setPending] = useState<TaxConfigAuthoringCursor | null>(null),
    [journal, setJournal] = useState<TaxConfigAuthoringPendingJournal | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState("");
  const [stableCode, setStableCode] = useState(""),
    [from, setFrom] = useState(""),
    [until, setUntil] = useState(""),
    [zone, setZone] = useState(""),
    [rules, setRules] = useState<readonly TaxConfigAuthoringRule[]>([]),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState(""),
    [reloadKey, setReloadKey] = useState(0);
  const [materialWorkspace, setMaterialWorkspace] = useState<"Registration" | "Evidence">(
    "Registration",
  );
  const [kind, setKind] = useState<"Basket" | "Refund">("Basket"),
    [amount, setAmount] = useState(""),
    [evaluatedAt, setEvaluatedAt] = useState(""),
    [classification, setClassification] = useState(""),
    [orderType, setOrderType] = useState<"Pickup" | "DineIn">("Pickup"),
    [chargeType, setChargeType] = useState<TaxConfigAuthoringRule["chargeType"]>("Sellable"),
    [label, setLabel] = useState(""),
    [simulation, setSimulation] = useState<TaxConfigAuthoringSimulation | null>(null);
  const adopt = (value: TaxConfigAuthoringCurrent) => {
    const s = value.state?.snapshot;
    setCurrent(value);
    setSelected(value.configurationReference ?? "");
    setStableCode(s?.stableCode ?? "");
    setFrom(s?.effectivePeriod.effectiveFrom.instant ?? "");
    setUntil(s?.effectivePeriod.effectiveUntil?.instant ?? "");
    setZone(s?.effectivePeriod.timeZone ?? "");
    setRules(
      s?.rules.map(({ ruleReference: ignored, ...r }) => {
        void ignored;
        return r;
      }) ?? [],
    );
    setDirty(false);
    setSimulation(null);
  };
  useEffect(() => {
    const epoch = ++generation.current,
      c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    setBusy(true);
    setReady(false);
    setScope(null);
    setPending(null);
    setJournal(null);
    setError(null);
    setCurrent(null);
    setChoices(null);
    setRoster(null);
    void (async () => {
      const initial = await client.scope({ storeReference, signal: c.signal }),
        actual = scopeOf(initial),
        j = journalFactory(actual),
        original = await j.load();
      if (epoch !== generation.current || c.signal.aborted) return;
      setScope(actual);
      setJournal(j);
      setPending(original);
      const list = await client.roster(
        { scope: actual, afterConfiguration: null },
        { signal: c.signal },
      );
      if (epoch !== generation.current || c.signal.aborted) return;
      setRoster(list);
      try {
        const definitions = await client.classifications({ scope: actual }, { signal: c.signal });
        if (epoch !== generation.current || c.signal.aborted) return;
        setChoices(definitions);
      } catch (e) {
        if (epoch !== generation.current || c.signal.aborted) return;
        setError(errorText(e));
      }
      const value = original?.configurationReference
        ? await client.current(
            { scope: actual, configurationReference: original.configurationReference },
            { signal: c.signal },
          )
        : initial;
      if (epoch !== generation.current || c.signal.aborted) return;
      adopt(value);
      setReady(true);
    })()
      .catch((e) => {
        if (epoch === generation.current && !c.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (epoch === generation.current && !c.signal.aborted) setBusy(false);
      });
    return () => {
      generation.current++;
      c.abort();
    };
  }, [client, storeReference, csrf, journalFactory, reloadKey]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  const run = async (work: (signal: AbortSignal, valid: () => boolean) => Promise<void>) => {
    if (busy) return;
    const epoch = generation.current,
      c = new AbortController();
    controller.current?.abort();
    controller.current = c;
    setBusy(true);
    setError(null);
    setMessage("");
    const valid = () => epoch === generation.current && !c.signal.aborted;
    try {
      await work(c.signal, valid);
    } catch (e) {
      if (valid()) setError(errorText(e));
    } finally {
      if (valid()) setBusy(false);
    }
  };
  const locked = busy || !ready || !!pending;
  const change = () => {
    setDirty(true);
    setSimulation(null);
  };
  const update = (
    i: number,
    key: keyof TaxConfigAuthoringRule,
    value: TaxConfigAuthoringRule[keyof TaxConfigAuthoringRule],
  ) => {
    setRules((old) =>
      old.map((r, n) =>
        n === i
          ? {
              ...r,
              [key]: value,
              ...(key === "treatment" && value === "Taxable"
                ? { exceptionEvidenceReference: null }
                : {}),
            }
          : r,
      ),
    );
    change();
  };
  const activeChoices = choices?.choices.filter((c) => c.lifecycle === "Active") ?? [];
  const renderOptions = (value: string) => (
    <>
      <option value="">Choose an actual classification</option>
      {value && !activeChoices.some((c) => c.classificationReference === value) && (
        <option value={value}>
          {choices?.choices.find((c) => c.classificationReference === value)?.code ??
            "Saved classification"}{" "}
          (retained)
        </option>
      )}
      {activeChoices.map((c) => (
        <option key={c.classificationReference} value={c.classificationReference}>
          {c.code} · {c.localizedNames[choices?.defaultLocale ?? ""]}
        </option>
      ))}
    </>
  );
  const save = () =>
    run(async (signal, valid) => {
      if (!scope || !current || !journal) return;
      const content = taxConfigDraftContentFromUtc({
        stableCode,
        timeZone: zone,
        effectiveFrom: from,
        effectiveUntil: until,
        rules,
      });
      const result = await saveTaxConfigDraft({
        client,
        journal,
        scope,
        baseline: current,
        content,
        operationReference: serviceOperationReference(),
        csrf,
        signal,
        onReserved: (p) => {
          if (valid()) setPending(p.cursor);
        },
      });
      if (!valid()) return;
      setPending(null);
      adopt(result.current);
      setMessage("Draft saved and refreshed. Professional approval has not been evaluated.");
      const list = await client.roster({ scope, afterConfiguration: null }, { signal });
      if (valid()) setRoster(list);
    });
  const recover = () =>
    run(async (signal, valid) => {
      if (!pending || !journal) return;
      const result = await finishTaxConfigDraftOriginal({
        client,
        journal,
        cursor: pending,
        csrf,
        signal,
      });
      if (valid()) {
        setPending(null);
        adopt(result.current);
        setMessage(
          result.receipt.outcome === "Committed"
            ? "Original save committed. Current Draft refreshed."
            : "Original operation abandoned. Current records refreshed.",
        );
      }
    });
  return (
    <AppFrame title="Tax Configuration" description="Tax Draft authoring and mechanical simulation">
      <section aria-label="Tax Draft workspace">
        <p>
          Drafts and mechanical simulations do not establish registration, professional review or
          legal conclusions. Publishing remains unavailable until those sources and independent
          approval are provided.
        </p>
        {busy && <p role="status">Loading current Tax configuration…</p>}
        {error && (
          <p role="alert" tabIndex={-1} ref={alert}>
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {!ready && !busy && (
          <button type="button" onClick={() => setReloadKey((n) => n + 1)}>
            Retry workspace
          </button>
        )}
        {pending && (
          <section aria-label="Original Tax save recovery">
            <p>An original operation is unresolved. Editing and switching are locked.</p>
            <button type="button" disabled={busy} onClick={() => void recover()}>
              Recover original Tax save
            </button>
          </section>
        )}
        <section aria-label="Saved Tax Drafts">
          <label>
            Saved Tax Draft
            <select
              aria-label="Saved Tax Draft"
              value={selected}
              disabled={locked || dirty}
              onChange={(e) => {
                const target = e.target.value;
                void run(async (signal, valid) => {
                  if (!scope) return;
                  const value = await client.current(
                    { scope, configurationReference: target || null },
                    { signal },
                  );
                  if (valid()) adopt(value);
                });
              }}
            >
              <option value="">New Tax Draft</option>
              {current?.state &&
                !roster?.entries.some((s) => s.snapshot.configurationReference === selected) && (
                  <option value={selected}>
                    {current.state.snapshot.stableCode} · Revision{" "}
                    {current.state.snapshot.aggregateVersion}
                  </option>
                )}
              {roster?.entries.map((s) => (
                <option
                  key={s.snapshot.configurationReference}
                  value={s.snapshot.configurationReference}
                >
                  {s.snapshot.stableCode} · Revision {s.snapshot.aggregateVersion} · Version{" "}
                  {s.snapshot.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={locked || dirty}
            onClick={() =>
              void run(async (signal, valid) => {
                if (!scope) return;
                const list = await client.roster({ scope, afterConfiguration: null }, { signal });
                if (valid()) setRoster(list);
              })
            }
          >
            Refresh saved Drafts
          </button>
          <button
            type="button"
            disabled={locked || dirty || !roster?.nextAfterConfiguration}
            onClick={() =>
              void run(async (signal, valid) => {
                if (!scope || !roster?.nextAfterConfiguration) return;
                const list = await client.roster(
                  { scope, afterConfiguration: roster.nextAfterConfiguration },
                  { signal },
                );
                if (valid()) setRoster(list);
              })
            }
          >
            Next Draft page
          </button>
          <button
            type="button"
            disabled={locked || !scope}
            onClick={() =>
              void run(async (signal, valid) => {
                if (!scope) return;
                const definitions = await client.classifications({ scope }, { signal });
                if (valid()) setChoices(definitions);
              })
            }
          >
            Refresh classifications
          </button>
          <p>Each page is a current observation of saved Drafts.</p>
        </section>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={locked}>
            <legend>Draft settings</legend>
            <label>
              Stable code
              <input
                aria-label="Stable code"
                value={stableCode}
                readOnly={!!current?.state}
                onChange={(e) => {
                  setStableCode(e.target.value);
                  change();
                }}
              />
            </label>
            <label>
              Effective time zone
              <select
                aria-label="Effective time zone"
                required
                value={zone}
                onChange={(e) => {
                  setZone(e.target.value);
                  change();
                }}
              >
                <option value="">Choose the effective time zone</option>
                <option value="America/Toronto">America/Toronto — current CA-ON Tax profile</option>
                {zone && zone !== "America/Toronto" && (
                  <option value={zone}>{zone} (saved time zone)</option>
                )}
              </select>
            </label>
            <p>
              Effective times use explicit UTC instants. The current CA-ON Tax profile supports
              America/Toronto; select it explicitly for a new Draft.
            </p>
            <label>
              Effective from (UTC)
              <input
                aria-label="Effective from (UTC)"
                placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  change();
                }}
              />
            </label>
            <label>
              Effective until (UTC, optional)
              <input
                aria-label="Effective until (UTC, optional)"
                value={until}
                onChange={(e) => {
                  setUntil(e.target.value);
                  change();
                }}
              />
            </label>
            <p>
              Empty Drafts may be saved. Rates and treatments are authored inputs, not verified
              legal facts.
            </p>
            {rules.map((r, i) => (
              <fieldset key={i}>
                <legend>Tax rule {i + 1}</legend>
                <label>
                  Classification
                  <select
                    aria-label={`Rule ${i + 1} classification`}
                    value={r.taxClassificationReference}
                    onChange={(e) => update(i, "taxClassificationReference", e.target.value)}
                  >
                    {renderOptions(r.taxClassificationReference)}
                  </select>
                </label>
                <label>
                  Component code
                  <input
                    aria-label={`Rule ${i + 1} component code`}
                    value={r.taxComponentCode}
                    onChange={(e) => update(i, "taxComponentCode", e.target.value)}
                  />
                </label>
                <label>
                  Rate
                  <input
                    aria-label={`Rule ${i + 1} rate`}
                    inputMode="decimal"
                    value={r.rate}
                    onChange={(e) => update(i, "rate", e.target.value)}
                  />
                </label>
                <label>
                  Receipt label code
                  <input
                    aria-label={`Rule ${i + 1} receipt label code`}
                    value={r.receiptPresentationCode}
                    onChange={(e) => update(i, "receiptPresentationCode", e.target.value)}
                  />
                </label>
                <label>
                  Treatment
                  <select
                    aria-label={`Rule ${i + 1} treatment`}
                    value={r.treatment}
                    onChange={(e) => update(i, "treatment", e.target.value)}
                  >
                    <option value="Taxable">Taxable</option>
                    {r.exceptionEvidenceReference && (
                      <option value={r.treatment}>{r.treatment} (saved evidence)</option>
                    )}
                  </select>
                </label>
                <p>
                  New exempt and zero rated rules require an actual professional exception evidence
                  source.
                </p>
                {(
                  [
                    ["orderType", "Order type", ["Pickup", "DineIn"]],
                    [
                      "chargeType",
                      "Charge type",
                      ["Sellable", "ServiceCharge", "DeliveryFee", "Tip"],
                    ],
                    ["priceInclusion", "Price inclusion", ["Exclusive", "Inclusive"]],
                    [
                      "roundingMode",
                      "Rounding",
                      ["HalfUp", "HalfEven", "TowardZero", "AwayFromZero"],
                    ],
                  ] as const
                ).map(([key, title, values]) => (
                  <label key={key}>
                    {title}
                    <select
                      aria-label={`Rule ${i + 1} ${title}`}
                      value={r[key]}
                      onChange={(e) => update(i, key, e.target.value)}
                    >
                      {values.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <label>
                  Calculation order
                  <input
                    aria-label={`Rule ${i + 1} calculation order`}
                    type="number"
                    min={1}
                    max={16}
                    value={r.calculationOrder}
                    onChange={(e) => update(i, "calculationOrder", Number(e.target.value))}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={r.compoundOnPriorTax}
                    onChange={(e) => update(i, "compoundOnPriorTax", e.target.checked)}
                  />
                  Compound on prior tax
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setRules((old) => old.filter((_, n) => n !== i));
                    change();
                  }}
                >
                  Remove rule {i + 1}
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={rules.length >= 256 || !choices}
              onClick={() => {
                setRules((old) => [...old, blankRule()]);
                change();
              }}
            >
              Add Tax rule
            </button>
          </fieldset>
          <div className="card-actions">
            <button type="submit" disabled={locked || !dirty}>
              Save Tax Draft
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() =>
                void run(async (signal, valid) => {
                  if (!scope || !current) return;
                  const value = await client.current(
                    { scope, configurationReference: current.configurationReference },
                    { signal },
                  );
                  if (valid()) adopt(value);
                })
              }
            >
              Refresh current Draft
            </button>
          </div>
        </form>
        <section aria-label="Mechanical Tax simulation">
          <h2>Basket or Refund simulation</h2>
          <p>
            Save the Draft before simulating. Professional review and legal conclusions remain Not
            evaluated.
          </p>
          <fieldset disabled={locked || dirty || !current?.state || !choices}>
            <legend>Mechanical line</legend>
            <label>
              Fixture kind
              <select
                aria-label="Fixture kind"
                value={kind}
                onChange={(e) => setKind(e.target.value === "Refund" ? "Refund" : "Basket")}
              >
                <option>Basket</option>
                <option>Refund</option>
              </select>
            </label>
            <label>
              Evaluation time (UTC)
              <input
                aria-label="Evaluation time (UTC)"
                value={evaluatedAt}
                onChange={(e) => setEvaluatedAt(e.target.value)}
              />
            </label>
            <label>
              Line label code
              <input
                aria-label="Line label code"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label>
              Amount in minor units
              <input
                aria-label="Amount in minor units"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label>
              Simulation classification
              <select
                aria-label="Simulation classification"
                value={classification}
                onChange={(e) => setClassification(e.target.value)}
              >
                {renderOptions(classification)}
              </select>
            </label>
            <label>
              Simulation order type
              <select
                aria-label="Simulation order type"
                value={orderType}
                onChange={(e) => setOrderType(e.target.value === "DineIn" ? "DineIn" : "Pickup")}
              >
                <option>Pickup</option>
                <option>DineIn</option>
              </select>
            </label>
            <label>
              Simulation charge type
              <select
                aria-label="Simulation charge type"
                value={chargeType}
                onChange={(e) => {
                  const v = e.target.value;
                  if (
                    v === "Sellable" ||
                    v === "ServiceCharge" ||
                    v === "DeliveryFee" ||
                    v === "Tip"
                  )
                    setChargeType(v);
                }}
              >
                {["Sellable", "ServiceCharge", "DeliveryFee", "Tip"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                void run(async (signal, valid) => {
                  if (!scope || !current?.state) return;
                  const s = current.state.snapshot,
                    matching = s.rules.filter(
                      (r) =>
                        r.taxClassificationReference === classification &&
                        r.orderType === orderType &&
                        r.chargeType === chargeType,
                    );
                  if (!matching.length) throw new TaxConfigAuthoringClientError("Invalid");
                  const result = await client.simulate(
                    {
                      scope,
                      command: {
                        configurationReference: s.configurationReference,
                        expectedVersionReference: s.versionReference,
                        expectedSnapshotDigest: s.snapshotDigest,
                        fixture: {
                          profile: "TaxDraftFixtureV1",
                          fixtureReference: serviceOperationReference(),
                          kind,
                          evaluatedAt,
                          lines: [
                            {
                              lineReference: serviceOperationReference(),
                              calculationReferences: matching.map(() =>
                                serviceOperationReference(),
                              ),
                              labelCode: label,
                              taxClassificationReference: classification,
                              orderType,
                              chargeType,
                              amountMinor: amount,
                            },
                          ],
                        },
                      },
                    },
                    { csrf, signal },
                  );
                  if (valid()) setSimulation(result);
                })
              }
            >
              Simulate saved Draft
            </button>
          </fieldset>
          {simulation && (
            <div aria-label="Mechanical receipt preview">
              <p>
                Net: {simulation.simulation.netAmountMinor} · Tax:{" "}
                {simulation.simulation.taxAmountMinor} · Gross:{" "}
                {simulation.simulation.grossAmountMinor} minor units
              </p>
              {simulation.simulation.receiptPreview.map((p) => (
                <p key={p.lineReference + p.componentCode}>
                  {p.labelCode} · {p.componentCode} · {p.treatment} · Rate {p.rate} · Tax{" "}
                  {p.taxAmountMinor} minor units
                </p>
              ))}
              <p>Professional review: Not evaluated. Legal conclusion: Not evaluated.</p>
            </div>
          )}
        </section>
      </section>
      {scope && (
        <section aria-label="Tax material workspace selection">
          <label>
            Material workspace
            <select
              value={materialWorkspace}
              onChange={(event) =>
                setMaterialWorkspace(
                  event.currentTarget.value === "Evidence" ? "Evidence" : "Registration",
                )
              }
            >
              <option value="Registration">Registration applicability</option>
              <option value="Evidence">Fixture suites and professional reports</option>
            </select>
          </label>
          {materialWorkspace === "Registration" ? (
            <TaxConfigMaterialPanel
              key={canonical(scope)}
              scope={scope}
              csrf={csrf}
              disabled={busy || pending !== null}
            />
          ) : (
            <TaxConfigEvidenceMaterialPanel
              key={canonical(scope)}
              scope={scope}
              csrf={csrf}
              draft={current}
              disabled={busy || pending !== null || dirty}
            />
          )}
        </section>
      )}
      {scope && (
        <TaxConfigCandidatePanel
          key={canonical(scope)}
          scope={scope}
          csrf={csrf}
          draft={current}
          disabled={busy || pending !== null || dirty}
        />
      )}
    </AppFrame>
  );
}
