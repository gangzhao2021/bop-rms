import { useEffect, useMemo, useRef, useState } from "react";
import { createTaxConfigMaterialClient } from "./tax-config-material-client.js";
import { createTaxConfigMaterialPendingJournal } from "./tax-config-material-pending-journal.js";
import {
  type TaxConfigAuthoringScope,
  TaxConfigAuthoringClientError,
} from "./tax-config-authoring-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";
type Client = ReturnType<typeof createTaxConfigMaterialClient>;
type Journal = ReturnType<typeof createTaxConfigMaterialPendingJournal>;
type Prepared = Awaited<ReturnType<Client["prepare"]>>;
type Cursor = Prepared["cursor"];
type Current = Awaited<ReturnType<Client["current"]>>;
type Roster = Awaited<ReturnType<Client["roster"]>>;
type Registrant = Awaited<ReturnType<Client["registrant"]>>;
interface Operation {
  client: Client;
  journal: Journal;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
function check(input: Operation) {
  if (input.signal.aborted || !input.isCurrent())
    throw new TaxConfigAuthoringClientError("ScopeChanged");
}
/** Exact original recovery never needs today's registration qualification. */
export async function finishTaxConfigMaterialOriginal(
  input: Operation & { cursor: Cursor; prepared?: Prepared },
) {
  check(input);
  if (input.prepared && canonical(input.prepared.cursor) !== canonical(input.cursor))
    throw new TaxConfigAuthoringClientError("Conflict");
  const receipt = input.prepared
    ? await input.client.execute(input.prepared, { csrf: input.csrf, signal: input.signal })
    : await input.client.resolve(input.cursor, { csrf: input.csrf, signal: input.signal });
  check(input);
  const current = await input.client.current(
    input.cursor.scope,
    {
      materialKind: input.cursor.materialKind,
      materialReference: receipt.version?.materialReference ?? input.cursor.materialReference,
    },
    { signal: input.signal },
  );
  check(input);
  await input.journal.complete(input.cursor, receipt, current);
  check(input);
  return { receipt, current };
}
export interface TaxConfigMaterialFields {
  applicability: "" | "Applicable" | "NotApplicable";
  sourceIssuedAt: string;
  effectiveFrom: string;
  effectiveUntil: string;
  declaredSourceDigest: string;
}
const emptyFields = (): TaxConfigMaterialFields => ({
  applicability: "",
  sourceIssuedAt: "",
  effectiveFrom: "",
  effectiveUntil: "",
  declaredSourceDigest: "",
});
export async function saveTaxConfigRegistrationMaterial(
  input: Operation & {
    scope: TaxConfigAuthoringScope;
    baseline: Current;
    expectedSource: NonNullable<Registrant>;
    fields: TaxConfigMaterialFields;
    onReserved: (cursor: Cursor) => void;
  },
) {
  check(input);
  const current = await input.client.current(
    input.scope,
    {
      materialKind: "RegistrationApplicability",
      materialReference: input.baseline.materialReference,
    },
    { signal: input.signal },
  );
  check(input);
  if (
    current.version?.versionReference !== input.baseline.version?.versionReference ||
    current.version?.revision !== input.baseline.version?.revision
  )
    throw new TaxConfigAuthoringClientError("Conflict");
  const source = await input.client.registrant(input.scope, { signal: input.signal });
  check(input);
  if (!source) throw new TaxConfigAuthoringClientError("Unavailable");
  for (const key of [
    "assignmentReference",
    "assignmentVersion",
    "operatingEntityReference",
    "entityVersion",
    "operatingEntityProfileVersionReference",
    "profileVersion",
    "taxRegistrationReference",
    "jurisdictionCode",
  ] as const)
    if (source[key] !== input.expectedSource[key])
      throw new TaxConfigAuthoringClientError("Conflict");
  if (!input.fields.applicability) throw new TaxConfigAuthoringClientError("Invalid");
  const prepared = await input.client.prepare(
    input.scope,
    {
      action: current.materialReference === null ? "CreateMaterial" : "ReplaceMaterial",
      operationReference: serviceOperationReference(),
      materialReference: current.materialReference,
      expectedRevision: current.version?.revision ?? null,
      materialKind: "RegistrationApplicability",
      content: {
        operatingEntityProfileVersionReference: source.operatingEntityProfileVersionReference,
        operatingEntityTaxReference: source.taxRegistrationReference,
        jurisdictionCode: source.jurisdictionCode,
        applicability: input.fields.applicability,
        sourceIssuedAt: input.fields.sourceIssuedAt,
        effectiveFrom: input.fields.effectiveFrom,
        effectiveUntil: input.fields.effectiveUntil || null,
        declaredSourceDigest: input.fields.declaredSourceDigest || null,
      },
    },
    { signal: input.signal },
  );
  check(input);
  await input.journal.reserve(prepared.cursor);
  check(input);
  input.onReserved(prepared.cursor);
  return finishTaxConfigMaterialOriginal({ ...input, cursor: prepared.cursor, prepared });
}
function errorText(error: unknown) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "Unavailable";
  switch (code) {
    case "OutcomeUnknown":
      return "The original save outcome is unknown. Recover it before editing.";
    case "Denied":
      return "Current permission does not allow this action. The original request is retained.";
    case "Conflict":
      return "The material or registration source changed. Refresh before preparing a new save.";
    case "ScopeChanged":
      return "The current session or Store changed. The original request remains in its scope.";
    case "Invalid":
      return "Check applicability, UTC dates and the optional SHA-256 checksum.";
    case "FeatureDisabled":
      return "Tax authoring is disabled.";
    case "Stale":
      return "The current observation expired. Refresh before preparing a new save.";
    default:
      return "Tax material sources or durable recovery are unavailable. Retry without replacing the original request.";
  }
}
export interface TaxConfigMaterialPanelProps {
  scope: TaxConfigAuthoringScope;
  csrf: string;
  hidden?: boolean;
  disabled?: boolean;
  client?: Client;
  journalFactory?: typeof createTaxConfigMaterialPendingJournal;
}
export function TaxConfigMaterialPanel({
  scope,
  csrf,
  hidden = false,
  disabled = false,
  client: provided,
  journalFactory = createTaxConfigMaterialPendingJournal,
}: TaxConfigMaterialPanelProps) {
  const client = useMemo(() => provided ?? createTaxConfigMaterialClient(), [provided]);
  const key = canonical({ scope, csrf });
  const identity = useRef(key);
  identity.current = key;
  const epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    journal = useRef<Journal | null>(null),
    alert = useRef<HTMLParagraphElement | null>(null);
  const [reload, setReload] = useState(0),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(true),
    [pending, setPending] = useState<Cursor | null>(null),
    [current, setCurrent] = useState<Current | null>(null),
    [roster, setRoster] = useState<Roster | null>(null),
    [source, setSource] = useState<Registrant>(null),
    [fields, setFields] = useState<TaxConfigMaterialFields>(emptyFields),
    [dirty, setDirty] = useState(false),
    [historicalView, setHistoricalView] = useState<Current | null>(null),
    [historical, setHistorical] = useState(false),
    [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  function adopt(value: Current) {
    setCurrent(value);
    setHistoricalView(null);
    setHistorical(false);
    setDirty(false);
    const c = value.version?.content;
    if (c && "operatingEntityProfileVersionReference" in c)
      setFields({
        applicability: c.applicability,
        sourceIssuedAt: c.sourceIssuedAt,
        effectiveFrom: c.effectiveFrom,
        effectiveUntil: c.effectiveUntil ?? "",
        declaredSourceDigest: c.declaredSourceDigest ?? "",
      });
    else setFields(emptyFields());
  }
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  useEffect(() => {
    const e = ++epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    const valid = () => e === epoch.current && identity.current === key && !c.signal.aborted;
    setReady(false);
    setBusy(true);
    setError(null);
    setMessage(null);
    setPending(null);
    setSource(null);
    setCurrent(null);
    setRoster(null);
    setHistoricalView(null);
    setDirty(false);
    setHistorical(false);
    journal.current = null;
    void (async () => {
      const j = journalFactory(scope);
      const original = await j.load();
      if (!valid()) return;
      journal.current = j;
      setPending(original);
      setReady(true);
      if (original) return;
      const value = await client.current(
        scope,
        { materialKind: "RegistrationApplicability", materialReference: null },
        { signal: c.signal },
      );
      if (!valid()) return;
      adopt(value);
      const page = await client.roster(
        scope,
        { materialKind: "RegistrationApplicability", afterMaterial: null },
        { signal: c.signal },
      );
      if (!valid()) return;
      setRoster(page);
      const actual = await client.registrant(scope, { signal: c.signal });
      if (valid()) setSource(actual);
    })()
      .catch((reason) => {
        if (valid()) setError(errorText(reason));
      })
      .finally(() => {
        controllers.current.delete(c);
        if (valid()) setBusy(false);
      });
    return () => {
      ++epoch.current;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      client.invalidate();
    };
  }, [client, key, journalFactory, reload]);
  async function run(work: (operation: Operation) => Promise<void>, recovery = false) {
    if (busy || (disabled && !recovery)) return;
    const e = epoch.current,
      c = new AbortController(),
      captured = key;
    controllers.current.add(c);
    const valid = () => e === epoch.current && identity.current === captured && !c.signal.aborted;
    const j = journal.current;
    if (!j) {
      setError("Durable recovery is unavailable.");
      controllers.current.delete(c);
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work({ client, journal: j, csrf, signal: c.signal, isCurrent: valid });
    } catch (reason) {
      if (valid()) setError(errorText(reason));
    } finally {
      controllers.current.delete(c);
      if (valid()) setBusy(false);
    }
  }
  const locked = disabled || busy || !ready || pending !== null;
  const update = (name: keyof TaxConfigMaterialFields, value: string) => {
    setFields((old) => ({ ...old, [name]: value }));
    setDirty(true);
    setMessage(null);
  };
  return (
    <section
      className="tax-config-material-panel"
      aria-label="Tax registration materials"
      hidden={hidden}
    >
      <h2>Tax registration materials</h2>
      <p>
        Recorded declarations are not registration verification or professional approval. Not
        applicable is a declaration, not a publishing waiver.
      </p>
      {busy && <p role="status">Loading Tax registration materials…</p>}
      {error && (
        <p role="alert" tabIndex={-1} ref={alert}>
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!ready && !busy && (
        <button type="button" disabled={disabled} onClick={() => setReload((n) => n + 1)}>
          Retry material workspace
        </button>
      )}
      {pending && (
        <section aria-label="Original Tax material recovery">
          <p>
            An original material save is unresolved. New material saves are locked until it is
            recovered.
          </p>
          {pending.materialKind !== "RegistrationApplicability" && (
            <p>
              Switch the material workspace to Fixture suites and professional reports to recover
              this original request.
            </p>
          )}
          <button
            type="button"
            disabled={busy || pending.materialKind !== "RegistrationApplicability"}
            onClick={() =>
              void run(async (op) => {
                const result = await finishTaxConfigMaterialOriginal({ ...op, cursor: pending });
                check(op);
                adopt(result.current);
                setPending(null);
                setMessage(
                  result.receipt.outcome === "Committed"
                    ? "Original material save was committed. Current material refreshed."
                    : "The original request was abandoned. No material was saved.",
                );
              }, true)
            }
          >
            Recover original material save
          </button>
        </section>
      )}
      <section aria-label="Current TaxRegistrant source">
        <h3>Current registration source</h3>
        {source ? (
          <>
            <p>Legal name: {source.legalName}</p>
            <p>Jurisdiction: {source.jurisdictionCode}</p>
            <p>
              Tax registration reference:{" "}
              {source.taxRegistrationReference === null ? "Not recorded" : "Recorded reference"}
            </p>
            <p>Qualification: Not evaluated</p>
          </>
        ) : (
          <p>
            No current registration source has been loaded. Saved material and original recovery
            remain available.
          </p>
        )}
        <button
          type="button"
          disabled={locked}
          onClick={() =>
            void run(async (op) => {
              const actual = await client.registrant(scope, { signal: op.signal });
              check(op);
              setSource(actual);
            })
          }
        >
          Refresh registration source
        </button>
      </section>
      <section aria-label="Saved registration materials">
        <label>
          Saved registration material
          <select
            aria-label="Saved registration material"
            disabled={locked || dirty}
            value={current?.materialReference ?? ""}
            onChange={(e) => {
              const reference = e.target.value;
              void run(async (op) => {
                const value = await client.current(
                  scope,
                  {
                    materialKind: "RegistrationApplicability",
                    materialReference: reference || null,
                  },
                  { signal: op.signal },
                );
                check(op);
                adopt(value);
              });
            }}
          >
            <option value="">New registration material</option>
            {current?.version &&
              !roster?.entries.some((v) => v.materialReference === current.materialReference) && (
                <option value={current.version.materialReference}>
                  Saved revision {current.version.revision} · {current.version.recordedAt}
                </option>
              )}
            {roster?.entries.map((v) => (
              <option key={v.materialReference} value={v.materialReference}>
                Revision {v.revision} · {v.recordedAt}
              </option>
            ))}
          </select>
        </label>
        <div className="card-actions">
          <button
            type="button"
            disabled={locked || dirty}
            onClick={() =>
              void run(async (op) => {
                const page = await client.roster(
                  scope,
                  { materialKind: "RegistrationApplicability", afterMaterial: null },
                  { signal: op.signal },
                );
                check(op);
                setRoster(page);
              })
            }
          >
            Refresh saved materials
          </button>
          <button
            type="button"
            disabled={locked || dirty || !roster?.nextAfterMaterial}
            onClick={() =>
              void run(async (op) => {
                const page = await client.roster(
                  scope,
                  {
                    materialKind: "RegistrationApplicability",
                    afterMaterial: roster?.nextAfterMaterial ?? null,
                  },
                  { signal: op.signal },
                );
                check(op);
                setRoster(page);
              })
            }
          >
            Next material page
          </button>
          <button
            type="button"
            disabled={locked || dirty || !current?.version}
            onClick={() =>
              void run(async (op) => {
                if (!current?.version) return;
                const value = await client.version(
                  scope,
                  {
                    materialKind: "RegistrationApplicability",
                    versionReference: current.version.versionReference,
                  },
                  { signal: op.signal },
                );
                check(op);
                setHistoricalView(value);
                setHistorical(true);
              })
            }
          >
            Read saved material version
          </button>
          <button
            type="button"
            disabled={locked || dirty || !current?.version?.previousVersionReference}
            onClick={() =>
              void run(async (op) => {
                const previous = current?.version?.previousVersionReference;
                if (!previous) return;
                const value = await client.version(
                  scope,
                  { materialKind: "RegistrationApplicability", versionReference: previous },
                  { signal: op.signal },
                );
                check(op);
                setHistoricalView(value);
                setHistorical(true);
              })
            }
          >
            Previous saved version
          </button>
          <button
            type="button"
            disabled={locked || !current}
            onClick={() =>
              void run(async (op) => {
                if (!current) return;
                const value = await client.current(
                  scope,
                  {
                    materialKind: "RegistrationApplicability",
                    materialReference: current.materialReference,
                  },
                  { signal: op.signal },
                );
                check(op);
                adopt(value);
              })
            }
          >
            {dirty ? "Discard edits and reload current material" : "Reload current material"}
          </button>
        </div>
        {current?.version && (
          <p>
            Recorded revision {current.version.revision}, {current.version.recordedAt}.
            Qualification: Not evaluated.
          </p>
        )}
        {historical && (
          <p>Showing an immutable saved version. Reload current material before editing.</p>
        )}
        {historicalView?.version &&
          "operatingEntityProfileVersionReference" in historicalView.version.content && (
            <section aria-label="Historical registration material">
              <h4>Saved revision {historicalView.version.revision}</h4>
              <dl>
                <dt>Declared applicability</dt>
                <dd>
                  {historicalView.version.content.applicability === "NotApplicable"
                    ? "Not applicable"
                    : "Applicable"}
                </dd>
                <dt>Source issued at</dt>
                <dd>{historicalView.version.content.sourceIssuedAt}</dd>
                <dt>Effective from</dt>
                <dd>{historicalView.version.content.effectiveFrom}</dd>
                <dt>Effective until</dt>
                <dd>{historicalView.version.content.effectiveUntil ?? "Not specified"}</dd>
                <dt>Declared source checksum</dt>
                <dd>{historicalView.version.content.declaredSourceDigest ?? "Not provided"}</dd>
              </dl>
              <p>
                Qualification: Not evaluated. This saved version does not replace the current
                editing baseline.
              </p>
            </section>
          )}
      </section>
      <fieldset disabled={locked || historical}>
        <legend>Registration applicability declaration</legend>
        <label>
          Declared applicability
          <select
            aria-label="Declared applicability"
            value={fields.applicability}
            onChange={(e) => update("applicability", e.target.value)}
          >
            <option value="">Choose applicability</option>
            <option value="Applicable">Applicable</option>
            <option value="NotApplicable">Not applicable</option>
          </select>
        </label>
        <label>
          Source issued at (UTC)
          <input
            aria-label="Source issued at (UTC)"
            value={fields.sourceIssuedAt}
            onChange={(e) => update("sourceIssuedAt", e.target.value)}
            placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
          />
        </label>
        <label>
          Effective from (UTC)
          <input
            aria-label="Effective from (UTC)"
            value={fields.effectiveFrom}
            onChange={(e) => update("effectiveFrom", e.target.value)}
            placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
          />
        </label>
        <label>
          Effective until (UTC, optional)
          <input
            aria-label="Effective until (UTC, optional)"
            value={fields.effectiveUntil}
            onChange={(e) => update("effectiveUntil", e.target.value)}
            placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
          />
        </label>
        <label>
          Declared source SHA-256 checksum (optional)
          <input
            aria-label="Declared source SHA-256 checksum (optional)"
            value={fields.declaredSourceDigest}
            onChange={(e) => update("declaredSourceDigest", e.target.value)}
            placeholder="sha256: followed by 64 lowercase hex digits"
          />
        </label>
        <button
          type="button"
          disabled={locked || historical || !source || !current || !dirty || !fields.applicability}
          onClick={() =>
            void run(async (op) => {
              if (!current || !source) return;
              const result = await saveTaxConfigRegistrationMaterial({
                ...op,
                scope,
                baseline: current,
                expectedSource: source,
                fields,
                onReserved: (cursor) => setPending(cursor),
              });
              check(op);
              adopt(result.current);
              setPending(null);
              setMessage(
                result.receipt.outcome === "Committed"
                  ? "Registration material recorded. Qualification remains not evaluated."
                  : "The original request was abandoned. No material was saved.",
              );
            })
          }
        >
          Save registration material
        </button>
      </fieldset>
      <section aria-label="Professional material readiness">
        <h3>Professional report and fixture suite</h3>
        <p>
          Recording these materials is unavailable until the exact publication candidate source is
          connected. Saving registration material does not enable publishing.
        </p>
      </section>
    </section>
  );
}
