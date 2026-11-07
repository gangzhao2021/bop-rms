import { useEffect, useMemo, useRef, useState } from "react";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createMerchantBrandStoreTopologyClient,
  BrandStoreTopologyClientError,
  parseBrandTopologyDraft,
  type BrandTopologyWorkspace,
  type BrandTopologyScope,
  type BrandTopologyDraft,
  type BrandTopologyCursor,
  type PreparedBrandTopologySave,
} from "./merchant-brand-store-topology-client.js";
import {
  createBrandStoreTopologyJournal,
  type BrandStoreTopologyJournal,
} from "./brand-store-topology-journal.js";
export interface BrandStoreTopologyDraftPanelProps {
  expectedBrandReference: string;
  csrf: string;
  disabled?: boolean;
  onScopeChange?: (scope: BrandTopologyScope) => void;
  client?: ReturnType<typeof createMerchantBrandStoreTopologyClient>;
  journalFactory?: (scope: BrandTopologyScope) => BrandStoreTopologyJournal;
}
/** Ordinary original-operation orchestration with an actual refreshed workspace.
 * Pure controlled tests do not establish Session/IAM or PostgreSQL evidence. */
export async function finishBrandTopologyOriginal(input: {
  client: ReturnType<typeof createMerchantBrandStoreTopologyClient>;
  journal: BrandStoreTopologyJournal;
  scope: BrandTopologyScope;
  cursor: BrandTopologyCursor;
  csrf: string;
  prepared?: PreparedBrandTopologySave;
  signal: AbortSignal;
  isCurrent: () => boolean;
}) {
  const { client, journal, scope, cursor, csrf, signal, isCurrent } = input;
  const check = () => {
    if (signal.aborted || !isCurrent()) throw new BrandStoreTopologyClientError("ScopeChanged");
  };
  check();
  const receipt = input.prepared
    ? await client.execute(input.prepared, { csrf, signal })
    : await client.resolve(cursor, { csrf, signal });
  check();
  const workspace = await client.workspace(
    { expectedBrandReference: scope.brandReference, expectedScope: scope },
    { csrf, signal },
  );
  check();
  await journal.complete(cursor, receipt, workspace);
  check();
  return workspace;
}
export async function prepareBrandTopologyOriginal(input: {
  client: ReturnType<typeof createMerchantBrandStoreTopologyClient>;
  journal: BrandStoreTopologyJournal;
  workspace: BrandTopologyWorkspace;
  content: BrandTopologyDraft;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onReserved: (cursor: BrandTopologyCursor) => void;
}) {
  const { client, journal, workspace, content, csrf, signal, isCurrent, onReserved } = input;
  const scope = {
    tenantReference: workspace.tenantReference,
    brandReference: workspace.brandReference,
    actorReference: workspace.actorReference,
  };
  const check = () => {
    if (signal.aborted || !isCurrent()) throw new BrandStoreTopologyClientError("ScopeChanged");
  };
  check();
  const fresh = await client.workspace(
    { expectedBrandReference: scope.brandReference, expectedScope: scope },
    { csrf, signal },
  );
  check();
  if (canonical(fresh.current.current) !== canonical(workspace.current.current))
    throw new BrandStoreTopologyClientError("Conflict");
  const prepared = await client.prepare(
    scope,
    {
      profile: "BrandStoreTopologySaveV1",
      ...scope,
      operationReference: serviceOperationReference(),
      expectedRevision: fresh.current.current?.revision ?? 0,
      content,
    },
    { signal },
  );
  check();
  await journal.reserve(prepared.cursor);
  onReserved(prepared.cursor);
  check();
  return finishBrandTopologyOriginal({
    client,
    journal,
    scope,
    cursor: prepared.cursor,
    csrf,
    prepared,
    signal,
    isCurrent,
  });
}
export function BrandStoreTopologyDraftPanel({
  expectedBrandReference,
  csrf,
  disabled = false,
  onScopeChange,
  client: provided,
  journalFactory = createBrandStoreTopologyJournal,
}: BrandStoreTopologyDraftPanelProps) {
  const client = useMemo(() => provided ?? createMerchantBrandStoreTopologyClient(), [provided]);
  const [workspace, setWorkspace] = useState<BrandTopologyWorkspace | null>(null),
    [content, setContent] = useState<BrandTopologyDraft | null>(null),
    [pending, setPending] = useState<BrandTopologyCursor | null>(null),
    [busy, setBusy] = useState(true),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [reload, setReload] = useState(0),
    [history, setHistory] = useState<number | null>(null);
  const [kind, setKind] = useState<"Region" | "StoreGroup">("Region"),
    [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [selectedStore, setSelectedStore] = useState(""),
    [selectedSelector, setSelectedSelector] = useState("");
  const epoch = useRef(0),
    active = useRef<AbortController | null>(null),
    alert = useRef<HTMLParagraphElement | null>(null),
    scopeCallback = useRef(onScopeChange);
  scopeCallback.current = onScopeChange;
  const scope = workspace
    ? {
        tenantReference: workspace.tenantReference,
        brandReference: workspace.brandReference,
        actorReference: workspace.actorReference,
      }
    : null;
  const journal = useMemo(
    () => (scope ? journalFactory(scope) : null),
    [
      workspace?.tenantReference,
      workspace?.brandReference,
      workspace?.actorReference,
      journalFactory,
    ],
  );
  const adopt = (value: BrandTopologyWorkspace) => {
    setWorkspace(value);
    setContent(
      value.current.current?.content ??
        Object.freeze({
          profile: "BrandStoreTopologyDraftV1",
          tenantReference: value.tenantReference,
          brandReference: value.brandReference,
          draftReference: serviceOperationReference(),
          selectors: [],
          assignments: [],
        }),
    );
    setHistory(null);
    setSelectedStore("");
    setSelectedSelector("");
  };
  const showError = (e: unknown) =>
    setError(
      e instanceof BrandStoreTopologyClientError
        ? `Topology draft ${e.code}. Original requests remain available for recovery.`
        : "Topology draft unavailable. Try again.",
    );
  useEffect(() => {
    const generation = ++epoch.current,
      controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    client.invalidate();
    setWorkspace(null);
    setContent(null);
    setPending(null);
    setError("");
    setStatus("");
    setReady(false);
    setBusy(true);
    const valid = () => generation === epoch.current && !controller.signal.aborted;
    void (async () => {
      try {
        const value = await client.workspace(
          { expectedBrandReference },
          { csrf, signal: controller.signal },
        );
        if (!valid()) return;
        const actualScope = {
          tenantReference: value.tenantReference,
          brandReference: value.brandReference,
          actorReference: value.actorReference,
        };
        const cursor = await journalFactory(actualScope).load();
        if (!valid()) return;
        setWorkspace(value);
        scopeCallback.current?.(actualScope);
        if (cursor) {
          setPending(cursor);
          setStatus("An original topology save needs recovery before editing.");
        } else adopt(value);
        setReady(true);
      } catch (e) {
        if (valid()) showError(e);
      } finally {
        if (valid()) setBusy(false);
      }
    })();
    return () => {
      epoch.current++;
      controller.abort();
      client.invalidate();
    };
  }, [expectedBrandReference, csrf, client, journalFactory, reload]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  const locked = disabled || busy || !!pending || !ready;
  const dirty =
    !!content && canonical(content) !== canonical(workspace?.current.current?.content ?? null);
  const begin = () => {
    const generation = epoch.current,
      controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    return {
      signal: controller.signal,
      isCurrent: () => generation === epoch.current && !controller.signal.aborted,
    };
  };
  const save = async () => {
    if (locked || !workspace || !content || !journal) return;
    const identity = begin();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const value = await prepareBrandTopologyOriginal({
        client,
        journal,
        workspace,
        content,
        csrf,
        ...identity,
        onReserved: (cursor) => {
          if (identity.isCurrent()) setPending(cursor);
        },
      });
      if (identity.isCurrent()) {
        setPending(null);
        adopt(value);
        setStatus("Topology draft saved. It is not effective membership.");
      }
    } catch (e) {
      if (identity.isCurrent()) showError(e);
    } finally {
      if (identity.isCurrent()) setBusy(false);
    }
  };
  const recover = async () => {
    if (busy || !pending || !scope || !journal) return;
    const identity = begin();
    setBusy(true);
    setError("");
    try {
      const value = await finishBrandTopologyOriginal({
        client,
        journal,
        scope,
        cursor: pending,
        csrf,
        ...identity,
      });
      if (identity.isCurrent()) {
        setPending(null);
        adopt(value);
        setReady(true);
        setStatus("Original request recovered and saved workspace refreshed.");
      }
    } catch (e) {
      if (identity.isCurrent()) showError(e);
    } finally {
      if (identity.isCurrent()) setBusy(false);
    }
  };
  const change = (value: BrandTopologyDraft) => {
    if (!locked) setContent(value);
  };
  const add = () => {
    if (locked || !content || !scope) return;
    try {
      change(
        parseBrandTopologyDraft(
          {
            ...content,
            selectors: [
              ...content.selectors,
              {
                kind,
                reference: serviceOperationReference(),
                code: code.trim().toUpperCase(),
                name: name.trim(),
              },
            ],
          },
          scope,
        ),
      );
      setCode("");
      setName("");
      setError("");
    } catch (e) {
      showError(e);
    }
  };
  const assign = () => {
    if (
      locked ||
      !content ||
      !scope ||
      !workspace?.stores.references.some((s) => s.storeReference === selectedStore) ||
      !content.selectors.some((s) => s.reference === selectedSelector)
    )
      return;
    try {
      change(
        parseBrandTopologyDraft(
          {
            ...content,
            assignments: [
              ...content.assignments,
              { storeReference: selectedStore, selectorReference: selectedSelector },
            ],
          },
          scope,
        ),
      );
      setError("");
    } catch (e) {
      showError(e);
    }
  };
  const historical = workspace?.history.find((row) => row.revision === history);
  return (
    <section
      className="brand-store-topology-draft-panel"
      aria-label="Brand Store topology draft"
      aria-busy={busy}
    >
      <h2>Brand Store topology draft</h2>
      <p>
        Saved draft only. These Region and Store Group assignments are not effective membership.
        Approval and publication are not available in this workflow.
      </p>
      {error && (
        <p role="alert" ref={alert} tabIndex={-1}>
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {busy && !ready && <p>Loading topology draft…</p>}
      {pending && (
        <div>
          <p>Editing is locked while an original topology save is unresolved.</p>
          <button type="button" disabled={busy} onClick={() => void recover()}>
            Recover original topology save
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={busy || !!pending || disabled}
        onClick={() => {
          setBusy(true);
          setReady(false);
          setReload((n) => n + 1);
        }}
      >
        {" "}
        {dirty ? "Reload saved draft (discard local changes)" : "Refresh saved topology draft"}
      </button>
      {workspace && (
        <>
          <p>
            Saved revision {workspace.current.current?.revision ?? 0}. Store identities include
            their recorded lifecycle; this list does not establish operating eligibility.
          </p>
          <label>
            Saved topology history
            <select
              aria-label="Saved topology history"
              value={history ?? ""}
              disabled={busy || !!pending}
              onChange={(e) =>
                setHistory(e.currentTarget.value ? Number(e.currentTarget.value) : null)
              }
            >
              <option value="">Current draft</option>
              {workspace.history.map((row) => (
                <option key={row.revision} value={row.revision}>
                  Revision {row.revision} — {row.updatedAt}
                </option>
              ))}
            </select>
          </label>
          {historical && (
            <div role="region" aria-label="Historical topology draft">
              <h3>Recorded revision {historical.revision}</h3>
              <p>Read only; editing still uses the latest saved draft.</p>
              {historical.content.selectors.map((s) => (
                <p key={s.reference}>
                  {s.kind}: {s.code} — {s.name}
                </p>
              ))}
              {historical.content.assignments.map((a) => (
                <p key={`${a.storeReference}:${a.selectorReference}`}>
                  {workspace.stores.references.find((s) => s.storeReference === a.storeReference)
                    ?.displayName ?? "Saved Store identity"}{" "}
                  →{" "}
                  {
                    historical.content.selectors.find((s) => s.reference === a.selectorReference)
                      ?.name
                  }
                </p>
              ))}
            </div>
          )}
        </>
      )}
      {content && (
        <>
          <fieldset disabled={locked}>
            <legend>Region and Store Group definitions</legend>
            <label>
              Selector kind
              <select
                aria-label="Selector kind"
                value={kind}
                onChange={(e) =>
                  setKind(e.currentTarget.value === "Region" ? "Region" : "StoreGroup")
                }
              >
                <option value="Region">Region</option>
                <option value="StoreGroup">Store Group</option>
              </select>
            </label>
            <label>
              Selector code
              <input
                aria-label="Selector code"
                value={code}
                maxLength={63}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
            </label>
            <label>
              Selector name
              <input
                aria-label="Selector name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </label>
            <button type="button" onClick={add}>
              Add selector
            </button>
            {content.selectors.map((s, i) => (
              <div key={s.reference}>
                <p>{s.kind}</p>
                <label>
                  {`Selector ${i + 1} code`}
                  <input
                    aria-label={`Selector ${i + 1} code`}
                    value={s.code}
                    maxLength={63}
                    onChange={(e) =>
                      change({
                        ...content,
                        selectors: content.selectors.map((t) =>
                          t.reference === s.reference ? { ...t, code: e.currentTarget.value } : t,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  {`Selector ${i + 1} name`}
                  <input
                    aria-label={`Selector ${i + 1} name`}
                    value={s.name}
                    maxLength={120}
                    onChange={(e) =>
                      change({
                        ...content,
                        selectors: content.selectors.map((t) =>
                          t.reference === s.reference ? { ...t, name: e.currentTarget.value } : t,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    change({
                      ...content,
                      selectors: content.selectors.filter((t) => t.reference !== s.reference),
                      assignments: content.assignments.filter(
                        (a) => a.selectorReference !== s.reference,
                      ),
                    })
                  }
                >
                  Remove {s.name}
                </button>
              </div>
            ))}
          </fieldset>
          <fieldset disabled={locked}>
            <legend>Store assignments</legend>
            <label>
              Registered Store
              <select
                aria-label="Registered Store"
                value={selectedStore}
                onChange={(e) => setSelectedStore(e.currentTarget.value)}
              >
                <option value="">Choose a Store</option>
                {workspace?.stores.references.map((s) => (
                  <option key={s.storeReference} value={s.storeReference}>
                    {s.code} — {s.displayName} ({s.lifecycle})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Assignment selector
              <select
                aria-label="Assignment selector"
                value={selectedSelector}
                onChange={(e) => setSelectedSelector(e.currentTarget.value)}
              >
                <option value="">Choose a Region or Store Group</option>
                {content.selectors.map((s) => (
                  <option key={s.reference} value={s.reference}>
                    {s.kind} — {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={!selectedStore || !selectedSelector} onClick={assign}>
              Assign Store
            </button>
            {content.assignments.map((a) => {
              const store = workspace?.stores.references.find(
                  (s) => s.storeReference === a.storeReference,
                ),
                selector = content.selectors.find((s) => s.reference === a.selectorReference);
              return (
                <div key={`${a.storeReference}:${a.selectorReference}`}>
                  <span>
                    {store?.displayName ?? "Saved Store identity"} → {selector?.name}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      change({
                        ...content,
                        assignments: content.assignments.filter(
                          (t) =>
                            t.storeReference !== a.storeReference ||
                            t.selectorReference !== a.selectorReference,
                        ),
                      })
                    }
                  >
                    Unassign {store?.displayName ?? "saved Store"} from {selector?.name}
                  </button>
                </div>
              );
            })}
          </fieldset>
          <button type="button" disabled={locked || !dirty} onClick={() => void save()}>
            Save topology draft
          </button>
        </>
      )}
    </section>
  );
}
