import { useEffect, useMemo, useRef, useState } from "react";
import { StoreSetupClientError, type StoreSetupScope } from "./store-setup-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createReceiptTemplateArtifactClient,
  receiptTemplateArtifactRequiredFields,
  type ReceiptTemplateArtifactsCurrent,
} from "./receipt-template-artifact-client.js";
import {
  createReceiptTemplateDraftClient,
  parseReceiptTemplateDraftFields,
  type ReceiptTemplateDraftFields,
  type ReceiptTemplateDraftCurrent,
  type ReceiptTemplateDraftCursor,
  type PreparedReceiptTemplateDraft,
  type ReceiptTemplateDraftRoster,
} from "./receipt-template-draft-client.js";
import {
  createReceiptTemplateDraftPendingJournal,
  type ReceiptTemplateDraftPendingJournal,
} from "./receipt-template-draft-pending-journal.js";
import {
  createReceiptTemplateSubmitClient,
  type ReceiptTemplateSubmitCursor,
  type PreparedReceiptTemplateSubmit,
  type ReceiptTemplateReviewCurrent,
} from "./receipt-template-submit-client.js";
import {
  createReceiptTemplateSubmitPendingJournal,
  type ReceiptTemplateSubmitPendingJournal,
} from "./receipt-template-submit-pending-journal.js";
import {
  createReceiptTemplateLifecycleClient,
  type ReceiptTemplateLifecycleCursor,
  type PreparedReceiptTemplateLifecycle,
  type ReceiptTemplatePublishedVersion,
} from "./receipt-template-lifecycle-client.js";
import {
  createReceiptTemplateLifecyclePendingJournal,
  type ReceiptTemplateLifecyclePendingJournal,
} from "./receipt-template-lifecycle-pending-journal.js";
type LifecycleClient = ReturnType<typeof createReceiptTemplateLifecycleClient>;
type SubmitClient = ReturnType<typeof createReceiptTemplateSubmitClient>;
type Client = ReturnType<typeof createReceiptTemplateDraftClient>;
interface Operation {
  client: Client;
  journal: ReceiptTemplateDraftPendingJournal;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  beforeComplete?: (current: ReceiptTemplateDraftCurrent) => Promise<void>;
}
const check = (input: Operation) => {
  if (input.signal.aborted || !input.isCurrent()) throw new StoreSetupClientError("ScopeChanged");
};
export async function finishReceiptTemplateDraftOriginal(
  input: Operation & {
    cursor: ReceiptTemplateDraftCursor;
    prepared?: PreparedReceiptTemplateDraft;
  },
) {
  check(input);
  if (input.prepared && canonical(input.prepared.cursor) !== canonical(input.cursor))
    throw new StoreSetupClientError("Conflict");
  const receipt = input.prepared
    ? await input.client.execute(input.prepared, { csrf: input.csrf, signal: input.signal })
    : await input.client.resolve(input.cursor, { csrf: input.csrf, signal: input.signal });
  check(input);
  const current = await input.client.load({
    storeReference: input.cursor.scope.storeReference,
    expectedScope: input.cursor.scope,
    templateReference:
      receipt.snapshot?.content.templateReference ?? input.cursor.templateReference,
    signal: input.signal,
  });
  check(input);
  await input.beforeComplete?.(current);
  check(input);
  await input.journal.complete(input.cursor, receipt, current);
  check(input);
  return { receipt, current };
}
export async function saveReceiptTemplateDraft(
  input: Operation & {
    scope: StoreSetupScope;
    baseline: ReceiptTemplateDraftCurrent;
    fields: ReceiptTemplateDraftFields;
    onReserved: (p: PreparedReceiptTemplateDraft) => void;
  },
) {
  check(input);
  const fresh = await input.client.load({
    storeReference: input.scope.storeReference,
    expectedScope: input.scope,
    templateReference: input.baseline.templateReference,
    signal: input.signal,
  });
  check(input);
  if (
    fresh.snapshot?.revision !== input.baseline.snapshot?.revision ||
    fresh.snapshot?.content.versionReference !== input.baseline.snapshot?.content.versionReference
  )
    throw new StoreSetupClientError("Conflict");
  const prepared = await input.client.prepare({
    expectedScope: input.scope,
    templateReference: fresh.templateReference,
    expectedVersionReference: fresh.snapshot?.content.versionReference ?? null,
    expectedRevision: fresh.snapshot?.revision ?? 0,
    operationReference: serviceOperationReference(),
    fields: input.fields,
  });
  check(input);
  await input.journal.reserve(prepared.cursor);
  input.onReserved(prepared);
  check(input);
  return finishReceiptTemplateDraftOriginal({ ...input, cursor: prepared.cursor, prepared });
}
interface SubmitOperation {
  submitClient: SubmitClient;
  client: Client;
  journal: ReceiptTemplateSubmitPendingJournal;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
const submitCheck = (input: SubmitOperation) => {
  if (input.signal.aborted || !input.isCurrent()) throw new StoreSetupClientError("ScopeChanged");
};
const savedFields = (view: ReceiptTemplateDraftCurrent) => {
  const c = view.snapshot?.content;
  if (!c) throw new StoreSetupClientError("Conflict");
  return parseReceiptTemplateDraftFields({
    locale: c.locale,
    layoutDefinitionReference: c.layoutDefinitionReference,
    complianceRuleReference: c.complianceRuleReference,
    activation: c.activation,
    effectiveUntil: c.effectiveUntil,
  });
};
export async function finishReceiptTemplateSubmitOriginal(
  input: SubmitOperation & {
    cursor: ReceiptTemplateSubmitCursor;
    prepared?: PreparedReceiptTemplateSubmit;
  },
) {
  submitCheck(input);
  if (input.prepared && canonical(input.prepared.cursor) !== canonical(input.cursor))
    throw new StoreSetupClientError("Conflict");
  const receipt = input.prepared
    ? await input.submitClient.execute(input.prepared, { csrf: input.csrf, signal: input.signal })
    : await input.submitClient.resolve(input.cursor, { csrf: input.csrf, signal: input.signal });
  submitCheck(input);
  const current = await input.client.load({
    storeReference: input.cursor.scope.storeReference,
    templateReference: input.cursor.templateReference,
    expectedScope: input.cursor.scope,
    signal: input.signal,
  });
  submitCheck(input);
  const review = await input.submitClient.load({
    storeReference: input.cursor.scope.storeReference,
    templateReference: input.cursor.templateReference,
    expectedScope: input.cursor.scope,
    csrf: input.csrf,
    signal: input.signal,
  });
  submitCheck(input);
  if (
    !current.snapshot ||
    current.snapshot.content.versionReference !== review.currentDraft.versionReference ||
    current.snapshot.revision !== review.currentDraft.revision ||
    current.snapshot.contentDigest !== review.currentDraft.contentDigest
  )
    throw new StoreSetupClientError("Conflict");
  await input.journal.complete(input.cursor, receipt, review);
  submitCheck(input);
  return { receipt, current, review };
}
export async function submitReceiptTemplateDraft(
  input: SubmitOperation & {
    scope: StoreSetupScope;
    baseline: ReceiptTemplateDraftCurrent;
    fields: ReceiptTemplateDraftFields;
    onReserved: (prepared: PreparedReceiptTemplateSubmit) => void;
  },
) {
  submitCheck(input);
  if (canonical(input.fields) !== canonical(savedFields(input.baseline)))
    throw new StoreSetupClientError("Conflict");
  const current = await input.client.load({
    storeReference: input.scope.storeReference,
    templateReference: input.baseline.templateReference,
    expectedScope: input.scope,
    signal: input.signal,
  });
  submitCheck(input);
  if (
    !current.snapshot ||
    !input.baseline.snapshot ||
    current.snapshot.revision !== input.baseline.snapshot.revision ||
    current.snapshot.content.versionReference !==
      input.baseline.snapshot.content.versionReference ||
    current.snapshot.contentDigest !== input.baseline.snapshot.contentDigest
  )
    throw new StoreSetupClientError("Conflict");
  const review = await input.submitClient.load({
    storeReference: input.scope.storeReference,
    templateReference: current.snapshot.content.templateReference,
    expectedScope: input.scope,
    csrf: input.csrf,
    signal: input.signal,
  });
  submitCheck(input);
  if (
    review.currentDraft.versionReference !== current.snapshot.content.versionReference ||
    review.currentDraft.revision !== current.snapshot.revision ||
    review.currentDraft.contentDigest !== current.snapshot.contentDigest
  )
    throw new StoreSetupClientError("Conflict");
  if (
    review.submission &&
    (review.submission.versionReference === current.snapshot.content.versionReference ||
      ((review.lifecycle?.state === "InReview" || review.lifecycle?.state === "Approved") &&
        Date.parse(review.submission.validationValidUntil) > Date.now()))
  )
    throw new StoreSetupClientError("Conflict");
  const prepared = await input.submitClient.prepare({
    expectedScope: input.scope,
    operationReference: serviceOperationReference(),
    templateReference: current.snapshot.content.templateReference,
    expectedVersionReference: current.snapshot.content.versionReference,
    expectedRevision: current.snapshot.revision,
  });
  submitCheck(input);
  await input.journal.reserve(prepared.cursor);
  input.onReserved(prepared);
  submitCheck(input);
  return finishReceiptTemplateSubmitOriginal({ ...input, cursor: prepared.cursor, prepared });
}
interface LifecycleOperation {
  client: Client;
  submitClient: SubmitClient;
  lifecycleClient: LifecycleClient;
  journal: ReceiptTemplateLifecyclePendingJournal;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}
const lifecycleCheck = (input: LifecycleOperation) => {
  if (input.signal.aborted || !input.isCurrent()) throw new StoreSetupClientError("ScopeChanged");
};
export function receiptTemplateLifecycleAvailable(
  scope: StoreSetupScope,
  current: ReceiptTemplateDraftCurrent,
  review: ReceiptTemplateReviewCurrent,
  action: "Approve" | "Publish",
  now: number,
) {
  const snapshot = current.snapshot,
    submission = review.submission,
    lifecycle = review.lifecycle;
  return Boolean(
    snapshot &&
    submission &&
    lifecycle &&
    snapshot.content.versionReference === submission.versionReference &&
    snapshot.revision === submission.draftRevision &&
    snapshot.contentDigest === submission.contentDigest &&
    review.currentDraft.versionReference === snapshot.content.versionReference &&
    review.currentDraft.revision === snapshot.revision &&
    review.currentDraft.contentDigest === snapshot.contentDigest &&
    Date.parse(submission.validationValidUntil) > now &&
    (action === "Approve"
      ? lifecycle.state === "InReview" &&
        scope.actorReference !== submission.authoredByReference &&
        scope.actorReference !== submission.submittedByReference
      : lifecycle.state === "Approved"),
  );
}
export async function finishReceiptTemplateLifecycleOriginal(
  input: LifecycleOperation & {
    cursor: ReceiptTemplateLifecycleCursor;
    prepared?: PreparedReceiptTemplateLifecycle;
  },
) {
  lifecycleCheck(input);
  if (input.prepared && canonical(input.prepared.cursor) !== canonical(input.cursor))
    throw new StoreSetupClientError("Conflict");
  const receipt = input.prepared
    ? await input.lifecycleClient.execute(input.prepared, {
        csrf: input.csrf,
        signal: input.signal,
      })
    : await input.lifecycleClient.resolve(input.cursor, { csrf: input.csrf, signal: input.signal });
  lifecycleCheck(input);
  const current = await input.client.load({
    storeReference: input.cursor.scope.storeReference,
    templateReference: input.cursor.templateReference,
    expectedScope: input.cursor.scope,
    signal: input.signal,
  });
  lifecycleCheck(input);
  const review = await input.submitClient.load({
    storeReference: input.cursor.scope.storeReference,
    templateReference: input.cursor.templateReference,
    expectedScope: input.cursor.scope,
    csrf: input.csrf,
    signal: input.signal,
  });
  lifecycleCheck(input);
  if (
    !current.snapshot ||
    current.snapshot.content.versionReference !== review.currentDraft.versionReference ||
    current.snapshot.revision !== review.currentDraft.revision ||
    current.snapshot.contentDigest !== review.currentDraft.contentDigest
  )
    throw new StoreSetupClientError("Conflict");
  const completion = await input.journal.complete(input.cursor, receipt, review, null);
  lifecycleCheck(input);
  return { receipt, current, review, historical: completion.historical };
}
export async function advanceReceiptTemplateLifecycle(
  input: LifecycleOperation & {
    scope: StoreSetupScope;
    baseline: ReceiptTemplateDraftCurrent;
    review: ReceiptTemplateReviewCurrent;
    fields: ReceiptTemplateDraftFields;
    action: "Approve" | "Publish";
    onReserved: (prepared: PreparedReceiptTemplateLifecycle) => void;
  },
) {
  lifecycleCheck(input);
  if (canonical(input.fields) !== canonical(savedFields(input.baseline)))
    throw new StoreSetupClientError("Conflict");
  const subject = input.baseline.snapshot?.content.templateReference;
  if (!subject) throw new StoreSetupClientError("Conflict");
  const current = await input.client.load({
    storeReference: input.scope.storeReference,
    templateReference: subject,
    expectedScope: input.scope,
    signal: input.signal,
  });
  lifecycleCheck(input);
  const review = await input.submitClient.load({
    storeReference: input.scope.storeReference,
    templateReference: subject,
    expectedScope: input.scope,
    csrf: input.csrf,
    signal: input.signal,
  });
  lifecycleCheck(input);
  if (
    !receiptTemplateLifecycleAvailable(input.scope, current, review, input.action, Date.now()) ||
    canonical(review.currentDraft) !== canonical(input.review.currentDraft) ||
    canonical(review.lifecycle) !== canonical(input.review.lifecycle) ||
    canonical(current.snapshot) !== canonical(input.baseline.snapshot) ||
    !review.lifecycle ||
    !current.snapshot
  )
    throw new StoreSetupClientError("Conflict");
  const prepared = await input.lifecycleClient.prepare({
    expectedScope: input.scope,
    action: input.action,
    operationReference: serviceOperationReference(),
    templateReference: current.snapshot.content.templateReference,
    expectedVersionReference: current.snapshot.content.versionReference,
    expectedRevision: current.snapshot.revision,
    reviewLifecycleReference: review.lifecycle.lifecycleReference,
    expectedReviewVersion: review.lifecycle.version,
    expectedReviewOperationReference: review.lifecycle.latestMutationOperationReference,
  });
  lifecycleCheck(input);
  await input.journal.reserve(prepared.cursor);
  input.onReserved(prepared);
  lifecycleCheck(input);
  return finishReceiptTemplateLifecycleOriginal({ ...input, cursor: prepared.cursor, prepared });
}
export interface ReceiptTemplateDraftEditorProps {
  readonly scope: StoreSetupScope;
  readonly csrf: string;
  readonly defaultLocale: string;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly client?: Client;
  readonly rosterClient?: Client;
  readonly artifactClient?: ReturnType<typeof createReceiptTemplateArtifactClient>;
  readonly journalFactory?: typeof createReceiptTemplateDraftPendingJournal;
  readonly lifecycleClient?: LifecycleClient;
  readonly lifecycleJournalFactory?: typeof createReceiptTemplateLifecyclePendingJournal;
  readonly submitClient?: SubmitClient;
  readonly submitJournalFactory?: typeof createReceiptTemplateSubmitPendingJournal;
}
/** Authoring and mechanical preview only. A Draft is never a Published Store template. */
export function ReceiptTemplateDraftEditor({
  scope,
  csrf,
  defaultLocale,
  hidden,
  disabled = false,
  client: injected,
  rosterClient: injectedRoster,
  artifactClient: injectedArtifacts,
  journalFactory = createReceiptTemplateDraftPendingJournal,
  lifecycleClient: injectedLifecycle,
  lifecycleJournalFactory = createReceiptTemplateLifecyclePendingJournal,
  submitClient: injectedSubmit,
  submitJournalFactory = createReceiptTemplateSubmitPendingJournal,
}: ReceiptTemplateDraftEditorProps) {
  const lifecycleClient = useMemo(
    () => injectedLifecycle ?? createReceiptTemplateLifecycleClient(),
    [injectedLifecycle],
  );
  const submitClient = useMemo(
    () => injectedSubmit ?? createReceiptTemplateSubmitClient(),
    [injectedSubmit],
  );
  const client = useMemo(() => injected ?? createReceiptTemplateDraftClient(), [injected]),
    rosterClient = useMemo(
      () => injectedRoster ?? createReceiptTemplateDraftClient(),
      [injectedRoster],
    ),
    artifactClient = useMemo(
      () => injectedArtifacts ?? createReceiptTemplateArtifactClient(),
      [injectedArtifacts],
    );
  const [subject, setSubject] = useState<string | null>(null),
    [view, setView] = useState<ReceiptTemplateDraftCurrent | null>(null),
    [roster, setRoster] = useState<ReceiptTemplateDraftRoster | null>(null),
    [artifacts, setArtifacts] = useState<ReceiptTemplateArtifactsCurrent | null>(null),
    [pending, setPending] = useState<ReceiptTemplateDraftCursor | null>(null),
    [review, setReview] = useState<ReceiptTemplateReviewCurrent | null>(null),
    [submitPending, setSubmitPending] = useState<ReceiptTemplateSubmitCursor | null>(null),
    [lifecyclePending, setLifecyclePending] = useState<ReceiptTemplateLifecycleCursor | null>(null),
    [publishedHistory, setPublishedHistory] = useState<ReceiptTemplatePublishedVersion | null>(
      null,
    ),
    [reviewNow, setReviewNow] = useState(() => Date.now()),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [listing, setListing] = useState(false),
    [error, setError] = useState<StoreSetupClientError["code"] | null>(null),
    [notice, setNotice] = useState(""),
    [locale, setLocale] = useState(defaultLocale),
    [layout, setLayout] = useState(""),
    [compliance, setCompliance] = useState(""),
    [activation, setActivation] = useState<"Immediate" | "Scheduled">("Immediate"),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const auxiliary = useRef(new Set<AbortController>()),
    epoch = useRef(0),
    active = useRef<AbortController | null>(null),
    running = useRef(false),
    journal = useRef<ReceiptTemplateDraftPendingJournal | null>(null),
    original = useRef<PreparedReceiptTemplateDraft | null>(null),
    submitOriginal = useRef<PreparedReceiptTemplateSubmit | null>(null),
    submitJournal = useRef<ReceiptTemplateSubmitPendingJournal | null>(null),
    lifecycleOriginal = useRef<PreparedReceiptTemplateLifecycle | null>(null),
    lifecycleJournal = useRef<ReceiptTemplateLifecyclePendingJournal | null>(null),
    scopeKey = JSON.stringify(scope),
    identityKey = JSON.stringify({ scope, csrf, defaultLocale }),
    identity = useRef(identityKey),
    loadedIdentity = useRef("");
  identity.current = identityKey;
  const apply = (v: ReceiptTemplateDraftCurrent) => {
    setView(v);
    const c = v.snapshot?.content;
    setLocale(c?.locale ?? defaultLocale);
    setLayout(c?.layoutDefinitionReference ?? "");
    setCompliance(c?.complianceRuleReference ?? "");
    setActivation(c?.activation.mode ?? "Immediate");
    setStart(c?.activation.mode === "Scheduled" ? c.activation.effectiveFrom : "");
    setEnd(c?.effectiveUntil ?? "");
  };
  useEffect(() => {
    setSubject(null);
    setRoster(null);
    setArtifacts(null);
    setNotice("");
  }, [scopeKey, csrf]);
  useEffect(() => {
    const e = ++epoch.current,
      c = new AbortController();
    active.current?.abort();
    active.current = c;
    running.current = false;
    original.current = null;
    lifecycleOriginal.current = null;
    lifecycleJournal.current = null;
    setPublishedHistory(null);
    submitOriginal.current = null;
    submitJournal.current = null;
    journal.current = null;
    loadedIdentity.current = identityKey;
    setListing(false);
    setBusy(true);
    setReady(false);
    setView(null);
    setPending(null);
    setSubmitPending(null);
    setLifecyclePending(null);
    setReview(null);
    setError(null);
    const valid = () =>
      e === epoch.current && identity.current === identityKey && !c.signal.aborted;
    void (async () => {
      const j = journalFactory(scope, subject),
        sj = subject ? submitJournalFactory(scope, subject) : null,
        lj = subject ? lifecycleJournalFactory(scope, subject) : null;
      const [p, sp, lp] = await Promise.all([
        j.load(),
        sj?.load() ?? Promise.resolve(null),
        lj?.load() ?? Promise.resolve(null),
      ]);
      if (!valid()) return;
      lifecycleJournal.current = lj;
      journal.current = j;
      submitJournal.current = sj;
      setPending(p);
      setSubmitPending(sp);
      setLifecyclePending(lp);
      const v = await client.load({
        storeReference: scope.storeReference,
        expectedScope: scope,
        templateReference: subject,
        signal: c.signal,
      });
      if (!valid()) return;
      let r: ReceiptTemplateReviewCurrent | null = null;
      if (v.snapshot)
        r = await submitClient.load({
          storeReference: scope.storeReference,
          templateReference: v.snapshot.content.templateReference,
          expectedScope: scope,
          csrf,
          signal: c.signal,
        });
      if (!valid()) return;
      apply(v);
      setReview(r);
      setReviewNow(Date.now());
      setReady(true);
    })()
      .catch((v) => {
        if (valid()) setError(v instanceof StoreSetupClientError ? v.code : "Unavailable");
      })
      .finally(() => {
        if (valid()) setBusy(false);
      });
    return () => {
      epoch.current++;
      active.current?.abort();
      for (const controller of auxiliary.current) controller.abort();
      auxiliary.current.clear();
      c.abort();
    };
  }, [
    client,
    submitClient,
    journalFactory,
    submitJournalFactory,
    lifecycleClient,
    lifecycleJournalFactory,
    scopeKey,
    csrf,
    subject,
    defaultLocale,
  ]);
  useEffect(() => {
    const c = new AbortController();
    let mounted = true;
    void Promise.all([
      rosterClient.loadRoster({
        storeReference: scope.storeReference,
        expectedScope: scope,
        afterTemplate: null,
        signal: c.signal,
      }),
      artifactClient.load({
        storeReference: scope.storeReference,
        expectedScope: scope,
        signal: c.signal,
      }),
    ])
      .then(([r, a]) => {
        if (mounted && identity.current === identityKey && !c.signal.aborted) {
          setRoster(r);
          setArtifacts(a);
        }
      })
      .catch((v) => {
        if (mounted && identity.current === identityKey && !c.signal.aborted)
          setError(v instanceof StoreSetupClientError ? v.code : "Unavailable");
      });
    return () => {
      mounted = false;
      c.abort();
    };
  }, [rosterClient, artifactClient, scopeKey, csrf]);
  useEffect(() => {
    if (disabled && running.current) active.current?.abort();
  }, [disabled]);
  useEffect(() => {
    const offline = () => {
      if (running.current) active.current?.abort();
    };
    window.addEventListener("offline", offline);
    return () => window.removeEventListener("offline", offline);
  }, []);
  const refreshRoster = async (after: string | null) => {
    if (listing || disabled || busy || pending || submitPending || lifecyclePending || !ready)
      return;
    setListing(true);
    const e = epoch.current,
      capturedIdentity = identityKey,
      c = new AbortController();
    auxiliary.current.add(c);
    const valid = () =>
      e === epoch.current && identity.current === capturedIdentity && !c.signal.aborted;
    try {
      const r = await rosterClient.loadRoster({
        storeReference: scope.storeReference,
        expectedScope: scope,
        afterTemplate: after,
        signal: c.signal,
      });
      if (valid()) setRoster(r);
    } catch (v) {
      if (valid()) setError(v instanceof StoreSetupClientError ? v.code : "Unavailable");
    } finally {
      auxiliary.current.delete(c);
      if (valid()) setListing(false);
    }
  };
  const refreshArtifacts = async () => {
    if (listing || disabled || busy || pending || submitPending || lifecyclePending || !ready)
      return;
    setListing(true);
    const e = epoch.current,
      capturedIdentity = identityKey,
      c = new AbortController();
    auxiliary.current.add(c);
    const valid = () =>
      e === epoch.current && identity.current === capturedIdentity && !c.signal.aborted;
    try {
      const a = await artifactClient.load({
        storeReference: scope.storeReference,
        expectedScope: scope,
        signal: c.signal,
      });
      if (valid()) setArtifacts(a);
    } catch (v) {
      if (valid()) setError(v instanceof StoreSetupClientError ? v.code : "Unavailable");
    } finally {
      auxiliary.current.delete(c);
      if (valid()) setListing(false);
    }
  };
  const action = async (
    mode:
      | "Save"
      | "Resolve"
      | "Retry"
      | "Refresh"
      | "Submit"
      | "SubmitResolve"
      | "SubmitRetry"
      | "Approve"
      | "Publish"
      | "LifecycleResolve"
      | "LifecycleRetry",
  ) => {
    if (
      disabled ||
      running.current ||
      busy ||
      loadedIdentity.current !== identityKey ||
      !navigator.onLine
    )
      return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const e = epoch.current,
      c = new AbortController();
    active.current?.abort();
    active.current = c;
    const valid = () =>
      e === epoch.current && identity.current === identityKey && !c.signal.aborted;
    try {
      const j = journal.current ?? journalFactory(scope, subject),
        sj = subject ? (submitJournal.current ?? submitJournalFactory(scope, subject)) : null,
        lj = subject ? (lifecycleJournal.current ?? lifecycleJournalFactory(scope, subject)) : null;
      const [p, sp, lp] = await Promise.all([
        j.load(),
        sj?.load() ?? Promise.resolve(null),
        lj?.load() ?? Promise.resolve(null),
      ]);
      lifecycleJournal.current = lj;
      check({ client, journal: j, csrf, signal: c.signal, isCurrent: valid });
      journal.current = j;
      submitJournal.current = sj;
      setPending(p);
      setSubmitPending(sp);
      setLifecyclePending(lp);
      if (
        mode === "Approve" ||
        mode === "Publish" ||
        mode === "LifecycleResolve" ||
        mode === "LifecycleRetry"
      ) {
        if (!lj || ((mode === "Approve" || mode === "Publish") && (p || sp)))
          throw new StoreSetupClientError("Conflict");
        const common = {
          client,
          submitClient,
          lifecycleClient,
          journal: lj,
          csrf,
          signal: c.signal,
          isCurrent: valid,
        };
        let result;
        if (mode === "Approve" || mode === "Publish") {
          if (lp || dirty || !view || !review || !ready)
            throw new StoreSetupClientError("Conflict");
          result = await advanceReceiptTemplateLifecycle({
            ...common,
            scope,
            baseline: view,
            review,
            fields: savedFields(view),
            action: mode,
            onReserved: (prepared) => {
              if (valid()) {
                lifecycleOriginal.current = prepared;
                setLifecyclePending(prepared.cursor);
              }
            },
          });
        } else {
          if (!lp || (mode === "LifecycleRetry" && !lifecycleOriginal.current))
            throw new StoreSetupClientError("Conflict");
          result = await finishReceiptTemplateLifecycleOriginal({
            ...common,
            cursor: lp,
            ...(mode === "LifecycleRetry" && lifecycleOriginal.current
              ? { prepared: lifecycleOriginal.current }
              : {}),
          });
        }
        if (valid()) {
          lifecycleOriginal.current = null;
          setLifecyclePending(null);
          apply(result.current);
          setReview(result.review);
          setReviewNow(Date.now());
          setReady(true);
          setPublishedHistory(result.receipt.result?.publishedVersion ?? null);
          setNotice(
            result.receipt.outcome === "Abandoned"
              ? "Original review action did not commit."
              : result.historical
                ? "Original review action confirmed from history; the current review is shown separately."
                : result.receipt.action === "Approve"
                  ? "Independent approval confirmed. Publication remains separate."
                  : "Template publication confirmed. Store selection and operational readiness remain separate.",
          );
        }
        return;
      }
      if (
        lp &&
        mode !== "SubmitResolve" &&
        mode !== "SubmitRetry" &&
        mode !== "Resolve" &&
        mode !== "Retry"
      )
        throw new StoreSetupClientError("Conflict");
      if (mode === "Submit" || mode === "SubmitResolve" || mode === "SubmitRetry") {
        if (!sj || (p && mode === "Submit")) throw new StoreSetupClientError("Conflict");
        const common = {
          client,
          submitClient,
          journal: sj,
          csrf,
          signal: c.signal,
          isCurrent: valid,
        };
        let result;
        if (mode === "Submit") {
          if (sp || dirty || frozenReview || !view?.snapshot || !ready)
            throw new StoreSetupClientError("Conflict");
          result = await submitReceiptTemplateDraft({
            ...common,
            scope,
            baseline: view,
            fields: savedFields(view),
            onReserved: (prepared) => {
              if (valid()) {
                submitOriginal.current = prepared;
                setSubmitPending(prepared.cursor);
              }
            },
          });
        } else {
          if (!sp || (mode === "SubmitRetry" && !submitOriginal.current))
            throw new StoreSetupClientError("Conflict");
          result = await finishReceiptTemplateSubmitOriginal({
            ...common,
            cursor: sp,
            ...(mode === "SubmitRetry" && submitOriginal.current
              ? { prepared: submitOriginal.current }
              : {}),
          });
        }
        if (valid()) {
          submitOriginal.current = null;
          setSubmitPending(null);
          apply(result.current);
          setReady(true);
          setReview(result.review);
          setReviewNow(Date.now());
          setNotice(
            result.receipt.outcome === "Committed"
              ? "Original review submission confirmed. Approval and publication remain separate."
              : "Original submission did not commit. You may submit the saved draft again.",
          );
        }
        return;
      }
      if (sp && mode !== "Resolve" && mode !== "Retry") throw new StoreSetupClientError("Conflict");
      if (mode === "Refresh") {
        const v = await client.load({
          storeReference: scope.storeReference,
          expectedScope: scope,
          templateReference: subject,
          signal: c.signal,
        });
        if (valid()) {
          const r = v.snapshot
            ? await submitClient.load({
                storeReference: scope.storeReference,
                templateReference: v.snapshot.content.templateReference,
                expectedScope: scope,
                csrf,
                signal: c.signal,
              })
            : null;
          if (!valid()) return;
          apply(v);
          setReview(r);
          setReviewNow(Date.now());
          setReady(true);
        }
        return;
      }
      let freshReview: ReceiptTemplateReviewCurrent | null = null;
      const common = {
        client,
        journal: j,
        csrf,
        signal: c.signal,
        isCurrent: valid,
        beforeComplete: async (current: ReceiptTemplateDraftCurrent) => {
          if (current.snapshot)
            freshReview = await submitClient.load({
              storeReference: scope.storeReference,
              templateReference: current.snapshot.content.templateReference,
              expectedScope: scope,
              csrf,
              signal: c.signal,
            });
          if (!valid()) throw new StoreSetupClientError("ScopeChanged");
          if (
            freshReview &&
            current.snapshot &&
            (freshReview.currentDraft.versionReference !==
              current.snapshot.content.versionReference ||
              freshReview.currentDraft.revision !== current.snapshot.revision ||
              freshReview.currentDraft.contentDigest !== current.snapshot.contentDigest)
          )
            throw new StoreSetupClientError("Conflict");
        },
      };
      let result;
      if (mode === "Save") {
        if (p || frozenReview || !ready || loadedIdentity.current !== identityKey || !view)
          throw new StoreSetupClientError("Conflict");
        const fields = parseReceiptTemplateDraftFields({
          locale,
          layoutDefinitionReference: layout,
          complianceRuleReference: compliance,
          activation:
            activation === "Immediate"
              ? { mode: "Immediate" }
              : { mode: "Scheduled", effectiveFrom: start },
          effectiveUntil: end || null,
        });
        result = await saveReceiptTemplateDraft({
          ...common,
          scope,
          baseline: view,
          fields,
          onReserved: (prepared) => {
            if (valid()) {
              original.current = prepared;
              setPending(prepared.cursor);
            }
          },
        });
      } else {
        if (!p) throw new StoreSetupClientError("Conflict");
        if (mode === "Retry" && !original.current) throw new StoreSetupClientError("Conflict");
        result = await finishReceiptTemplateDraftOriginal({
          ...common,
          cursor: p,
          ...(mode === "Retry" && original.current ? { prepared: original.current } : {}),
        });
      }
      if (valid()) {
        original.current = null;
        setPending(null);
        apply(result.current);
        setReview(freshReview);
        setReviewNow(Date.now());
        setReady(true);
        setNotice(
          result.receipt.outcome === "Committed"
            ? "Saved template draft confirmed. Publication has not been evaluated."
            : "Earlier save did not commit. You can save a new draft.",
        );
        setSubject(result.current.templateReference);
      }
    } catch (v) {
      if (e === epoch.current && identity.current === identityKey)
        setError(v instanceof StoreSetupClientError ? v.code : "Unavailable");
    } finally {
      if (e === epoch.current && identity.current === identityKey) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  let dirty = true;
  try {
    dirty =
      !view?.snapshot ||
      canonical(
        parseReceiptTemplateDraftFields({
          locale,
          layoutDefinitionReference: layout,
          complianceRuleReference: compliance,
          activation:
            activation === "Immediate"
              ? { mode: "Immediate" }
              : { mode: "Scheduled", effectiveFrom: start },
          effectiveUntil: end || null,
        }),
      ) !== canonical(savedFields(view));
  } catch {
    dirty = true;
  }
  const frozenReview = Boolean(
    review?.submission &&
    review.lifecycle &&
    (review.lifecycle.state === "InReview" || review.lifecycle.state === "Approved") &&
    Date.parse(review.submission.validationValidUntil) > reviewNow,
  );
  useEffect(() => {
    setReviewNow(Date.now());
    const expiry = review?.submission?.validationValidUntil;
    if (!expiry) return;
    const wait = Date.parse(expiry) - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => setReviewNow(Date.now()), Math.min(wait + 1, 2147483647));
    return () => clearTimeout(t);
  }, [review]);
  const locked =
      disabled ||
      busy ||
      listing ||
      !ready ||
      loadedIdentity.current !== identityKey ||
      Boolean(pending) ||
      Boolean(submitPending) ||
      Boolean(lifecyclePending),
    currentLayout = artifacts?.layout,
    currentCompliance = artifacts?.compliance;
  const rows = roster?.entries ?? [],
    selected = view?.snapshot,
    publicationRecorded =
      review?.lifecycle?.state === "Published" &&
      review.submission?.versionReference === selected?.content.versionReference;
  return (
    <section hidden={hidden} aria-label="Receipt template drafts">
      <h4>Receipt template drafts</h4>
      <p>
        Save an authored template and inspect its standard receipt fields. A Draft does not publish
        a template, bind Store configuration, or confirm professional or legal review.
      </p>
      <label>
        Receipt template
        <select
          aria-label="Receipt template"
          value={subject ?? ""}
          disabled={locked || listing}
          onChange={(e) => setSubject(e.target.value || null)}
        >
          <option value="">New template draft</option>
          {subject && !rows.some((r) => r.content.templateReference === subject) && (
            <option value={subject}>
              {selected
                ? `${selected.content.locale} · Revision ${selected.revision} · ${selected.content.versionCode}`
                : "Selected saved template"}
            </option>
          )}
          {rows.map((r) => (
            <option key={r.content.templateReference} value={r.content.templateReference}>
              {r.content.locale} · Revision {r.revision} · {r.content.versionCode}
            </option>
          ))}
        </select>
      </label>
      <div className="store-setup-actions">
        <button
          type="button"
          disabled={
            disabled ||
            busy ||
            listing ||
            Boolean(pending) ||
            Boolean(submitPending) ||
            Boolean(lifecyclePending)
          }
          onClick={() => void refreshRoster(null)}
        >
          Refresh template list
        </button>
        <button
          type="button"
          disabled={
            disabled ||
            busy ||
            listing ||
            Boolean(pending) ||
            Boolean(submitPending) ||
            Boolean(lifecyclePending) ||
            !roster?.nextAfter
          }
          onClick={() => void refreshRoster(roster?.nextAfter ?? null)}
        >
          Next templates
        </button>
      </div>
      {selected && (
        <p>
          Saved {selected.content.locale}, revision {selected.revision},{" "}
          {selected.content.versionCode}.{" "}
          {publicationRecorded ? "Publication recorded." : "Publication has not been evaluated."}
        </p>
      )}
      {lifecyclePending && (
        <div>
          <p role="status">
            Recover the original approval or publication before another write or template selection.
          </p>
          <button
            type="button"
            disabled={disabled || busy || loadedIdentity.current !== identityKey}
            onClick={() => void action("LifecycleResolve")}
          >
            Recover earlier template review action
          </button>
          {lifecycleOriginal.current && (
            <button
              type="button"
              disabled={disabled || busy || loadedIdentity.current !== identityKey}
              onClick={() => void action("LifecycleRetry")}
            >
              Retry exact template review action
            </button>
          )}
        </div>
      )}
      {selected && review && (
        <div className="store-setup-actions">
          <button
            type="button"
            disabled={
              locked ||
              dirty ||
              !view ||
              !receiptTemplateLifecycleAvailable(scope, view, review, "Approve", reviewNow)
            }
            onClick={() => void action("Approve")}
          >
            Approve receipt template
          </button>
          <button
            type="button"
            disabled={
              locked ||
              dirty ||
              !view ||
              !receiptTemplateLifecycleAvailable(scope, view, review, "Publish", reviewNow)
            }
            onClick={() => void action("Publish")}
          >
            Publish receipt template
          </button>
          {review.submission &&
            (scope.actorReference === review.submission.authoredByReference ||
              scope.actorReference === review.submission.submittedByReference) &&
            review.lifecycle?.state === "InReview" && (
              <p>Approval requires an actor other than the original author and submitter.</p>
            )}
        </div>
      )}
      {publishedHistory && (
        <section aria-label="Original template publication">
          <h5>Original publication receipt</h5>
          <p>
            {publishedHistory.versionCode} · {publishedHistory.locale} · Published at{" "}
            {publishedHistory.publishedAt}
          </p>
          <p>
            Effective from {publishedHistory.effectiveFrom}; until{" "}
            {publishedHistory.effectiveUntil ?? "no recorded end"}. This immutable receipt does not
            establish current effectiveness, Store selection, professional or legal approval.
          </p>
        </section>
      )}
      {review && (
        <section aria-label="Receipt template review status">
          <h5>Recorded review</h5>
          {review.submission && review.lifecycle ? (
            <>
              <p>
                {review.lifecycle.state} · submitted draft revision{" "}
                {review.submission.draftRevision}.{" "}
                {Date.parse(review.submission.validationValidUntil) <= reviewNow
                  ? "The original validation period has expired; this is historical evidence."
                  : "Validation valid until " + review.submission.validationValidUntil}
              </p>
              {review.submission.versionReference !== selected?.content.versionReference && (
                <p>This review refers to an earlier saved draft, not the current edited version.</p>
              )}
            </>
          ) : (
            <p>The saved draft has not been submitted for review.</p>
          )}
          <p>
            Professional and legal review are not evaluated.
            {review.lifecycle?.state !== "Published" && " Publication remains separate."}
          </p>
        </section>
      )}
      {submitPending && (
        <p role="status">
          An original review submission must be recovered before saving, submitting or selecting
          another template.
        </p>
      )}
      {selected && !submitPending && (
        <button
          type="button"
          disabled={
            locked ||
            dirty ||
            frozenReview ||
            !review ||
            review.submission?.versionReference === selected.content.versionReference
          }
          onClick={() => void action("Submit")}
        >
          Submit template for review
        </button>
      )}
      {selected && dirty && !submitPending && (
        <p>Save the changed template fields before submitting for review.</p>
      )}
      {selected && (
        <button
          type="button"
          disabled={
            disabled ||
            busy ||
            !ready ||
            Boolean(pending) ||
            Boolean(submitPending) ||
            Boolean(lifecyclePending) ||
            loadedIdentity.current !== identityKey
          }
          onClick={() => void action("Refresh")}
        >
          Refresh template review
        </button>
      )}
      {submitPending && (
        <div className="store-setup-actions">
          <button
            type="button"
            disabled={disabled || busy || loadedIdentity.current !== identityKey}
            onClick={() => void action("SubmitResolve")}
          >
            Recover earlier template submission
          </button>
          {submitOriginal.current && (
            <button
              type="button"
              disabled={disabled || busy || loadedIdentity.current !== identityKey}
              onClick={() => void action("SubmitRetry")}
            >
              Retry exact template submission
            </button>
          )}
        </div>
      )}
      {busy && <p role="status">Loading template draft…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert">
          {error === "OutcomeUnknown"
            ? "The request could not be confirmed. Recover its original save or submission before writing again."
            : error === "Denied"
              ? "Permission denied. An earlier save remains protected."
              : error === "Invalid"
                ? "Check the locale, saved preset selections and UTC effective period. An earlier save remains protected."
                : error === "Conflict"
                  ? "The template changed or the original save conflicts. Refresh or recover the original save; no version has been silently substituted."
                  : "Template draft unavailable or invalid. Refresh when connected; an earlier save remains protected."}
        </p>
      )}
      {pending && (
        <p role="status">
          An earlier template draft save must be recovered before another save or template
          selection.
        </p>
      )}
      <fieldset disabled={locked || frozenReview}>
        <legend>Authored template fields</legend>
        <label>
          Template locale
          <input
            aria-label="Template locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
          />
        </label>
        <label>
          Receipt layout selection
          <select
            aria-label="Receipt layout selection"
            value={layout}
            onChange={(e) => setLayout(e.target.value)}
          >
            <option value="">Choose saved receipt layout</option>
            {layout && layout !== currentLayout?.artifactReference && (
              <option value={layout}>Saved layout selection (retained)</option>
            )}
            {currentLayout && (
              <option value={currentLayout.artifactReference}>
                Saved layout revision {currentLayout.revision}
              </option>
            )}
          </select>
        </label>
        <label>
          Receipt required fields selection
          <select
            aria-label="Receipt required fields selection"
            value={compliance}
            onChange={(e) => setCompliance(e.target.value)}
          >
            <option value="">Choose saved required fields</option>
            {compliance && compliance !== currentCompliance?.artifactReference && (
              <option value={compliance}>Saved required fields selection (retained)</option>
            )}
            {currentCompliance && (
              <option value={currentCompliance.artifactReference}>
                Saved required fields revision {currentCompliance.revision}
              </option>
            )}
          </select>
        </label>
        {!currentLayout || !currentCompliance ? (
          <p>Save both receipt presets above, then refresh available presets.</p>
        ) : null}
        <button type="button" onClick={() => void refreshArtifacts()}>
          Refresh available presets
        </button>
        <label>
          Template activation
          <select
            aria-label="Template activation"
            value={activation}
            onChange={(e) =>
              setActivation(e.target.value === "Scheduled" ? "Scheduled" : "Immediate")
            }
          >
            <option value="Immediate">Immediate</option>
            <option value="Scheduled">Scheduled</option>
          </select>
        </label>
        {activation === "Scheduled" && (
          <label>
            Template activation UTC
            <input
              aria-label="Template activation UTC"
              placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
        )}
        <label>
          Template effective until UTC (optional)
          <input
            aria-label="Template effective until UTC (optional)"
            placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </fieldset>
      <section aria-label="Receipt field preview">
        <h5>Standard receipt field preview</h5>
        <p>
          Standard fields supported by the saved digital receipt layout. No actual order or payment
          details are shown.
        </p>
        <ul>
          {receiptTemplateArtifactRequiredFields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      </section>
      <div className="store-setup-actions">
        <button
          type="button"
          disabled={disabled || busy || loadedIdentity.current !== identityKey}
          onClick={() => void action("Refresh")}
        >
          Refresh saved template draft
        </button>
        {pending ? (
          <>
            <button
              type="button"
              disabled={disabled || busy || loadedIdentity.current !== identityKey}
              onClick={() => void action("Resolve")}
            >
              Recover original template draft save
            </button>
            {original.current && (
              <button
                type="button"
                disabled={disabled || busy || loadedIdentity.current !== identityKey}
                onClick={() => void action("Retry")}
              >
                Retry exact template draft save
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            disabled={locked || frozenReview || !layout || !compliance}
            onClick={() => void action("Save")}
          >
            Save template draft
          </button>
        )}
      </div>
    </section>
  );
}
