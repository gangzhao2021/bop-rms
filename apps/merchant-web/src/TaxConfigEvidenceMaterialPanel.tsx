import { useEffect, useMemo, useRef, useState } from "react";
import {
  createTaxConfigMaterialClient,
  parseTaxConfigMaterialContent,
  type TaxConfigMaterialCurrent,
  type TaxConfigMaterialRoster,
  type TaxConfigMaterialCursor,
  type TaxConfigMaterialVersion,
  type TaxConfigMaterialComparison,
} from "./tax-config-material-client.js";
import { createTaxConfigMaterialPendingJournal } from "./tax-config-material-pending-journal.js";
import {
  createTaxConfigCandidateClient,
  type TaxConfigCandidateCurrent,
  type TaxConfigCandidateRoster,
} from "./tax-config-candidate-client.js";
import {
  TaxConfigAuthoringClientError,
  type TaxConfigAuthoringCurrent,
  type TaxConfigAuthoringScope,
} from "./tax-config-authoring-client.js";
import { finishTaxConfigMaterialOriginal } from "./TaxConfigMaterialPanel.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";
type Client = ReturnType<typeof createTaxConfigMaterialClient>;
type Journal = ReturnType<typeof createTaxConfigMaterialPendingJournal>;
type EvidenceKind = "FixtureSuite" | "ProfessionalReport";
export interface TaxConfigEvidenceMaterialFields {
  suiteJson: string;
  displayName: string;
  organizationName: string;
  credentialIdentifier: string;
  reviewedAt: string;
  validUntil: string;
  conclusion: "" | "Pass" | "Fail";
  sourceDigest: string;
}
const empty = (): TaxConfigEvidenceMaterialFields => ({
  suiteJson: "",
  displayName: "",
  organizationName: "",
  credentialIdentifier: "",
  reviewedAt: "",
  validUntil: "",
  conclusion: "",
  sourceDigest: "",
});
interface Operation {
  client: Client;
  journal: Journal;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
const check = (o: Operation) => {
  if (o.signal.aborted || !o.isCurrent()) throw new TaxConfigAuthoringClientError("ScopeChanged");
};
/** Actual saved source selection and CAS are checked before a durable reservation.
 * Material declarations do not grant professional or publication qualification. */
export async function saveTaxConfigEvidenceMaterial(
  o: Operation & {
    scope: TaxConfigAuthoringScope;
    kind: EvidenceKind;
    baseline: TaxConfigMaterialCurrent;
    candidate: TaxConfigCandidateCurrent;
    suite: TaxConfigMaterialVersion | null;
    fields: TaxConfigEvidenceMaterialFields;
    onReserved: (cursor: TaxConfigMaterialCursor) => void;
  },
) {
  check(o);
  const expected = o.candidate.record;
  if (!expected) throw new TaxConfigAuthoringClientError("Conflict");
  const actual = await createTaxConfigCandidateClient().current(
    o.scope,
    {
      configurationReference: expected.candidate.content.configurationReference,
      targetVersionReference: expected.candidate.content.targetVersionReference,
    },
    { signal: o.signal },
  );
  check(o);
  if (!actual.record || canonical(actual.record) !== canonical(expected))
    throw new TaxConfigAuthoringClientError("Conflict");
  const c = actual.record.candidate,
    pin = { versionReference: c.content.targetVersionReference, contentDigest: c.contentDigest };
  const current = await o.client.current(
    o.scope,
    { materialKind: o.kind, materialReference: o.baseline.materialReference },
    { signal: o.signal },
  );
  check(o);
  if (
    current.version?.versionReference !== o.baseline.version?.versionReference ||
    current.version?.revision !== o.baseline.version?.revision
  )
    throw new TaxConfigAuthoringClientError("Conflict");
  let content;
  if (o.kind === "FixtureSuite") {
    content = parseTaxConfigMaterialContent(JSON.parse(o.fields.suiteJson), "FixtureSuite");
    if (
      !("cases" in content) ||
      canonical(content.targetPublicationCandidate) !== canonical(pin) ||
      canonical(content.currencyMetadata) !== canonical(c.content.currencyMetadata) ||
      content.cases.some(
        (item) => item.expected.configurationReference !== c.content.configurationReference,
      )
    )
      throw new TaxConfigAuthoringClientError("Conflict");
  } else {
    if (!o.suite || o.suite.materialKind !== "FixtureSuite" || !("cases" in o.suite.content))
      throw new TaxConfigAuthoringClientError("Conflict");
    const suite = await o.client.version(
      o.scope,
      { materialKind: "FixtureSuite", versionReference: o.suite.versionReference },
      { signal: o.signal },
    );
    check(o);
    if (
      !suite.version ||
      canonical(suite.version) !== canonical(o.suite) ||
      !("cases" in suite.version.content) ||
      canonical(suite.version.content.targetPublicationCandidate) !== canonical(pin)
    )
      throw new TaxConfigAuthoringClientError("Conflict");
    const registration = await o.client.version(
      o.scope,
      {
        materialKind: "RegistrationApplicability",
        versionReference: c.content.registrationMaterial.versionReference,
      },
      { signal: o.signal },
    );
    check(o);
    if (
      !registration.version ||
      registration.version.materialReference !== c.content.registrationMaterial.materialReference ||
      registration.version.contentDigest !== c.content.registrationMaterial.contentDigest
    )
      throw new TaxConfigAuthoringClientError("Conflict");
    content = parseTaxConfigMaterialContent(
      {
        targetPublicationCandidate: pin,
        registrationMaterial: {
          versionReference: registration.version.versionReference,
          contentDigest: registration.version.contentDigest,
        },
        fixtureSuiteMaterial: {
          versionReference: suite.version.versionReference,
          contentDigest: suite.version.contentDigest,
        },
        declaredIssuer: {
          displayName: o.fields.displayName,
          organizationName: o.fields.organizationName || null,
          credentialIdentifier: o.fields.credentialIdentifier || null,
        },
        reviewedAt: o.fields.reviewedAt,
        validUntil: o.fields.validUntil,
        declaredConclusion: o.fields.conclusion,
        declaredSourceDigest: o.fields.sourceDigest || null,
      },
      "ProfessionalReport",
    );
  }
  const prepared = await o.client.prepare(
    o.scope,
    {
      action: current.materialReference === null ? "CreateMaterial" : "ReplaceMaterial",
      operationReference: serviceOperationReference(),
      materialReference: current.materialReference,
      expectedRevision: current.version?.revision ?? null,
      materialKind: o.kind,
      content,
    },
    { signal: o.signal },
  );
  check(o);
  await o.journal.reserve(prepared.cursor);
  check(o);
  o.onReserved(prepared.cursor);
  return finishTaxConfigMaterialOriginal({ ...o, cursor: prepared.cursor, prepared });
}
/** Compare immutable recorded inputs; no operation nonce or journal mutation. */
export async function compareTaxConfigEvidenceMaterial(
  o: Pick<Operation, "client" | "csrf" | "signal" | "isCurrent"> & {
    scope: TaxConfigAuthoringScope;
    candidate: TaxConfigCandidateCurrent;
    suite: TaxConfigMaterialVersion;
  },
) {
  if (o.signal.aborted || !o.isCurrent()) throw new TaxConfigAuthoringClientError("ScopeChanged");
  const expected = o.candidate.record;
  if (!expected || o.suite.materialKind !== "FixtureSuite" || !("cases" in o.suite.content))
    throw new TaxConfigAuthoringClientError("Conflict");
  const actual = await createTaxConfigCandidateClient().current(
    o.scope,
    {
      configurationReference: expected.candidate.content.configurationReference,
      targetVersionReference: expected.candidate.content.targetVersionReference,
    },
    { signal: o.signal },
  );
  if (o.signal.aborted || !o.isCurrent()) throw new TaxConfigAuthoringClientError("ScopeChanged");
  if (!actual.record || canonical(actual.record) !== canonical(expected))
    throw new TaxConfigAuthoringClientError("Conflict");
  const suite = await o.client.version(
    o.scope,
    { materialKind: "FixtureSuite", versionReference: o.suite.versionReference },
    { signal: o.signal },
  );
  if (o.signal.aborted || !o.isCurrent()) throw new TaxConfigAuthoringClientError("ScopeChanged");
  const c = actual.record.candidate;
  if (
    !suite.version ||
    canonical(suite.version) !== canonical(o.suite) ||
    !("cases" in suite.version.content) ||
    canonical(suite.version.content.targetPublicationCandidate) !==
      canonical({
        versionReference: c.content.targetVersionReference,
        contentDigest: c.contentDigest,
      })
  )
    throw new TaxConfigAuthoringClientError("Conflict");
  const result = await o.client.compare(
    o.scope,
    {
      configurationReference: c.content.configurationReference,
      targetPublicationCandidate: {
        versionReference: c.content.targetVersionReference,
        contentDigest: c.contentDigest,
      },
      fixtureSuiteMaterial: {
        materialReference: suite.version.materialReference,
        versionReference: suite.version.versionReference,
        contentDigest: suite.version.contentDigest,
      },
    },
    { csrf: o.csrf, signal: o.signal },
  );
  if (o.signal.aborted || !o.isCurrent()) throw new TaxConfigAuthoringClientError("ScopeChanged");
  return result;
}
/** Apply a read result only while its captured comparison inputs still match. */
export async function finishTaxConfigEvidenceComparison(
  input: Parameters<typeof compareTaxConfigEvidenceMaterial>[0],
  apply: (value: TaxConfigMaterialComparison) => void,
) {
  const result = await compareTaxConfigEvidenceMaterial(input);
  if (input.signal.aborted || !input.isCurrent())
    throw new TaxConfigAuthoringClientError("ScopeChanged");
  apply(result);
  return result;
}
export function TaxConfigMaterialComparisonView({ value }: { value: TaxConfigMaterialComparison }) {
  return (
    <section aria-label="Mechanical fixture comparison">
      <h3>Mechanical fixture comparison</h3>
      <p>
        {value.comparison.allCasesMatched
          ? "All declared cases match the mechanical calculation."
          : "Some declared cases differ from the mechanical calculation."}
      </p>
      <p>
        Checked {value.observedAt}. This does not establish professional review, legal conclusions
        or approved coverage.
      </p>
      <ol>
        {value.comparison.cases.map((item, index) => (
          <li key={item.fixtureReference}>
            Case {index + 1}: {item.matches ? "Match" : "Mismatch"}
            {item.mismatchedFields.length > 0 &&
              ` · Different fields: ${item.mismatchedFields.join(", ")}`}
            <p>Actual checksum: {item.actualDigest}</p>
            <p>Declared expected checksum: {item.expectedDigest}</p>
          </li>
        ))}
      </ol>
      <p>
        Professional review: Not evaluated. Legal conclusion: Not evaluated. Reference eligibility:
        Not evaluated.
      </p>
    </section>
  );
}
export interface TaxConfigEvidenceMaterialPanelProps {
  scope: TaxConfigAuthoringScope;
  csrf: string;
  draft: TaxConfigAuthoringCurrent | null;
  disabled?: boolean;
  client?: Client;
  journalFactory?: typeof createTaxConfigMaterialPendingJournal;
}
export function TaxConfigEvidenceMaterialPanel({
  scope,
  csrf,
  draft,
  disabled = false,
  client: provided,
  journalFactory = createTaxConfigMaterialPendingJournal,
}: TaxConfigEvidenceMaterialPanelProps) {
  const client = useMemo(() => provided ?? createTaxConfigMaterialClient(), [provided]),
    key = canonical(scope),
    journal = useMemo(() => journalFactory(scope), [journalFactory, key]),
    configuration = draft?.state?.snapshot.configurationReference ?? null;
  const [kind, setKind] = useState<EvidenceKind>("FixtureSuite"),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [pending, setPending] = useState<TaxConfigMaterialCursor | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [reload, setReload] = useState(0),
    [fields, setFields] = useState(empty),
    [candidate, setCandidate] = useState<TaxConfigCandidateCurrent | null>(null),
    [candidates, setCandidates] = useState<TaxConfigCandidateRoster | null>(null),
    [baseline, setBaseline] = useState<TaxConfigMaterialCurrent | null>(null),
    [roster, setRoster] = useState<TaxConfigMaterialRoster | null>(null),
    [suites, setSuites] = useState<TaxConfigMaterialRoster | null>(null),
    [suite, setSuite] = useState<TaxConfigMaterialVersion | null>(null),
    [history, setHistory] = useState<TaxConfigMaterialCurrent | null>(null),
    [comparison, setComparison] = useState<TaxConfigMaterialComparison | null>(null);
  const epoch = useRef(0),
    alive = useRef(false),
    controllers = useRef(new Set<AbortController>()),
    alert = useRef<HTMLParagraphElement>(null);
  const locked = disabled || busy || pending !== null || !ready;
  const operation = (c: AbortController): Operation => {
    const generation = epoch.current;
    return {
      client,
      journal,
      csrf,
      signal: c.signal,
      isCurrent: () => alive.current && epoch.current === generation,
    };
  };
  const fail = (e: unknown) =>
    setError(
      e instanceof SyntaxError ||
        (e instanceof TaxConfigAuthoringClientError && e.code === "Invalid")
        ? "Check the material fields, structured JSON and saved source checksums. No qualification is inferred."
        : e instanceof TaxConfigAuthoringClientError && e.code === "Conflict"
          ? "Saved source changed. Refresh the current sources. Any original remains retained."
          : e instanceof TaxConfigAuthoringClientError && e.code === "Denied"
            ? "Current permission refused the request. Recover the retained original when access is restored."
            : "The material request could not be confirmed. Any original is retained for recovery.",
    );
  async function run(work: (o: Operation) => Promise<void>, recover = false) {
    if (busy || (!recover && locked)) return;
    const c = new AbortController();
    controllers.current.add(c);
    const o = operation(c);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work(o);
      check(o);
    } catch (e) {
      if (o.isCurrent() && !c.signal.aborted) fail(e);
    } finally {
      controllers.current.delete(c);
      if (o.isCurrent()) setBusy(false);
    }
  }
  const adopt = (value: TaxConfigMaterialCurrent) => {
    setBaseline(value);
    setHistory(null);
    const content = value.version?.content;
    if (content && "cases" in content)
      setFields({ ...empty(), suiteJson: JSON.stringify(content, null, 2) });
    else if (content && "declaredIssuer" in content)
      setFields({
        ...empty(),
        displayName: content.declaredIssuer.displayName,
        organizationName: content.declaredIssuer.organizationName ?? "",
        credentialIdentifier: content.declaredIssuer.credentialIdentifier ?? "",
        reviewedAt: content.reviewedAt,
        validUntil: content.validUntil,
        conclusion: content.declaredConclusion,
        sourceDigest: content.declaredSourceDigest ?? "",
      });
    else setFields(empty());
  };
  useEffect(() => {
    alive.current = true;
    const generation = ++epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    const o = operation(c);
    setBusy(true);
    setReady(false);
    setPending(null);
    setCandidate(null);
    setCandidates(null);
    setBaseline(null);
    setRoster(null);
    setSuites(null);
    setSuite(null);
    setHistory(null);
    setError("");
    setMessage("");
    void (async () => {
      const original = await journal.load();
      check(o);
      if (original) {
        setPending(original);
        setReady(true);
        return;
      }
      if (configuration) {
        const page = await createTaxConfigCandidateClient().roster(
          scope,
          { configurationReference: configuration, afterCandidate: null },
          { signal: c.signal },
        );
        check(o);
        setCandidates(page);
      }
      const current = await client.current(
        scope,
        { materialKind: kind, materialReference: null },
        { signal: c.signal },
      );
      check(o);
      adopt(current);
      const page = await createTaxConfigMaterialClient().roster(
        scope,
        { materialKind: kind, afterMaterial: null },
        { signal: c.signal },
      );
      check(o);
      setRoster(page);
      if (kind === "ProfessionalReport") {
        const choices = await createTaxConfigMaterialClient().roster(
          scope,
          { materialKind: "FixtureSuite", afterMaterial: null },
          { signal: c.signal },
        );
        check(o);
        setSuites(choices);
      }
      setReady(true);
    })()
      .catch((e) => {
        if (o.isCurrent() && !c.signal.aborted) fail(e);
      })
      .finally(() => {
        controllers.current.delete(c);
        if (alive.current && epoch.current === generation) setBusy(false);
      });
    return () => {
      alive.current = false;
      epoch.current++;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      client.invalidate();
    };
  }, [key, csrf, configuration, kind, reload, client, journal]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  const edit = (name: keyof TaxConfigEvidenceMaterialFields, value: string) =>
    setFields((old) => ({ ...old, [name]: value }));
  // This read-only identity is separate from Save/Resolve's original lifetime.
  // Updating it during render closes the interval before passive clear effects run.
  const comparisonInputs = [
    key,
    csrf,
    candidate,
    baseline,
    suite,
    history,
    fields,
    kind,
    reload,
    pending,
    disabled,
  ] as const;
  const comparisonIdentity = useRef({ inputs: comparisonInputs, generation: 0 });
  if (
    comparisonInputs.some(
      (value, index) => !Object.is(value, comparisonIdentity.current.inputs[index]),
    )
  )
    comparisonIdentity.current = {
      inputs: comparisonInputs,
      generation: comparisonIdentity.current.generation + 1,
    };
  useEffect(() => {
    setComparison(null);
  }, [key, csrf, candidate, baseline, suite, history, fields, kind, reload, pending, disabled]);
  const displayed = history?.version ?? baseline?.version;
  const comparisonSuite = kind === "FixtureSuite" ? displayed : suite;

  return (
    <section className="tax-config-evidence-material-panel" aria-label="Tax evidence materials">
      <h2>Professional reports and fixture suites</h2>
      <p>
        These are recorded declarations. Professional review, legal conclusions and publication
        qualification are not evaluated.
      </p>
      {busy && <p role="status">Loading saved material sources…</p>}
      {error && (
        <p ref={alert} role="alert" tabIndex={-1}>
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {pending ? (
        <section aria-label="Evidence original recovery">
          <p>
            An original {pending.materialKind} request is unresolved. All material kinds share this
            recovery barrier.
          </p>
          {pending.materialKind === "RegistrationApplicability" ? (
            <p>Switch to Registration materials to recover this original.</p>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async (o) => {
                  const result = await finishTaxConfigMaterialOriginal({ ...o, cursor: pending });
                  check(o);
                  setPending(null);
                  setReady(false);
                  setMessage(
                    result.receipt.outcome === "Committed"
                      ? "Original material recorded and refreshed. Refresh the workspace to continue."
                      : "Original request abandoned. No material was recorded.",
                  );
                }, true)
              }
            >
              Recover original material request
            </button>
          )}
        </section>
      ) : null}
      <button
        type="button"
        disabled={disabled || busy || pending !== null}
        onClick={() => {
          setBusy(true);
          setReady(false);
          setReload((v) => v + 1);
        }}
      >
        Refresh evidence workspace
      </button>
      {!pending && (
        <>
          <label>
            Material kind
            <select
              aria-label="Evidence material kind"
              value={kind}
              disabled={locked}
              onChange={(e) => {
                setBusy(true);
                setReady(false);
                setKind(
                  e.target.value === "ProfessionalReport" ? "ProfessionalReport" : "FixtureSuite",
                );
              }}
            >
              <option value="FixtureSuite">Fixture suite</option>
              <option value="ProfessionalReport">Professional report</option>
            </select>
          </label>
          <label>
            Saved publication candidate
            <select
              aria-label="Evidence publication candidate"
              value={candidate?.targetVersionReference ?? ""}
              disabled={locked || !configuration}
              onChange={(e) => {
                const target = e.target.value;
                void run(async (o) => {
                  if (!configuration) return;
                  const actual = await createTaxConfigCandidateClient().current(
                    scope,
                    {
                      configurationReference: configuration,
                      targetVersionReference: target || null,
                    },
                    { signal: o.signal },
                  );
                  check(o);
                  setCandidate(actual);
                });
              }}
            >
              <option value="">Choose a saved candidate</option>
              {candidates?.entries.map((v) => (
                <option key={v.targetVersionReference} value={v.targetVersionReference}>
                  Candidate version {v.targetVersionNumber} · {v.preparedAt}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={locked || !candidates?.nextAfterCandidate}
            onClick={() =>
              void run(async (o) => {
                if (!configuration) return;
                const page = await createTaxConfigCandidateClient().roster(
                  scope,
                  {
                    configurationReference: configuration,
                    afterCandidate: candidates?.nextAfterCandidate ?? null,
                  },
                  { signal: o.signal },
                );
                check(o);
                setCandidates(page);
              })
            }
          >
            Next evidence candidate page
          </button>
          {candidate?.record && (
            <p>
              Selected candidate version {candidate.record.candidate.content.targetVersionNumber}.
              Content checksum: {candidate.record.candidate.contentDigest}. Qualification: Not
              evaluated.
            </p>
          )}
          {candidate?.record && (
            <label>
              Selected candidate source JSON
              <textarea
                aria-label="Selected candidate source JSON"
                readOnly
                value={JSON.stringify(candidate.record.candidate, null, 2)}
              />
            </label>
          )}
          <label>
            Saved material
            <select
              aria-label="Saved evidence material"
              disabled={locked}
              value={baseline?.materialReference ?? ""}
              onChange={(e) => {
                const reference = e.target.value || null;
                void run(async (o) => {
                  const actual = await client.current(
                    scope,
                    { materialKind: kind, materialReference: reference },
                    { signal: o.signal },
                  );
                  check(o);
                  adopt(actual);
                });
              }}
            >
              <option value="">New material</option>
              {baseline?.version &&
                !roster?.entries.some(
                  (v) => v.materialReference === baseline.materialReference,
                ) && (
                  <option value={baseline.version.materialReference}>
                    Revision {baseline.version.revision} · {baseline.version.recordedAt}
                  </option>
                )}
              {roster?.entries.map((v) => (
                <option key={v.materialReference} value={v.materialReference}>
                  Revision {v.revision} · {v.recordedAt}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={locked || !roster?.nextAfterMaterial}
            onClick={() =>
              void run(async (o) => {
                const page = await createTaxConfigMaterialClient().roster(
                  scope,
                  { materialKind: kind, afterMaterial: roster?.nextAfterMaterial ?? null },
                  { signal: o.signal },
                );
                check(o);
                setRoster(page);
              })
            }
          >
            Next evidence material page
          </button>
          {displayed && (
            <section aria-label="Saved evidence content">
              <h3>
                {history ? "Historical saved material" : "Current saved material"} revision{" "}
                {displayed.revision}
              </h3>
              <p>Recorded {displayed.recordedAt}. Qualification: Not evaluated.</p>
              <label>
                Recorded evidence JSON
                <textarea
                  aria-label="Recorded evidence JSON"
                  readOnly
                  value={JSON.stringify(displayed.content, null, 2)}
                />
              </label>
            </section>
          )}
          <button
            type="button"
            disabled={locked || !baseline?.version?.previousVersionReference}
            onClick={() =>
              void run(async (o) => {
                const reference = baseline?.version?.previousVersionReference;
                if (!reference) return;
                const old = await client.version(
                  scope,
                  { materialKind: kind, versionReference: reference },
                  { signal: o.signal },
                );
                check(o);
                setHistory(old);
              })
            }
          >
            Previous evidence version
          </button>
          {history && (
            <button type="button" disabled={locked} onClick={() => setHistory(null)}>
              Return to current evidence
            </button>
          )}
          {kind === "FixtureSuite" ? (
            <label>
              Structured fixture suite JSON
              <textarea
                aria-label="Structured fixture suite JSON"
                value={fields.suiteJson}
                disabled={locked}
                onChange={(e) => edit("suiteJson", e.target.value)}
              />
            </label>
          ) : (
            <>
              <label>
                Saved fixture suite
                <select
                  aria-label="Report fixture suite"
                  value={suite?.materialReference ?? ""}
                  disabled={locked}
                  onChange={(e) => {
                    const reference = e.target.value;
                    void run(async (o) => {
                      const selected = await client.current(
                        scope,
                        { materialKind: "FixtureSuite", materialReference: reference || null },
                        { signal: o.signal },
                      );
                      check(o);
                      setSuite(selected.version);
                    });
                  }}
                >
                  <option value="">Choose a recorded suite</option>
                  {suites?.entries.map((v) => (
                    <option value={v.materialReference} key={v.materialReference}>
                      Suite revision {v.revision} · {v.recordedAt}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={locked || !suites?.nextAfterMaterial}
                onClick={() =>
                  void run(async (o) => {
                    const page = await createTaxConfigMaterialClient().roster(
                      scope,
                      {
                        materialKind: "FixtureSuite",
                        afterMaterial: suites?.nextAfterMaterial ?? null,
                      },
                      { signal: o.signal },
                    );
                    check(o);
                    setSuites(page);
                  })
                }
              >
                Next report suite page
              </button>
              {(
                [
                  ["displayName", "Declared issuer name"],
                  ["organizationName", "Issuer organization (optional)"],
                  ["credentialIdentifier", "Issuer credential identifier (optional)"],
                  ["reviewedAt", "Report reviewed at (UTC)"],
                  ["validUntil", "Report valid until (UTC)"],
                  ["sourceDigest", "Report source checksum (optional)"],
                ] as const
              ).map(([name, label]) => (
                <label key={name}>
                  {label}
                  <input
                    aria-label={label}
                    value={fields[name]}
                    disabled={locked}
                    onChange={(e) => edit(name, e.target.value)}
                  />
                </label>
              ))}
              <label>
                Declared conclusion
                <select
                  aria-label="Declared report conclusion"
                  value={fields.conclusion}
                  disabled={locked}
                  onChange={(e) => edit("conclusion", e.target.value)}
                >
                  <option value="">Choose the external declaration</option>
                  <option value="Pass">Pass (declared, not certified)</option>
                  <option value="Fail">Fail (declared, not certified)</option>
                </select>
              </label>
            </>
          )}
          <p>
            Fixture JSON must contain the complete closed suite, actual selected candidate and
            Currency pins, explicit Basket or Refund fixtures and integer expected totals. Saved
            candidate references are read from the selected source; arbitrary replacement pins are
            refused.
          </p>
          <button
            type="button"
            disabled={
              locked ||
              !configuration ||
              !candidate?.record ||
              !baseline ||
              history !== null ||
              (kind === "ProfessionalReport" && !suite)
            }
            onClick={() =>
              void run(async (o) => {
                if (!baseline || !candidate) return;
                const result = await saveTaxConfigEvidenceMaterial({
                  ...o,
                  scope,
                  kind,
                  baseline,
                  candidate,
                  suite,
                  fields,
                  onReserved: setPending,
                });
                check(o);
                setPending(null);
                adopt(result.current);
                setMessage(
                  result.receipt.outcome === "Committed"
                    ? "Material recorded and refreshed. Qualification remains not evaluated."
                    : "Original request abandoned. No material was recorded.",
                );
              })
            }
          >
            Save evidence material
          </button>
        </>
      )}
      <button
        type="button"
        disabled={
          locked ||
          !candidate?.record ||
          !comparisonSuite ||
          comparisonSuite.materialKind !== "FixtureSuite"
        }
        onClick={() =>
          void run(async (o) => {
            if (!candidate || !comparisonSuite) return;
            setComparison(null);
            const generation = comparisonIdentity.current.generation;
            try {
              await finishTaxConfigEvidenceComparison(
                {
                  ...o,
                  isCurrent: () =>
                    o.isCurrent() && comparisonIdentity.current.generation === generation,
                  scope,
                  candidate,
                  suite: comparisonSuite,
                },
                setComparison,
              );
            } catch (error) {
              if (
                error instanceof TaxConfigAuthoringClientError &&
                error.code === "ScopeChanged" &&
                (o.signal.aborted ||
                  !o.isCurrent() ||
                  comparisonIdentity.current.generation !== generation)
              )
                return;
              throw error;
            }
          })
        }
      >
        Compare saved fixture expectations
      </button>
      {comparison && <TaxConfigMaterialComparisonView value={comparison} />}
      <p>
        Independent review and publishing remain unavailable until qualified sources and approved
        coverage are connected.
      </p>
    </section>
  );
}
