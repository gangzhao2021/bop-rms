import { useEffect, useMemo, useRef, useState } from "react";
import {
  createTaxConfigCandidateClient,
  type TaxConfigCandidateCurrent,
  type TaxConfigCandidateRoster,
  type TaxConfigCandidateCursor,
  type PreparedTaxConfigCandidateCommand,
} from "./tax-config-candidate-client.js";
import { createTaxConfigCandidatePendingJournal } from "./tax-config-candidate-pending-journal.js";
import {
  createTaxConfigMaterialClient,
  type TaxConfigMaterialCurrent,
  type TaxConfigMaterialRoster,
} from "./tax-config-material-client.js";
import {
  createTaxConfigAuthoringClient,
  TaxConfigAuthoringClientError,
  type TaxConfigAuthoringScope,
  type TaxConfigAuthoringCurrent,
} from "./tax-config-authoring-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";
type Client = ReturnType<typeof createTaxConfigCandidateClient>;
type Journal = ReturnType<typeof createTaxConfigCandidatePendingJournal>;
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
export async function finishTaxConfigCandidateOriginal(
  o: Operation & { cursor: TaxConfigCandidateCursor; prepared?: PreparedTaxConfigCandidateCommand },
) {
  check(o);
  if (o.prepared && canonical(o.prepared.cursor) !== canonical(o.cursor))
    throw new TaxConfigAuthoringClientError("Conflict");
  const receipt = o.prepared
    ? await o.client.execute(o.prepared, { csrf: o.csrf, signal: o.signal })
    : await o.client.resolve(o.cursor, { csrf: o.csrf, signal: o.signal });
  check(o);
  const current = await o.client.current(
    o.cursor.scope,
    {
      configurationReference: o.cursor.configurationReference,
      targetVersionReference: receipt.result?.candidate.content.targetVersionReference ?? null,
    },
    { signal: o.signal },
  );
  check(o);
  await o.journal.complete(o.cursor, receipt, current);
  check(o);
  return { receipt, current };
}
export async function prepareTaxConfigCandidate(
  o: Operation & {
    scope: TaxConfigAuthoringScope;
    draft: TaxConfigAuthoringCurrent;
    material: TaxConfigMaterialCurrent;
    onReserved: (cursor: TaxConfigCandidateCursor) => void;
  },
) {
  check(o);
  const configured = o.draft.state?.snapshot.configurationReference;
  if (
    !configured ||
    !o.material.version ||
    o.material.version.materialKind !== "RegistrationApplicability"
  )
    throw new TaxConfigAuthoringClientError("Conflict");
  const actual = await createTaxConfigAuthoringClient().current(
    { scope: o.scope, configurationReference: configured },
    { signal: o.signal },
  );
  check(o);
  if (!actual.state || canonical(actual.state) !== canonical(o.draft.state))
    throw new TaxConfigAuthoringClientError("Conflict");
  const chosen = await createTaxConfigMaterialClient().current(
    o.scope,
    {
      materialKind: "RegistrationApplicability",
      materialReference: o.material.version.materialReference,
    },
    { signal: o.signal },
  );
  check(o);
  if (!chosen.version || canonical(chosen.version) !== canonical(o.material.version))
    throw new TaxConfigAuthoringClientError("Conflict");
  const s = actual.state.snapshot,
    p = await o.client.prepare(
      o.scope,
      {
        action: "PrepareCandidate",
        operationReference: serviceOperationReference(),
        configurationReference: s.configurationReference,
        expectedDraft: {
          versionReference: s.versionReference,
          snapshotDigest: s.snapshotDigest,
          aggregateVersion: s.aggregateVersion,
          versionNumber: s.versionNumber,
        },
        registrationMaterial: {
          materialReference: chosen.version.materialReference,
          versionReference: chosen.version.versionReference,
          contentDigest: chosen.version.contentDigest,
        },
      },
      { signal: o.signal },
    );
  check(o);
  await o.journal.reserve(p.cursor);
  check(o);
  o.onReserved(p.cursor);
  return finishTaxConfigCandidateOriginal({ ...o, cursor: p.cursor, prepared: p });
}
export interface TaxConfigCandidatePanelProps {
  scope: TaxConfigAuthoringScope;
  csrf: string;
  draft: TaxConfigAuthoringCurrent | null;
  disabled?: boolean;
  client?: Client;
  journalFactory?: typeof createTaxConfigCandidatePendingJournal;
}
export function TaxConfigCandidatePanel({
  scope,
  csrf,
  draft,
  disabled = false,
  client: provided,
  journalFactory = createTaxConfigCandidatePendingJournal,
}: TaxConfigCandidatePanelProps) {
  const client = useMemo(() => provided ?? createTaxConfigCandidateClient(), [provided]),
    key = canonical(scope),
    draftKey = canonical(
      draft?.state
        ? {
            configurationReference: draft.configurationReference,
            versionReference: draft.state.snapshot.versionReference,
            snapshotDigest: draft.state.snapshot.snapshotDigest,
          }
        : null,
    ),
    journal = useMemo(() => journalFactory(scope), [journalFactory, key]);
  const epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    alive = useRef(false),
    alert = useRef<HTMLParagraphElement>(null);
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [pending, setPending] = useState<TaxConfigCandidateCursor | null>(null),
    [current, setCurrent] = useState<TaxConfigCandidateCurrent | null>(null),
    [roster, setRoster] = useState<TaxConfigCandidateRoster | null>(null),
    [materials, setMaterials] = useState<TaxConfigMaterialRoster | null>(null),
    [material, setMaterial] = useState<TaxConfigMaterialCurrent | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [reload, setReload] = useState(0);
  const configured = draft?.state?.snapshot.configurationReference ?? null;
  const locked = disabled || busy || !ready || pending !== null;
  function operation(controller: AbortController): Operation {
    const generation = epoch.current;
    return {
      client,
      journal,
      csrf,
      signal: controller.signal,
      isCurrent: () => alive.current && epoch.current === generation,
    };
  }
  function fail(error: unknown) {
    const code = error instanceof TaxConfigAuthoringClientError ? error.code : "Unavailable";
    setError(
      code === "Denied"
        ? "Current permission refused this request. The original remains recoverable."
        : code === "Conflict"
          ? "Saved source changed. Refresh and select the current sources; an unresolved original is retained."
          : code === "FeatureDisabled"
            ? "Tax authoring is disabled. Any original request remains retained."
            : "The request could not be confirmed. Retained originals must be recovered before preparing again.",
    );
  }
  async function run(work: (o: Operation) => Promise<void>, recovery = false) {
    if (busy || (!recovery && locked)) return;
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
  useEffect(() => {
    alive.current = true;
    const generation = ++epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    setBusy(true);
    setReady(false);
    setPending(null);
    setCurrent(null);
    setRoster(null);
    setMaterials(null);
    setMaterial(null);
    setError("");
    setMessage("");
    const o = operation(c);
    void (async () => {
      const cursor = await journal.load();
      check(o);
      if (cursor) {
        setPending(cursor);
        setReady(true);
        return;
      }
      if (configured) {
        const value = await client.current(
          scope,
          { configurationReference: configured, targetVersionReference: null },
          { signal: c.signal },
        );
        check(o);
        setCurrent(value);
        const page = await createTaxConfigCandidateClient().roster(
          scope,
          { configurationReference: configured, afterCandidate: null },
          { signal: c.signal },
        );
        check(o);
        setRoster(page);
        const choices = await createTaxConfigMaterialClient().roster(
          scope,
          { materialKind: "RegistrationApplicability", afterMaterial: null },
          { signal: c.signal },
        );
        check(o);
        setMaterials(choices);
      }
      setReady(true);
    })()
      .catch((e) => {
        if (alive.current && epoch.current === generation && !c.signal.aborted) fail(e);
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
  }, [key, csrf, draftKey, client, journal, reload]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  const packet = current?.record
    ? JSON.stringify(
        {
          candidate: current.record.candidate,
          preparedAt: current.record.preparedAt,
          qualification: current.record.qualification,
        },
        null,
        2,
      )
    : "";
  return (
    <section className="tax-config-candidate-panel" aria-label="Tax publication candidates">
      <h2>Tax publication candidates</h2>
      <p>
        Preparation records the saved Draft and registration declaration for external review. It
        does not establish professional approval, legal conclusions or publication eligibility.
      </p>
      {busy && <p role="status">Loading saved candidate sources…</p>}
      {error && (
        <p role="alert" tabIndex={-1} ref={alert}>
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {pending ? (
        <section aria-label="Original candidate recovery">
          <p>
            An original candidate request is unresolved. Preparing and source selection are locked.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async (o) => {
                const result = await finishTaxConfigCandidateOriginal({ ...o, cursor: pending });
                check(o);
                setCurrent(result.current);
                setPending(null);
                setReady(false);
                setMessage(
                  result.receipt.outcome === "Committed"
                    ? "Original candidate was prepared. Its immutable version was refreshed."
                    : "The original candidate request was abandoned. No candidate was prepared.",
                );
              }, true)
            }
          >
            Recover original candidate preparation
          </button>
        </section>
      ) : (
        <>
          {!configured && <p>Save a Tax Draft before preparing a candidate.</p>}
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              setBusy(true);
              setReady(false);
              setReload((n) => n + 1);
            }}
          >
            Refresh candidate workspace
          </button>
          <label>
            Saved registration declaration
            <select
              aria-label="Saved registration declaration"
              disabled={locked || !configured}
              value={material?.materialReference ?? ""}
              onChange={(e) => {
                const reference = e.target.value;
                void run(async (o) => {
                  if (!reference) {
                    setMaterial(null);
                    return;
                  }
                  const value = await createTaxConfigMaterialClient().current(
                    scope,
                    { materialKind: "RegistrationApplicability", materialReference: reference },
                    { signal: o.signal },
                  );
                  check(o);
                  setMaterial(value);
                });
              }}
            >
              <option value="">Choose a saved registration declaration</option>
              {materials?.entries.map((v) => (
                <option key={v.materialReference} value={v.materialReference}>
                  Revision {v.revision} · {v.recordedAt}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={locked || !materials?.nextAfterMaterial}
            onClick={() =>
              void run(async (o) => {
                const value = await createTaxConfigMaterialClient().roster(
                  scope,
                  {
                    materialKind: "RegistrationApplicability",
                    afterMaterial: materials?.nextAfterMaterial ?? null,
                  },
                  { signal: o.signal },
                );
                check(o);
                setMaterials(value);
              })
            }
          >
            Next registration page
          </button>
          {material?.version && (
            <p>
              Selected registration revision {material.version.revision}. Qualification: Not
              evaluated.{" "}
              {material.version.content && "applicability" in material.version.content
                ? `Declared applicability: ${material.version.content.applicability}.`
                : ""}
            </p>
          )}
          <button
            type="button"
            disabled={locked || !draft?.state || !material?.version}
            onClick={() =>
              void run(async (o) => {
                if (!draft?.state || !material?.version || !configured) return;
                const result = await prepareTaxConfigCandidate({
                  ...o,
                  scope,
                  draft,
                  material,
                  onReserved: setPending,
                });
                check(o);
                setCurrent(result.current);
                setPending(null);
                setMessage(
                  result.receipt.outcome === "Committed"
                    ? "Candidate prepared. Professional and legal qualification remain not evaluated."
                    : "The original request was abandoned. No candidate was prepared.",
                );
              })
            }
          >
            Prepare publication candidate
          </button>
          <label>
            Saved publication candidate
            <select
              aria-label="Saved publication candidate"
              disabled={locked || !configured}
              value={current?.targetVersionReference ?? ""}
              onChange={(e) => {
                const targetVersionReference = e.target.value || null;
                void run(async (o) => {
                  if (!configured) return;
                  const value = await client.current(
                    scope,
                    {
                      configurationReference: configured,
                      targetVersionReference,
                    },
                    { signal: o.signal },
                  );
                  check(o);
                  setCurrent(value);
                });
              }}
            >
              <option value="">Current latest candidate</option>
              {current?.record &&
                !roster?.entries.some(
                  (v) =>
                    v.targetVersionReference ===
                    current.record?.candidate.content.targetVersionReference,
                ) && (
                  <option value={current.record.candidate.content.targetVersionReference}>
                    Candidate version {current.record.candidate.content.targetVersionNumber} ·{" "}
                    {current.record.preparedAt}
                  </option>
                )}
              {roster?.entries.map((v) => (
                <option key={v.targetVersionReference} value={v.targetVersionReference}>
                  Candidate version {v.targetVersionNumber} · {v.preparedAt}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={locked || !roster?.nextAfterCandidate}
            onClick={() =>
              void run(async (o) => {
                if (!configured) return;
                const value = await createTaxConfigCandidateClient().roster(
                  scope,
                  {
                    configurationReference: configured,
                    afterCandidate: roster?.nextAfterCandidate ?? null,
                  },
                  { signal: o.signal },
                );
                check(o);
                setRoster(value);
              })
            }
          >
            Next candidate page
          </button>
        </>
      )}
      {current?.record && (
        <section aria-label="Recorded publication candidate">
          <h3>Candidate version {current.record.candidate.content.targetVersionNumber}</h3>
          <p>Prepared {current.record.preparedAt}. Qualification: Not evaluated.</p>
          <p>Content checksum: {current.record.candidate.contentDigest}</p>
          <label>
            External review packet
            <textarea aria-label="External review packet" readOnly value={packet} />
          </label>
          <button
            type="button"
            disabled={disabled || busy || pending !== null}
            onClick={() => {
              const blob = new Blob([packet], { type: "application/json" }),
                url = URL.createObjectURL(blob),
                a = document.createElement("a");
              a.href = url;
              a.download = "tax-publication-candidate.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download external review packet
          </button>
        </section>
      )}
      <p>
        Submission, independent approval and publishing are not available until genuine professional
        materials and coverage sources are connected.
      </p>
    </section>
  );
}
