import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ProductEditorView } from "./product-editor-client.js";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import {
  createOptionPriceAuthoringClient,
  OptionPriceAuthoringClientError,
  type OptionPriceAuthoringQuery,
} from "./option-price-authoring-client.js";
import {
  createOptionPriceReviewClient,
  OptionPriceReviewClientError,
  type OptionPriceReviewCurrent,
} from "./option-price-review-client.js";
import {
  createOptionPricePendingJournal,
  createOptionPricePendingDiscovery,
  type OptionPricePendingJournal,
  type OptionPricePendingOriginal,
} from "./option-price-pending-journal.js";
import { serviceOperationReference } from "./service-control-client.js";
import { canonicalPublicationValue } from "./product-publication-command-client-v2.js";

interface Props {
  readonly entry: ProductEditorView | null;
  readonly productReference: string;
  readonly storeReference: string;
  readonly csrf: string;
  readonly client?: ReturnType<typeof createOptionPriceAuthoringClient>;
  readonly reviewClient?: ReturnType<typeof createOptionPriceReviewClient>;
  readonly capabilityClient?: ReturnType<typeof createStoreCapabilityClient>;
  readonly journalFactory?: typeof createOptionPricePendingJournal;
  readonly discoveryFactory?: typeof createOptionPricePendingDiscovery;
  readonly operationReference?: typeof serviceOperationReference;
}
interface Fields {
  readonly sku: string;
  readonly scope: string;
  readonly channel: string;
  readonly order: string;
  readonly amount: string;
  readonly quantity: string;
  readonly from: string;
  readonly until: string;
}
export const optionPriceEmptyFields: Fields = {
  sku: "",
  scope: "Brand",
  channel: "",
  order: "",
  amount: "",
  quantity: "",
  from: "",
  until: "",
};
const messages: Record<string, string> = {
  Loading: "Reading current prices and recovery record…",
  Denied: "You do not have permission to manage these prices.",
  FeatureDisabled: "Option price management is disabled for this Store.",
  Conflict: "The saved price or source changed. Refresh before preparing another operation.",
  Stale:
    "The current observation expired. Refresh to read current authority; your input is retained.",
  ScopeChanged:
    "The active scope changed. Return to the original scope to resolve any pending operation.",
  Invalid: "Check the price fields and explicit UTC dates.",
  Unavailable: "Current price information is unavailable. Refresh explicitly.",
  OutcomeUnknown:
    "The original outcome is unknown. Resolve the retained original before another operation.",
  RecoveryUnavailable:
    "The durable recovery record could not be read. No new operation can be sent.",
  CleanupFailed:
    "The terminal receipt was received, but its durable recovery record could not be cleared. Resolve the same original again.",
  Offline: "You are offline. Your input and original operation are retained.",
};
function errorCode(error: unknown): string {
  if (
    error instanceof OptionPriceAuthoringClientError ||
    error instanceof OptionPriceReviewClientError ||
    error instanceof StoreCapabilityClientError
  )
    return error.code;
  return "Unavailable";
}
function boundary(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new OptionPriceAuthoringClientError("Invalid");
  return { instant: value, localDateTime: value.slice(0, 23), utcOffsetMinutes: 0 };
}
export function optionPriceFormContent(fields: Fields, storeReference: string) {
  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(fields.quantity) ||
    Number(fields.quantity) > 2147483647 ||
    !/^(?:0|[1-9][0-9]*)$/u.test(fields.amount)
  )
    throw new OptionPriceAuthoringClientError("Invalid");
  if (
    fields.amount.length > 19 ||
    (fields.amount.length === 19 && fields.amount > "9223372036854775807")
  )
    throw new OptionPriceAuthoringClientError("Invalid");
  if (!["Brand", "Store"].includes(fields.scope))
    throw new OptionPriceAuthoringClientError("Invalid");
  return {
    skuReference: fields.sku || null,
    scopeKind: fields.scope,
    scopeReference: fields.scope === "Brand" ? null : storeReference,
    channelCode: fields.channel || null,
    orderType: fields.order || null,
    unitAmountMinor: fields.amount,
    includedQuantity: Number(fields.quantity),
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: boundary(fields.from),
      effectiveUntil: fields.until ? boundary(fields.until) : null,
    },
  };
}
/** The journal is durable before transport. A terminal alone never clears a failed cleanup. */
export async function dispatchOptionPriceOriginal(
  journal: OptionPricePendingJournal,
  cursor: OptionPricePendingOriginal,
  dispatch: () => Promise<unknown>,
) {
  await journal.reserve(cursor);
  const result = await dispatch();
  await journal.complete(cursor);
  return result;
}
interface Pending {
  cursor: OptionPricePendingOriginal;
  journal: OptionPricePendingJournal;
}
/** Scope is obtained from the authenticated endpoint, never from a stored cursor. */
export async function discoverOptionPriceOriginals(
  client: Pick<ReturnType<typeof createOptionPriceAuthoringClient>, "scope">,
  input: {
    brandReference: string;
    storeReference: string;
    productReference: string;
    csrf: string;
    signal: AbortSignal;
  },
  discoveryFactory = createOptionPricePendingDiscovery,
  journalFactory = createOptionPricePendingJournal,
) {
  const observation = await client.scope({
    expectedScope: { brandReference: input.brandReference, storeReference: input.storeReference },
    csrf: input.csrf,
    signal: input.signal,
  });
  const scope = {
    tenantReference: observation.tenantReference,
    brandReference: observation.brandReference,
    storeReference: observation.storeReference,
    actorReference: observation.actorReference,
  };
  let records;
  try {
    records = await discoveryFactory({ ...scope, productReference: input.productReference }).load();
  } catch {
    throw new Error("RecoveryUnavailable");
  }
  if (input.signal.aborted) throw new OptionPriceAuthoringClientError("Unavailable");
  if (Date.now() >= Date.parse(observation.validUntil))
    throw new OptionPriceAuthoringClientError("Stale");
  return {
    observation,
    originals: records.map((record): Pending => ({
      cursor: record.original,
      journal: journalFactory({
        ...scope,
        productReference: input.productReference,
        bindingReference: record.bindingReference,
        optionReference: record.optionReference,
      }),
    })),
  };
}
export function OptionPriceRecoveryList({
  originals,
  busy,
  onResolve,
}: {
  readonly originals: readonly Pending[];
  readonly busy: boolean;
  readonly onResolve: (original: Pending) => void;
}) {
  return originals.length === 0 ? null : (
    <div>
      <p role="status">
        Retained original price operations must be resolved before a new write. Selection locators
        may no longer be present in the current Product.
      </p>
      <ul>
        {originals.map((original, i) => (
          <li key={original.cursor.command.operationReference}>
            Original {i + 1}: {original.cursor.command.action}
            <button type="button" disabled={busy} onClick={() => onResolve(original)}>
              Resolve original price operation {i + 1}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
export function ProductOptionPrices({
  entry,
  productReference,
  storeReference,
  csrf,
  client: suppliedClient,
  reviewClient: suppliedReview,
  capabilityClient: suppliedCapability,
  journalFactory = createOptionPricePendingJournal,
  discoveryFactory = createOptionPricePendingDiscovery,
  operationReference = serviceOperationReference,
}: Props) {
  const client = useMemo(
      () => suppliedClient ?? createOptionPriceAuthoringClient(),
      [suppliedClient],
    ),
    reviewClient = useMemo(
      () => suppliedReview ?? createOptionPriceReviewClient(),
      [suppliedReview],
    ),
    capability = useMemo(
      () => suppliedCapability ?? createStoreCapabilityClient(),
      [suppliedCapability],
    );
  const [bindingId, setBindingId] = useState(""),
    [optionId, setOptionId] = useState(""),
    [ruleId, setRuleId] = useState(""),
    [view, setView] = useState<OptionPriceAuthoringQuery | null>(null),
    [review, setReview] = useState<OptionPriceReviewCurrent | null>(null),
    [fields, setFields] = useState<Fields>(optionPriceEmptyFields),
    [validationUntil, setValidationUntil] = useState(""),
    [approvalUntil, setApprovalUntil] = useState(""),
    [pending, setPending] = useState<Pending | null>(null),
    [discovered, setDiscovered] = useState<readonly Pending[]>([]),
    [journalReady, setJournalReady] = useState(false),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [clock, setClock] = useState(Date.now());
  const journal = useRef<OptionPricePendingJournal | null>(null),
    active = useRef<AbortController | null>(null),
    epoch = useRef(0),
    prefix = useId();
  const bindings = entry?.draft.optionBindings ?? [],
    binding = bindings.find((b) => b.bindingReference === bindingId),
    currentRule = view?.states.find((s) => s.ruleReference === ruleId) ?? null;
  const context = useMemo(
    () => ({
      productReference,
      expectedProductAggregateVersion: entry?.revision ?? 0,
      bindingReference: bindingId,
      optionReference: optionId,
    }),
    [productReference, entry?.revision, bindingId, optionId],
  );
  const key = JSON.stringify([context, storeReference, csrf]);
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 250);
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        active.current?.abort();
        setStatus("Stale");
      }
    };
    const offline = () => {
        active.current?.abort();
        setStatus("Offline");
      },
      online = () => {
        setStatus("Stale");
      };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);
  useEffect(() => {
    const token = ++epoch.current,
      controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setView(null);
    setReview(null);
    setJournalReady(false);
    setDiscovered([]);
    journal.current = null;
    setStatus("Loading");
    setBusy(true);
    void (async () => {
      const gate = await capability.load(
        { scope: { storeReference }, capabilityKey: "pricing.price_book_editor", csrf },
        controller.signal,
      );
      if (gate.backendExecution !== "Allow")
        throw new OptionPriceAuthoringClientError("FeatureDisabled");
      const recovery = await discoverOptionPriceOriginals(
        client,
        {
          brandReference: gate.brandReference,
          storeReference,
          productReference,
          csrf,
          signal: controller.signal,
        },
        discoveryFactory,
        journalFactory,
      );
      if (epoch.current !== token || controller.signal.aborted) return;
      setDiscovered(recovery.originals);
      setJournalReady(true);
      setStatus("");
      // Discovery precedes any current Product/Binding/policy read. Original
      // resolution remains usable when today's semantic context was removed.
      if (
        recovery.originals.length > 0 ||
        !entry ||
        !binding ||
        !binding.enabledOptionReferences.includes(optionId)
      )
        return;
      const observation = recovery.observation;
      const scope = {
        tenantReference: observation.tenantReference,
        brandReference: observation.brandReference,
        storeReference: observation.storeReference,
        actorReference: observation.actorReference,
      };
      const result = await client.query({
        context,
        expectedScope: scope,
        csrf,
        signal: controller.signal,
      });
      if (epoch.current !== token || controller.signal.aborted) return;
      journal.current = journalFactory({
        ...scope,
        productReference,
        bindingReference: bindingId,
        optionReference: optionId,
      });
      setView(result);
      setStatus("");
    })()
      .catch((error: unknown) => {
        if (epoch.current === token && !controller.signal.aborted)
          setStatus(
            error instanceof Error && error.message === "RecoveryUnavailable"
              ? "RecoveryUnavailable"
              : errorCode(error),
          );
      })
      .finally(() => {
        if (epoch.current === token) setBusy(false);
      });
    return () => {
      ++epoch.current;
      controller.abort();
    };
  }, [
    key,
    refresh,
    client,
    capability,
    journalFactory,
    discoveryFactory,
    entry,
    binding,
    context,
    storeReference,
    csrf,
    productReference,
    bindingId,
    optionId,
  ]);
  useEffect(() => {
    setReview(null);
    if (!view || !currentRule?.draft) return;
    const token = epoch.current,
      controller = new AbortController();
    const scope = {
      tenantReference: view.tenantReference,
      brandReference: view.brandReference,
      storeReference: view.storeReference,
      actorReference: view.actorReference,
    };
    void reviewClient
      .query({
        context,
        ruleReference: currentRule.ruleReference,
        expectedScope: scope,
        csrf,
        signal: controller.signal,
      })
      .then((result) => {
        if (epoch.current !== token || controller.signal.aborted) return;
        if (
          result.aggregateVersion !== currentRule.aggregateVersion ||
          result.draftVersionReference !== currentRule.draft?.versionReference ||
          result.draftSnapshotDigest !== currentRule.draft?.snapshotDigest
        )
          throw new OptionPriceAuthoringClientError("Conflict");
        setReview(result);
      })
      .catch((error: unknown) => {
        if (epoch.current === token && !controller.signal.aborted) setStatus(errorCode(error));
      });
    return () => controller.abort();
  }, [view, currentRule, context, reviewClient, csrf]);
  const originals =
    discovered.some(
      (original) =>
        original.cursor.command.operationReference === pending?.cursor.command.operationReference,
    ) || pending === null
      ? discovered
      : [...discovered, pending];
  const hasOriginals = originals.length > 0;
  const stale = !view || clock >= Date.parse(view.validUntil),
    locked = busy || hasOriginals || !journalReady || stale || status !== "";
  function chooseRule(value: string) {
    setRuleId(value);
    setReview(null);
    const selected = view?.states.find((s) => s.ruleReference === value);
    const snapshot = selected?.draft ?? selected?.currentPublished;
    setFields(
      snapshot
        ? {
            sku: snapshot.skuReference ?? "",
            scope: snapshot.scopeKind,
            channel: snapshot.channelCode ?? "",
            order: snapshot.orderType ?? "",
            amount: snapshot.unitAmount.amountMinor,
            quantity: String(snapshot.includedQuantity),
            from: snapshot.effectivePeriod.effectiveFrom.instant,
            until: snapshot.effectivePeriod.effectiveUntil?.instant ?? "",
          }
        : optionPriceEmptyFields,
    );
  }
  async function send(
    action: "CreateDraft" | "ReplaceDraft" | "Publish" | "Archive" | "SubmitReview" | "Approve",
  ) {
    if (locked || !view || !journal.current) return;
    const controller = new AbortController(),
      token = epoch.current;
    active.current = controller;
    setBusy(true);
    setStatus("");
    let original: Pending | null = null,
      terminal = false;
    try {
      const scope = {
        tenantReference: view.tenantReference,
        brandReference: view.brandReference,
        storeReference: view.storeReference,
        actorReference: view.actorReference,
      };
      // Long-lived form input never renews observation or silently changes the recorded CAS.
      const fresh = await client.query({
        context,
        expectedScope: scope,
        csrf,
        signal: controller.signal,
      });
      const { observedAt: _freshAt, validUntil: _freshUntil, ...freshContext } = fresh.context;
      const { observedAt: _oldAt, validUntil: _oldUntil, ...oldContext } = view.context;
      void _freshAt;
      void _freshUntil;
      void _oldAt;
      void _oldUntil;
      if (
        canonicalPublicationValue(freshContext) !== canonicalPublicationValue(oldContext) ||
        canonicalPublicationValue(fresh.states) !== canonicalPublicationValue(view.states)
      )
        throw new OptionPriceAuthoringClientError("Conflict");
      if (epoch.current !== token || controller.signal.aborted)
        throw new OptionPriceAuthoringClientError("ScopeChanged");
      const isReview = action === "SubmitReview" || action === "Approve";
      let prepared: ReturnType<typeof client.prepare> | ReturnType<typeof reviewClient.prepare>;
      if (isReview) {
        if (!currentRule?.draft || !review) throw new OptionPriceAuthoringClientError("Stale");
        const freshReview = await reviewClient.query({
          context,
          ruleReference: currentRule.ruleReference,
          expectedScope: scope,
          csrf,
          signal: controller.signal,
        });
        if (
          freshReview.aggregateVersion !== currentRule.aggregateVersion ||
          freshReview.draftVersionReference !== currentRule.draft.versionReference ||
          freshReview.draftSnapshotDigest !== currentRule.draft.snapshotDigest
        )
          throw new OptionPriceAuthoringClientError("Conflict");
        if (
          canonicalPublicationValue(freshReview.review) !==
            canonicalPublicationValue(review.review) ||
          canonicalPublicationValue(freshReview.policy) !== canonicalPublicationValue(review.policy)
        )
          throw new OptionPriceAuthoringClientError("Conflict");
        const expectedLifecycle =
          freshReview.review.outcome === "Absent" ? null : freshReview.review.lifecycle;
        prepared = reviewClient.prepare({
          expectedScope: scope,
          context,
          command: {
            action,
            operationReference: operationReference(),
            ruleReference: currentRule.ruleReference,
            draftVersionReference: currentRule.draft.versionReference,
            draftSnapshotDigest: currentRule.draft.snapshotDigest,
            expectedAggregateVersion: currentRule.aggregateVersion,
            validationValidUntil:
              action === "Approve" && freshReview.review.outcome === "Recorded"
                ? freshReview.review.validationValidUntil
                : validationUntil,
            approvalValidUntil: action === "Approve" ? approvalUntil : null,
            expectedLifecycle,
          },
        });
        original = {
          journal: journal.current,
          cursor: {
            profile: "OptionPricePendingOriginalV1",
            kind: "Review",
            scope: prepared.scope,
            context: prepared.context,
            command: prepared.command,
          },
        };
      } else {
        prepared = client.prepare({
          expectedScope: scope,
          context: { productReference, expectedProductAggregateVersion: entry?.revision },
          command: {
            action,
            operationReference: operationReference(),
            ruleReference:
              action === "CreateDraft" && !currentRule
                ? operationReference()
                : currentRule?.ruleReference,
            expectedAggregateVersion:
              action === "CreateDraft" && !currentRule ? null : currentRule?.aggregateVersion,
            bindingReference: action === "CreateDraft" ? bindingId : null,
            optionReference: action === "CreateDraft" ? optionId : null,
            content:
              action === "CreateDraft" || action === "ReplaceDraft"
                ? optionPriceFormContent(fields, storeReference)
                : null,
          },
        });
        original = {
          journal: journal.current,
          cursor: {
            profile: "OptionPricePendingOriginalV1",
            kind: "Authoring",
            scope: prepared.scope,
            context: prepared.context,
            command: prepared.command,
          },
        };
      }
      if (epoch.current !== token || controller.signal.aborted)
        throw new OptionPriceAuthoringClientError("ScopeChanged");
      const saved = original;
      await dispatchOptionPriceOriginal(saved.journal, saved.cursor, async () => {
        setPending(saved);
        if (epoch.current !== token || controller.signal.aborted)
          throw new OptionPriceAuthoringClientError("ScopeChanged");
        await prepared.execute({ csrf, scope, signal: controller.signal });
        terminal = true;
      });
      if (epoch.current === token) {
        setPending(null);
        setRuleId(saved.cursor.command.ruleReference);
        setStatus("Recorded");
        setRefresh((n) => n + 1);
      }
    } catch (error) {
      if (epoch.current === token) {
        setStatus(terminal ? "CleanupFailed" : errorCode(error));
        if (original) setPending(original);
      }
    } finally {
      if (epoch.current === token) setBusy(false);
    }
  }
  async function resolve(selected: Pending) {
    if (busy || !navigator.onLine) return;
    const scope = selected.cursor.scope;
    if (
      scope.storeReference !== storeReference ||
      selected.cursor.context.productReference !== productReference
    ) {
      setStatus("ScopeChanged");
      return;
    }
    const original = selected,
      controller = new AbortController(),
      token = epoch.current;
    active.current = controller;
    setBusy(true);
    let terminal = false;
    try {
      await client.scope({ expectedScope: scope, csrf, signal: controller.signal });
      if (epoch.current !== token || controller.signal.aborted)
        throw new OptionPriceAuthoringClientError("ScopeChanged");
      const prepared =
        original.cursor.kind === "Authoring"
          ? client.prepare({
              command: original.cursor.command,
              context: original.cursor.context,
              expectedScope: original.cursor.scope,
            })
          : reviewClient.prepare({
              command: original.cursor.command,
              context: original.cursor.context,
              expectedScope: original.cursor.scope,
            });
      await prepared.resolve({ csrf, scope, signal: controller.signal });
      terminal = true;
      await original.journal.complete(original.cursor);
      if (epoch.current === token) {
        setPending(null);
        setDiscovered((previous) =>
          previous.filter(
            (item) =>
              item.cursor.command.operationReference !== original.cursor.command.operationReference,
          ),
        );
        setStatus("Recorded");
        setRuleId(original.cursor.command.ruleReference);
        setRefresh((n) => n + 1);
      }
    } catch (error) {
      if (epoch.current === token) setStatus(terminal ? "CleanupFailed" : errorCode(error));
    } finally {
      if (epoch.current === token) setBusy(false);
    }
  }
  const patch = (field: keyof Fields, value: string) =>
    setFields((previous) => ({ ...previous, [field]: value }));
  const unsupported =
      !["Brand", "Store"].includes(fields.scope) ||
      (currentRule?.draft?.scopeKind === "Store" &&
        currentRule.draft.scopeReference !== storeReference),
    reviewState = review?.review.outcome === "Recorded" ? review.review.lifecycle.state : null;
  return (
    <section aria-labelledby={`${prefix}-title`} className="space-y-4">
      <h2 id={`${prefix}-title`}>Option choice prices</h2>
      <p>
        Manage prices for saved Product bindings. Price changes do not change the Product revision.
        Published prices remain in effect while a separate Draft is edited.
      </p>
      {!entry ? (
        <p role="status">Read the saved Product before managing option prices.</p>
      ) : (
        <>
          <label>
            Saved binding
            <select
              aria-label="Saved price binding"
              value={bindingId}
              disabled={busy || hasOriginals}
              onChange={(e) => {
                setBindingId(e.target.value);
                setOptionId("");
                setRuleId("");
              }}
            >
              <option value="">Choose a saved binding</option>
              {bindings.map((b, i) => (
                <option key={b.bindingReference} value={b.bindingReference}>
                  Binding {i + 1} · {b.purpose}
                </option>
              ))}
            </select>
          </label>
          <label>
            Enabled option choice
            <select
              aria-label="Saved price option choice"
              value={optionId}
              disabled={!binding || busy || hasOriginals}
              onChange={(e) => {
                setOptionId(e.target.value);
                setRuleId("");
              }}
            >
              <option value="">Choose an enabled choice</option>
              {binding?.enabledOptionReferences.map((id, i) => (
                <option key={id} value={id}>
                  {view
                    ? (view.context.choices.find((c) => c.optionReference === id)?.localizedNames[
                        view.context.defaultLocale
                      ] ?? `Choice ${i + 1}`)
                    : `Choice ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
            Refresh current option prices
          </button>
          {view && (
            <>
              <p>
                Currency: {view.context.currencyMetadata.currencyCode}. Source eligibility: Not
                evaluated.
              </p>
              <label>
                Price rule
                <select
                  aria-label="Current option price rule"
                  value={ruleId}
                  disabled={busy || hasOriginals}
                  onChange={(e) => chooseRule(e.target.value)}
                >
                  <option value="">New price rule</option>
                  {view.states.map((s, i) => (
                    <option key={s.ruleReference} value={s.ruleReference}>
                      Rule {i + 1} · revision {s.aggregateVersion} · {s.latestVersion.lifecycle}
                    </option>
                  ))}
                </select>
              </label>
              {currentRule?.currentPublished && (
                <p>
                  Current Published: {currentRule.currentPublished.unitAmount.amountMinor} minor
                  units; included quantity {currentRule.currentPublished.includedQuantity}.
                  Effective from{" "}
                  {currentRule.currentPublished.effectivePeriod.effectiveFrom.instant}.
                </p>
              )}
              {currentRule && (
                <p>
                  Current Draft:{" "}
                  {currentRule.draft
                    ? `${currentRule.draft.unitAmount.amountMinor} minor units`
                    : "No Draft"}
                  .
                </p>
              )}
              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void send(currentRule?.draft ? "ReplaceDraft" : "CreateDraft");
                }}
              >
                <fieldset disabled={busy || hasOriginals || unsupported}>
                  <legend>
                    {currentRule ? "Edit a separate price Draft" : "Create a price Draft"}
                  </legend>
                  <label>
                    SKU applicability
                    <select
                      aria-label="Price SKU applicability"
                      value={fields.sku}
                      onChange={(e) => patch("sku", e.target.value)}
                    >
                      <option value="">All applicable SKUs</option>
                      {view.context.skus.map((s) => (
                        <option key={s.skuReference} value={s.skuReference}>
                          {s.localizedNames[view.context.defaultLocale] ?? s.skuCode} ·{" "}
                          {s.lifecycle}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Price scope
                    <select
                      aria-label="Price scope"
                      value={fields.scope}
                      onChange={(e) => patch("scope", e.target.value)}
                    >
                      <option value="Brand">Brand</option>
                      <option value="Store">Selected Store</option>
                      {unsupported && (
                        <option value={fields.scope}>
                          {fields.scope} · existing scope (read only)
                        </option>
                      )}
                    </select>
                  </label>
                  <label>
                    Channel code (blank for any)
                    <input
                      value={fields.channel}
                      onChange={(e) => patch("channel", e.target.value)}
                    />
                  </label>
                  <label>
                    Order type
                    <select
                      aria-label="Price order type"
                      value={fields.order}
                      onChange={(e) => patch("order", e.target.value)}
                    >
                      <option value="">Any order type</option>
                      <option value="DineIn">Dine in</option>
                      <option value="Pickup">Pickup</option>
                    </select>
                  </label>
                  <p id={`${prefix}-integer`}>
                    Minor amount is a nonnegative integer string, maximum 9223372036854775807.
                    Included quantity is an integer from 0 to 2147483647.
                  </p>
                  <label>
                    Unit amount in minor units
                    <input
                      inputMode="numeric"
                      aria-describedby={`${prefix}-integer`}
                      value={fields.amount}
                      onChange={(e) => patch("amount", e.target.value)}
                    />
                  </label>
                  <label>
                    Included quantity
                    <input
                      inputMode="numeric"
                      aria-describedby={`${prefix}-integer`}
                      value={fields.quantity}
                      onChange={(e) => patch("quantity", e.target.value)}
                    />
                  </label>
                  <p id={`${prefix}-utc`}>
                    Explicit UTC timestamps: YYYY-MM-DDTHH:mm:ss.sssZ. This chooses UTC, not the
                    Store time zone. Blank end means no end.
                  </p>
                  <label>
                    Effective from UTC
                    <input
                      aria-describedby={`${prefix}-utc`}
                      value={fields.from}
                      onChange={(e) => patch("from", e.target.value)}
                    />
                  </label>
                  <label>
                    Effective until UTC (optional)
                    <input
                      aria-describedby={`${prefix}-utc`}
                      value={fields.until}
                      onChange={(e) => patch("until", e.target.value)}
                    />
                  </label>
                  <button type="submit" disabled={locked}>
                    {currentRule?.draft ? "Save price Draft" : "Create price Draft"}
                  </button>
                </fieldset>
              </form>
              {unsupported && (
                <p role="status">
                  This existing scope is preserved. It cannot be edited here; no scope conversion
                  will be made.
                </p>
              )}
              {review && (
                <>
                  <p>
                    Actual policy: {review.policy.approvalPolicy}. Review:{" "}
                    {review.review.outcome === "Absent"
                      ? "No recorded review"
                      : review.review.lifecycle.state}
                    . Historical review is not current qualification.
                  </p>
                  <p>
                    Recorded validation expires:{" "}
                    {review.review.outcome === "Recorded"
                      ? (review.review.validationValidUntil ?? "Not recorded")
                      : "Not recorded"}
                    . Approval expires:{" "}
                    {review.review.outcome === "Recorded"
                      ? (review.review.approvalValidUntil ?? "Not recorded")
                      : "Not recorded"}
                    .
                  </p>
                  <label>
                    Validation valid until UTC
                    <input
                      value={validationUntil}
                      aria-describedby={`${prefix}-utc`}
                      onChange={(e) => setValidationUntil(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={
                      locked ||
                      !currentRule?.draft ||
                      (reviewState !== null && reviewState !== "Draft")
                    }
                    onClick={() => void send("SubmitReview")}
                  >
                    Submit price review
                  </button>
                  <p>
                    Approval must come from a different Actor than the Draft author and original
                    submitter.
                  </p>
                  <label>
                    Approval valid until UTC
                    <input
                      value={approvalUntil}
                      aria-describedby={`${prefix}-utc`}
                      onChange={(e) => setApprovalUntil(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={
                      locked ||
                      reviewState !== "InReview" ||
                      review.draftAuthorActorReference === review.actorReference ||
                      (review.review.outcome === "Recorded" &&
                        review.review.submittedActorReference === review.actorReference)
                    }
                    onClick={() => void send("Approve")}
                  >
                    Approve price Draft
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={
                  locked ||
                  !currentRule?.draft ||
                  !review ||
                  (review.policy.approvalPolicy === "Required" && reviewState !== "Approved")
                }
                onClick={() => void send("Publish")}
              >
                Publish price Draft
              </button>
              <button
                type="button"
                disabled={
                  locked || !currentRule || currentRule.latestVersion.lifecycle === "Archived"
                }
                onClick={() => void send("Archive")}
              >
                Archive price rule and withdraw Published price
              </button>
              {stale && <p role="status">{messages.Stale}</p>}
            </>
          )}
        </>
      )}
      <OptionPriceRecoveryList
        originals={originals}
        busy={busy}
        onResolve={(original) => void resolve(original)}
      />
      {status && (
        <p role={status === "Recorded" || status === "Loading" ? "status" : "alert"}>
          {status === "Recorded"
            ? "The original terminal was recorded. Reading current state…"
            : (messages[status] ?? messages.Unavailable)}
        </p>
      )}
    </section>
  );
}
