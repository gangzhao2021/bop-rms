import { useEffect, useMemo, useRef, useState } from "react";
import {
  PlatformTemplateClientError,
  parsePlatformTemplateContent,
  type PlatformTemplateClient,
  type PlatformTemplateBootstrap,
  type PlatformTemplateScope,
  type PlatformTemplateContent,
  type PlatformTemplateSnapshot,
  type PlatformTemplatePendingOriginal,
} from "./platform-template-client.js";
import {
  createPlatformTemplatePendingJournal,
  type PlatformTemplatePendingJournal,
} from "./platform-template-pending-journal.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import { serviceOperationReference } from "./service-control-client.js";

export interface PlatformTemplatePanelProps {
  readonly session: PlatformTemplateBootstrap;
  readonly client: PlatformTemplateClient;
  readonly journalFactory?: (scope: PlatformTemplateScope) => PlatformTemplatePendingJournal;
}
type Actions = Awaited<ReturnType<PlatformTemplateClient["actions"]>>;
type Listing = Awaited<ReturnType<PlatformTemplateClient["list"]>>;
type Current = Awaited<ReturnType<PlatformTemplateClient["current"]>>;
type History = Awaited<ReturnType<PlatformTemplateClient["history"]>>;
type Publication = Awaited<ReturnType<PlatformTemplateClient["publicationCurrent"]>>;
type PublicationHistory = Awaited<ReturnType<PlatformTemplateClient["publicationHistory"]>>;
type Operation = "CreateDraft" | "SubmitReview" | "Approve" | "Publish" | "Archive";
type Form = { [K in keyof PlatformTemplateContent]: string };
interface Work {
  controls: { csrf: string; signal: AbortSignal };
  check(): void;
}
type RefreshEvidence = {
  -readonly [K in keyof Parameters<PlatformTemplatePendingJournal["complete"]>[3]]: Parameters<
    PlatformTemplatePendingJournal["complete"]
  >[3][K];
};
const emptyForm = (): Form => ({
  code: "",
  name: "",
  defaultLocale: "",
  supportedLocales: "",
  overrideAllowedFieldCodes: "",
  hardRequirementFieldCodes: "",
  effectiveFrom: "",
  effectiveUntil: "",
  reasonCode: "",
});
const formFor = (c: PlatformTemplateContent): Form => ({
  ...c,
  supportedLocales: c.supportedLocales.join(", "),
  overrideAllowedFieldCodes: c.overrideAllowedFieldCodes.join(", "),
  hardRequirementFieldCodes: c.hardRequirementFieldCodes.join(", "),
  effectiveFrom: c.effectiveFrom.slice(0, -1),
  effectiveUntil: c.effectiveUntil?.slice(0, -1) ?? "",
});
const values = (v: string) =>
  v
    .split(/[,\n]/u)
    .map((s) => s.trim())
    .filter(Boolean);
const codePattern = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u;
function utc(value: string): string | null {
  if (value === "") return null;
  if (!/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/u.test(value))
    throw new PlatformTemplateClientError("Invalid");
  const exact =
    (value.length === 16
      ? value + ":00.000"
      : value.length === 19
        ? value + ".000"
        : value.padEnd(23, "0")) + "Z";
  if (!Number.isFinite(Date.parse(exact)) || new Date(exact).toISOString() !== exact)
    throw new PlatformTemplateClientError("Invalid");
  return exact;
}
function formErrors(form: Form): Partial<Record<keyof Form, string>> {
  const result: Partial<Record<keyof Form, string>> = {};
  if (!codePattern.test(form.code))
    result.code = "Use 1–64 uppercase letters, numbers or . _ : -; start with a letter.";
  if (
    form.name !== form.name.trim() ||
    [...form.name].length < 1 ||
    [...form.name].length > 160 ||
    [...form.name].some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    ) ||
    /[<>]/u.test(form.name)
  )
    result.name = "Enter a name of 1–160 characters without surrounding spaces or < >.";
  const locales = values(form.supportedLocales),
    allowed = values(form.overrideAllowedFieldCodes),
    hard = values(form.hardRequirementFieldCodes);
  if (
    locales.length < 1 ||
    locales.length > 20 ||
    locales.some((v) => !localePattern.test(v)) ||
    new Set(locales).size !== locales.length
  )
    result.supportedLocales =
      "Enter 1–20 distinct locale codes, such as en-CA, separated by commas.";
  if (!locales.includes(form.defaultLocale))
    result.defaultLocale = "Choose one of the supported locales.";
  for (const [key, list] of [
    ["overrideAllowedFieldCodes", allowed],
    ["hardRequirementFieldCodes", hard],
  ] as const)
    if (
      list.length > 100 ||
      list.some((v) => !codePattern.test(v)) ||
      new Set(list).size !== list.length
    )
      result[key] = "Enter at most 100 distinct uppercase field codes, separated by commas.";
  if (hard.some((v) => allowed.includes(v)))
    result.hardRequirementFieldCodes = "A hard requirement cannot also permit an override.";
  let from: string | null = null,
    until: string | null = null;
  try {
    from = utc(form.effectiveFrom);
    if (!from) result.effectiveFrom = "Choose an effective start in UTC.";
  } catch {
    result.effectiveFrom = "Enter a valid UTC date and time.";
  }
  try {
    until = utc(form.effectiveUntil);
  } catch {
    result.effectiveUntil = "Enter a valid UTC date and time or leave blank.";
  }
  if (from && until && until <= from) result.effectiveUntil = "The end must be after the start.";
  if (!codePattern.test(form.reasonCode))
    result.reasonCode = "Enter a valid uppercase reason code.";
  return result;
}
const messages: Record<PlatformTemplateClientError["code"], string> = {
  Invalid: "Check the fields and the selected saved version before continuing.",
  Denied:
    "Current access refused this request. Refresh your Platform session and access; any pending original is retained.",
  Conflict:
    "The recorded version changed. Recover any original request, then refresh and choose a new action.",
  Unavailable: "Template setup is unavailable. Refresh or recover the original request.",
  OutcomeUnknown:
    "The result is unknown. Recover the original request before starting another action.",
  ScopeChanged:
    "Your account or session changed. Return to the original account to recover its request.",
  Stale: "The current observation expired. Refresh templates before continuing.",
};
function ContentDetails({ content }: { readonly content: PlatformTemplateContent }) {
  return (
    <dl>
      <dt>Name</dt>
      <dd>{content.name}</dd>
      <dt>Code</dt>
      <dd>{content.code}</dd>
      <dt>Default locale</dt>
      <dd>{content.defaultLocale}</dd>
      <dt>Supported locales</dt>
      <dd>{content.supportedLocales.join(", ")}</dd>
      <dt>Permitted overrides</dt>
      <dd>{content.overrideAllowedFieldCodes.join(", ") || "None"}</dd>
      <dt>Hard requirements</dt>
      <dd>{content.hardRequirementFieldCodes.join(", ") || "None"}</dd>
      <dt>Effective from (UTC)</dt>
      <dd>
        <time dateTime={content.effectiveFrom}>{content.effectiveFrom}</time>
      </dd>
      <dt>Effective until (UTC)</dt>
      <dd>
        {content.effectiveUntil ? (
          <time dateTime={content.effectiveUntil}>{content.effectiveUntil}</time>
        ) : (
          "Open"
        )}
      </dd>
      <dt>Content reason</dt>
      <dd>{content.reasonCode}</dd>
    </dl>
  );
}

export function PlatformTemplatePanel({
  session,
  client,
  journalFactory,
}: PlatformTemplatePanelProps) {
  const scope = useMemo<PlatformTemplateScope>(
    () => ({
      kind: "Platform",
      actorReference: session.session.actorReference,
      purposeCode: "PLATFORM_BRAND_TEMPLATE",
    }),
    [session.session.actorReference],
  );
  const journal = useMemo(
    () => (journalFactory ?? createPlatformTemplatePendingJournal)(scope),
    [journalFactory, scope],
  );
  const [actions, setActions] = useState<Actions | null>(null),
    [listing, setListing] = useState<Listing | null>(null);
  const [current, setCurrent] = useState<Current | null>(null),
    [history, setHistory] = useState<History | null>(null);
  const [publication, setPublication] = useState<Publication | null>(null),
    [publicationHistory, setPublicationHistory] = useState<PublicationHistory | null>(null);
  const [reviewContent, setReviewContent] = useState<PlatformTemplateSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [lifecycle, setLifecycle] = useState<string | null>(null);
  const [creating, setCreating] = useState(false),
    [form, setForm] = useState<Form>(emptyForm),
    [dirty, setDirty] = useState(false);
  const [review, setReview] = useState(""),
    [reason, setReason] = useState(""),
    [submitted, setSubmitted] = useState(false);
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const [pending, setPending] = useState<PlatformTemplatePendingOriginal | null>(null);
  const [busy, setBusy] = useState(false),
    [online, setOnline] = useState(navigator.onLine),
    [tick, setTick] = useState(0);
  const [message, setMessage] = useState("Loading actual templates and current access…");
  const running = useRef(false),
    generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const errors = formErrors(form);
  const allowed = (action: string) => actions?.allowedActions.some((a) => a === action) === true;
  function explain(error: unknown) {
    if (error instanceof PlatformTemplateClientError) {
      setMessage(messages[error.code]);
      if (error.code === "Denied" || error.code === "ScopeChanged") setActions(null);
    } else setMessage(messages.Unavailable);
  }
  async function work(task: (work: Work) => Promise<void>) {
    if (running.current) return;
    if (!navigator.onLine) {
      setOnline(false);
      setMessage("Offline. Reconnect before continuing.");
      return;
    }
    const epoch = ++generation.current,
      active = new AbortController();
    controller.current?.abort();
    controller.current = active;
    client.invalidate();
    running.current = true;
    setBusy(true);
    const check = () => {
      if (generation.current !== epoch || active.signal.aborted)
        throw new PlatformTemplateClientError("ScopeChanged");
    };
    try {
      await task({ controls: { csrf: session.csrf, signal: active.signal }, check });
      check();
    } catch (error) {
      if (generation.current === epoch && !active.signal.aborted) explain(error);
    } finally {
      if (generation.current === epoch) {
        running.current = false;
        setBusy(false);
        setTick((n) => n + 1);
      }
    }
  }
  async function readSelected(
    w: Work,
    family: string,
    selectedLifecycle: string | null,
    preserve: boolean,
    preservePublication = preserve,
  ) {
    const c = await client.current(scope, family, w.controls);
    w.check();
    const h = await client.history(scope, family, null, w.controls);
    w.check();
    const p = await client.publicationCurrent(scope, family, selectedLifecycle, w.controls);
    w.check();
    const ph = await client.publicationHistory(scope, family, null, w.controls);
    w.check();
    let content: PlatformTemplateSnapshot | null = null;
    if (p.current) {
      const exact = await client.exact(scope, p.current.command.next.snapshotReference, w.controls);
      w.check();
      content = exact.snapshot;
    }
    if (
      p.current &&
      (!content ||
        content.templateReference !== family ||
        content.contentDigest !== p.current.command.next.snapshotDigest ||
        content.sourceDigest !== p.current.templateSourceDigest)
    )
      throw new PlatformTemplateClientError("Invalid");
    setSelected(family);
    setLifecycle(selectedLifecycle);
    setCurrent(c);
    setHistory(h);
    setPublication(p);
    setPublicationHistory(ph);
    setReviewContent(content);
    setCreating(false);
    if (!preserve) {
      setForm(c.current ? formFor(c.current.content) : emptyForm());
      setDirty(false);
      setSubmitted(false);
    }
    if (!preservePublication) {
      setReview("");
      setReason(c.current?.content.reasonCode ?? "");
    }
    setArchiveConfirmed(false);
    return c.current !== null;
  }
  async function refresh(
    w: Work,
    family = selected,
    selectedLifecycle = lifecycle,
    preserve = true,
    preservePublication = preserve,
  ) {
    const a = await client.actions(scope, w.controls);
    w.check();
    const page = await client.list(scope, null, 20, w.controls);
    w.check();
    const found = family
      ? await readSelected(w, family, selectedLifecycle, preserve, preservePublication)
      : true;
    setActions(a);
    setListing(page);
    setMessage(
      !found
        ? "The selected template was not found in the current source."
        : page.items.length
          ? "Templates and current access refreshed."
          : "No templates have been saved. Create one to begin Brand setup.",
    );
  }
  useEffect(() => {
    running.current = false;
    void work(async (w) => {
      const original = await journal.load();
      w.check();
      setPending(original);
      await refresh(w, null, null, false);
    });
    const offline = () => {
      ++generation.current;
      controller.current?.abort();
      client.invalidate();
      running.current = false;
      setBusy(false);
      setOnline(false);
      setMessage("Offline. Pending originals remain available after reconnecting.");
    };
    const reconnect = () => {
      setOnline(true);
      setMessage("Reconnected. Refresh templates before continuing.");
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", reconnect);
    return () => {
      ++generation.current;
      controller.current?.abort();
      running.current = false;
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", reconnect);
    };
    // This component is remounted for every actual Session/CSRF change.
  }, [client, journal]);
  useEffect(() => {
    const deadlines = [
      actions?.validUntil,
      listing?.validUntil,
      current?.validUntil,
      publication?.validUntil,
      reviewContent ? publication?.current?.command.next.reviewValidUntil : null,
    ]
      .filter((v): v is string => typeof v === "string")
      .map(Date.parse)
      .filter((v) => v > Date.now());
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => setTick((n) => n + 1),
      Math.max(1, Math.min(...deadlines) - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [actions, listing, current, publication, reviewContent, tick]);
  function fresh() {
    const at = Date.now();
    return (
      online &&
      !session.recentMfaRequired &&
      at < Date.parse(session.session.expiresAt) &&
      !!actions &&
      at >= Date.parse(actions.observedAt) &&
      at < Date.parse(actions.validUntil) &&
      (!current || at < Date.parse(current.validUntil)) &&
      (!publication || at < Date.parse(publication.validUntil))
    );
  }
  async function recover(w: Work, original: PlatformTemplatePendingOriginal) {
    const receipt = await client.resolve(scope, original, w.controls);
    w.check();
    const reobserved = await client.resolve(scope, original, w.controls);
    w.check();
    const observed: RefreshEvidence = {};
    let family = original.templateReference,
      cycle: string | null = null;
    if (receipt.profile === "PlatformBrandTemplateOperationV1") {
      family = receipt.snapshot?.templateReference ?? family;
      if (family === null) {
        observed.list = await client.list(scope, null, 20, w.controls);
        w.check();
      } else {
        observed.current = await client.current(scope, family, w.controls);
        w.check();
        observed.history = await client.history(scope, family, null, w.controls);
        w.check();
        if (receipt.snapshot) {
          observed.exact = await client.exact(
            scope,
            receipt.snapshot.templateVersionReference,
            w.controls,
          );
          w.check();
        }
      }
    } else {
      family = receipt.source?.command.next.familyReference ?? family;
      if (!family) throw new PlatformTemplateClientError("Invalid");
      cycle = receipt.source?.command.next.lifecycleId ?? null;
      observed.publicationCurrent = await client.publicationCurrent(
        scope,
        family,
        cycle,
        w.controls,
      );
      w.check();
      observed.publicationHistory = await client.publicationHistory(
        scope,
        family,
        null,
        w.controls,
      );
      w.check();
      if (receipt.source) {
        observed.publicationExact = await client.publicationExact(
          scope,
          family,
          receipt.source.sequence,
          w.controls,
        );
        w.check();
      }
    }
    await journal.complete(original, receipt, reobserved, observed);
    w.check();
    setPending(null);
    await refresh(w, family, cycle, false);
    w.check();
    setMessage(
      receipt.outcome === "Committed"
        ? "Previous operation confirmed. Template state refreshed."
        : "The original request was not applied. Refreshed state is ready for a new deliberate action.",
    );
  }
  async function dispatch(
    w: Work,
    prepared: Awaited<ReturnType<PlatformTemplateClient["prepareSave"]>>,
    permit: () => boolean,
  ) {
    await journal.reserve(prepared.original);
    w.check();
    setPending(prepared.original);
    const held = await journal.load();
    w.check();
    if (canonical(held) !== canonical(prepared.original))
      throw new PlatformTemplateClientError("Conflict");
    if (!fresh() || !permit()) throw new PlatformTemplateClientError("Stale");
    await client.execute(scope, prepared, w.controls);
    w.check();
    await recover(w, prepared.original);
  }
  function save() {
    setSubmitted(true);
    if (Object.keys(errors).length) {
      setMessage(messages.Invalid);
      return;
    }
    if (
      !fresh() ||
      !allowed("platform.brand-template.manage") ||
      pending ||
      (!creating && !current?.current)
    )
      return;
    let content: PlatformTemplateContent;
    try {
      content = parsePlatformTemplateContent({
        ...form,
        supportedLocales: values(form.supportedLocales),
        overrideAllowedFieldCodes: values(form.overrideAllowedFieldCodes),
        hardRequirementFieldCodes: values(form.hardRequirementFieldCodes),
        effectiveFrom: utc(form.effectiveFrom),
        effectiveUntil: utc(form.effectiveUntil),
      });
    } catch (error) {
      explain(error);
      return;
    }
    void work(async (w) => {
      const snapshot = creating ? null : (current?.current ?? null);
      const prepared = await client.prepareSave(scope, {
        operationReference: serviceOperationReference(),
        templateReference: snapshot?.templateReference ?? null,
        expectedHead: snapshot
          ? {
              revision: snapshot.revision,
              templateVersionReference: snapshot.templateVersionReference,
              sourceDigest: snapshot.sourceDigest,
            }
          : null,
        content,
      });
      w.check();
      await dispatch(w, prepared, () => allowed("platform.brand-template.manage"));
    });
  }
  function blocked(operation: Operation): string | null {
    if (pending) return "Recover the pending original before starting another action.";
    if (!online) return "Reconnect before changing templates.";
    if (!fresh()) return "Refresh templates to confirm current access and versions.";
    if (busy) return "Another request is in progress.";
    if (!current?.current) return "Select a saved template first.";
    if (dirty) return "Save or discard unsaved content edits before a publication action.";
    if (!codePattern.test(reason)) return "Enter a valid publication reason code.";
    const source = publication?.current,
      record = source?.command.next;
    if (operation === "CreateDraft")
      return current.current.authoredByReference !== scope.actorReference
        ? "Only the saved content's author can create its publication Draft."
        : null;
    if (!record || !reviewContent) return "Create or select an actual publication Draft first.";
    if (operation === "SubmitReview") {
      if (record.state !== "Draft") return "Submission requires a Draft.";
      if (reviewContent.templateVersionReference !== current.current.templateVersionReference)
        return "Create a Draft for the current saved content before submitting.";
      let deadline: string | null;
      try {
        deadline = utc(review);
      } catch {
        return "Enter a valid review deadline in UTC.";
      }
      if (!deadline || Date.parse(deadline) <= Date.now())
        return "Choose a future review deadline.";
      if (reviewContent.content.effectiveUntil && deadline > reviewContent.content.effectiveUntil)
        return "The review deadline must not exceed the template's effective end.";
      return null;
    }
    if (
      operation !== "Archive" &&
      (!record.reviewValidUntil || Date.parse(record.reviewValidUntil) <= Date.now())
    )
      return "The original review expired. Start a new Draft and review; its recorded deadline cannot be extended.";
    if (operation === "Approve") {
      if (record.state !== "InReview") return "Independent approval requires an InReview version.";
      if (
        record.authoredActorReference === scope.actorReference ||
        record.submittedActorReference === scope.actorReference
      )
        return "The author and submitter cannot approve their own review.";
    }
    if (operation === "Publish" && record.state !== "Approved")
      return "Publication requires an independently Approved version.";
    if (operation === "Archive" && record.state !== "Published")
      return "Archive requires a Published version.";
    if (operation === "Archive" && !archiveConfirmed)
      return "Confirm that you want to archive the selected publication.";
    return null;
  }
  const permissionFor = {
    CreateDraft: "platform.brand-template.manage",
    SubmitReview: "platform.brand-template.submit",
    Approve: "platform.brand-template.approve",
    Publish: "platform.brand-template.publish",
    Archive: "platform.brand-template.archive",
  } as const;
  function publish(operation: Operation) {
    if (!allowed(permissionFor[operation]) || blocked(operation)) return;
    void work(async (w) => {
      let source = publication?.current ?? null;
      const content = operation === "CreateDraft" ? current?.current : reviewContent;
      if (!selected || !content) throw new PlatformTemplateClientError("Invalid");
      // Creating a new cycle pins the actual selected head, not an older review.
      if (operation === "CreateDraft") {
        const head = await client.publicationCurrent(scope, selected, null, w.controls);
        w.check();
        source = head.current;
      }
      const prepared = await client.preparePublication(scope, {
        profile: "PlatformPublishingRequestV1",
        operation,
        operationReference: serviceOperationReference(),
        templateReference: selected,
        templateVersionReference: content.templateVersionReference,
        contentDigest: content.contentDigest,
        templateSourceDigest: content.sourceDigest,
        expectedLifecycle: source
          ? {
              lifecycleReference: source.command.next.lifecycleId,
              version: source.command.next.version,
              sourceDigest: source.sourceDigest,
            }
          : null,
        reviewValidUntil: operation === "SubmitReview" ? utc(review) : null,
        reasonCode: reason,
      });
      w.check();
      await dispatch(
        w,
        prepared,
        () =>
          allowed(permissionFor[operation]) &&
          (operation === "Archive" ||
            operation === "CreateDraft" ||
            (operation === "SubmitReview"
              ? Date.parse(utc(review) ?? "") > Date.now()
              : Date.parse(source?.command.next.reviewValidUntil ?? "") > Date.now())),
      );
    });
  }
  const labels: Record<Operation, string> = {
    CreateDraft: "Create publication Draft",
    SubmitReview: "Submit for review",
    Approve: "Approve independently",
    Publish: "Publish template",
    Archive: "Archive publication",
  };
  const edit = (field: keyof Form, value: string) => {
    setForm((v) => ({ ...v, [field]: value }));
    setDirty(true);
  };
  const error = (field: keyof Form) =>
    submitted && errors[field] ? (
      <p id={`template-${field}-error`} role="alert">
        {errors[field]}
      </p>
    ) : null;
  const invalid = (field: keyof Form) => ({
    "aria-invalid": submitted && !!errors[field],
    "aria-describedby": submitted && errors[field] ? `template-${field}-error` : undefined,
  });
  const record = publication?.current?.command.next;
  return (
    <section aria-labelledby="platform-template-title">
      <h2 id="platform-template-title">Templates</h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {!online ? <p>Offline. Saved originals will be retained until access is restored.</p> : null}
      <div className="card-actions">
        <button
          type="button"
          disabled={busy || !online}
          onClick={() =>
            void work(async (w) => {
              setPending(await journal.load());
              w.check();
              await refresh(w, selected, lifecycle, dirty || creating, true);
            })
          }
        >
          Refresh templates
        </button>
        {pending ? (
          <button
            type="button"
            disabled={busy || !online}
            onClick={() => void work((w) => recover(w, pending))}
          >
            Recover original request
          </button>
        ) : null}
        {allowed("platform.brand-template.manage") ? (
          <button
            type="button"
            disabled={busy || !!pending || !fresh()}
            onClick={() => {
              setSelected(null);
              setLifecycle(null);
              setCurrent(null);
              setHistory(null);
              setPublication(null);
              setPublicationHistory(null);
              setReviewContent(null);
              setCreating(true);
              setForm(emptyForm());
              setDirty(false);
              setSubmitted(false);
              setReview("");
              setReason("");
            }}
          >
            New template
          </button>
        ) : null}
      </div>
      {!fresh() && actions ? (
        <p>
          Refresh templates before a new action. Edited fields and the chosen review deadline are
          preserved.
        </p>
      ) : null}
      {listing ? (
        <section aria-labelledby="template-list-title">
          <h3 id="template-list-title">Saved templates</h3>
          <p>This list shows authored content. Approval and publication are shown separately.</p>
          {listing.items.length ? (
            <ul>
              {listing.items.map((item) => (
                <li key={item.templateReference}>
                  <button
                    type="button"
                    disabled={busy || !!pending || !online}
                    onClick={() =>
                      void work(async (w) => {
                        await readSelected(w, item.templateReference, null, false);
                        const a = await client.actions(scope, w.controls);
                        w.check();
                        setActions(a);
                        setMessage("Saved template and publication state loaded.");
                      })
                    }
                  >
                    Open {item.name} ({item.code})
                  </button>{" "}
                  · Saved version {item.revision}
                </li>
              ))}
            </ul>
          ) : (
            <p>No saved templates.</p>
          )}
          <button
            type="button"
            disabled={busy || !online || !listing.nextCursor}
            onClick={() =>
              void work(async (w) => {
                const page = await client.list(scope, listing.nextCursor, 20, w.controls);
                w.check();
                setListing(page);
              })
            }
          >
            More saved templates
          </button>
        </section>
      ) : null}
      {(creating || current?.current) && allowed("platform.brand-template.manage") ? (
        <section aria-labelledby="template-editor-title">
          <h3 id="template-editor-title">
            {creating ? "New template content" : "Edit saved template content"}
          </h3>
          {current?.current ? (
            <p>Saved content version {current.current.revision}. Saving does not publish it.</p>
          ) : (
            <p>No content has been saved for this new template.</p>
          )}
          <fieldset disabled={busy || !!pending || !online}>
            <legend>Template content</legend>
            <label>
              Template code
              <input
                value={form.code}
                maxLength={64}
                readOnly={!creating}
                onChange={(e) => edit("code", e.target.value)}
                {...invalid("code")}
              />
            </label>
            {error("code")}
            {!creating ? <p>The saved template code is permanent.</p> : null}
            <label>
              Template name
              <input
                value={form.name}
                maxLength={160}
                onChange={(e) => edit("name", e.target.value)}
                {...invalid("name")}
              />
            </label>
            {error("name")}
            <label>
              Supported locales
              <textarea
                value={form.supportedLocales}
                onChange={(e) => edit("supportedLocales", e.target.value)}
                {...invalid("supportedLocales")}
              />
            </label>
            {error("supportedLocales")}
            <label>
              Default locale
              <select
                value={form.defaultLocale}
                onChange={(e) => edit("defaultLocale", e.target.value)}
                {...invalid("defaultLocale")}
              >
                <option value="">Choose a supported locale</option>
                {[...new Set(values(form.supportedLocales))]
                  .filter((v) => localePattern.test(v))
                  .map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
              </select>
            </label>
            {error("defaultLocale")}
            <label>
              Permitted override fields
              <textarea
                value={form.overrideAllowedFieldCodes}
                onChange={(e) => edit("overrideAllowedFieldCodes", e.target.value)}
                {...invalid("overrideAllowedFieldCodes")}
              />
            </label>
            {error("overrideAllowedFieldCodes")}
            <label>
              Hard requirement fields
              <textarea
                value={form.hardRequirementFieldCodes}
                onChange={(e) => edit("hardRequirementFieldCodes", e.target.value)}
                {...invalid("hardRequirementFieldCodes")}
              />
            </label>
            {error("hardRequirementFieldCodes")}
            <p>
              Enter distinct locale or field codes separated by commas. A hard requirement cannot
              also permit an override.
            </p>
            <label>
              Effective from (UTC)
              <input
                type="datetime-local"
                step="0.001"
                value={form.effectiveFrom}
                onChange={(e) => edit("effectiveFrom", e.target.value)}
                {...invalid("effectiveFrom")}
              />
            </label>
            {error("effectiveFrom")}
            <label>
              Effective until (UTC, blank means open)
              <input
                type="datetime-local"
                step="0.001"
                value={form.effectiveUntil}
                onChange={(e) => edit("effectiveUntil", e.target.value)}
                {...invalid("effectiveUntil")}
              />
            </label>
            {error("effectiveUntil")}
            <label>
              Content reason code
              <input
                value={form.reasonCode}
                maxLength={64}
                onChange={(e) => edit("reasonCode", e.target.value)}
                {...invalid("reasonCode")}
              />
            </label>
            {error("reasonCode")}
          </fieldset>
          <button type="button" disabled={busy || !!pending || !fresh()} onClick={save}>
            Save template content
          </button>
          {current?.current ? (
            <button
              type="button"
              disabled={busy || !!pending || !dirty}
              onClick={() => {
                if (current.current) setForm(formFor(current.current.content));
                setDirty(false);
                setSubmitted(false);
              }}
            >
              Discard unsaved changes
            </button>
          ) : null}
        </section>
      ) : current?.current ? (
        <section>
          <h3>Saved template content</h3>
          <p>Saved version {current.current.revision}</p>
          <ContentDetails content={current.current.content} />
        </section>
      ) : null}
      {current?.current ? (
        <section aria-labelledby="template-publication-title">
          <h3 id="template-publication-title">Review and publication</h3>
          <p>
            Selected publication state: {record?.state ?? "No Draft"}
            {record ? ` · lifecycle version ${record.version}` : ""}.
          </p>
          {reviewContent ? (
            <>
              <p>
                Selected review content: {reviewContent.content.name} · saved version{" "}
                {reviewContent.revision}.
              </p>
              <ContentDetails content={reviewContent.content} />
            </>
          ) : null}
          <p>
            Current release:{" "}
            {publication?.currentRelease
              ? `Published · release ${publication.currentRelease.command.release?.sequence}`
              : "None"}
            .
          </p>
          {record?.reviewValidUntil ? (
            <p>
              Original review valid until (UTC):{" "}
              <time dateTime={record.reviewValidUntil}>{record.reviewValidUntil}</time>.{" "}
              {Date.parse(record.reviewValidUntil) <= Date.now()
                ? "Review expired. Approval and publication are unavailable; recorded history and original recovery remain available."
                : "Approval and publication must finish before this deadline."}
            </p>
          ) : null}
          <label>
            Publication reason code
            <input
              value={reason}
              maxLength={64}
              disabled={busy || !!pending || !online}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {allowed("platform.brand-template.submit") ? (
            <label>
              Review valid until (UTC)
              <input
                type="datetime-local"
                step="0.001"
                value={review}
                disabled={busy || !!pending || !online}
                onChange={(e) => setReview(e.target.value)}
              />
            </label>
          ) : null}
          <p>
            Save content first, then create a publication Draft. Submission, independent approval
            and publication are separate actions.
          </p>
          {record?.state === "Published" && allowed("platform.brand-template.archive") ? (
            <>
              <p>
                {publication?.currentRelease?.command.next.lifecycleId === record.lifecycleId
                  ? "This is the current release. Archiving removes it from current publication; saved content and history remain."
                  : "Archiving this older publication retains the separate current release and all history."}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={archiveConfirmed}
                  disabled={busy || !!pending || !online}
                  onChange={(e) => setArchiveConfirmed(e.target.checked)}
                />
                Confirm archive of this publication
              </label>
            </>
          ) : null}
          <div className="card-actions">
            {(["CreateDraft", "SubmitReview", "Approve", "Publish", "Archive"] as const)
              .filter((operation) => allowed(permissionFor[operation]))
              .map((operation) => (
                <div key={operation}>
                  <button
                    type="button"
                    disabled={!!blocked(operation)}
                    aria-describedby={
                      blocked(operation) ? `template-block-${operation}` : undefined
                    }
                    onClick={() => publish(operation)}
                  >
                    {labels[operation]}
                  </button>
                  {blocked(operation) ? (
                    <p id={`template-block-${operation}`}>{blocked(operation)}</p>
                  ) : null}
                </div>
              ))}
          </div>
          {publicationHistory ? (
            <>
              <h4>Publication history</h4>
              <ul>
                {publicationHistory.items.map((item) => (
                  <li key={item.sequence}>
                    Sequence {item.sequence} · {item.command.next.state} ·{" "}
                    <time dateTime={item.command.occurredAt}>{item.command.occurredAt}</time>{" "}
                    <button
                      type="button"
                      disabled={busy || !!pending || !online}
                      onClick={() =>
                        void work(async (w) => {
                          if (!selected) throw new PlatformTemplateClientError("Invalid");
                          await readSelected(w, selected, item.command.next.lifecycleId, false);
                          const a = await client.actions(scope, w.controls);
                          w.check();
                          setActions(a);
                          setMessage("Selected lifecycle and its immutable content loaded.");
                        })
                      }
                    >
                      Open {item.command.next.state} lifecycle from sequence {item.sequence}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy || !online || !publicationHistory.nextBeforeSequence}
                onClick={() =>
                  void work(async (w) => {
                    if (!selected) return;
                    const page = await client.publicationHistory(
                      scope,
                      selected,
                      publicationHistory.nextBeforeSequence,
                      w.controls,
                    );
                    w.check();
                    setPublicationHistory(page);
                  })
                }
              >
                Older publication history
              </button>
            </>
          ) : null}
        </section>
      ) : null}
      {history ? (
        <section aria-labelledby="template-content-history-title">
          <h3 id="template-content-history-title">Authored content history</h3>
          <ul>
            {history.entries.map((item) => (
              <li key={item.revision}>
                Saved version {item.revision} · {item.content.name} ·{" "}
                <time dateTime={item.recordedAt}>{item.recordedAt}</time>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy || !online || !history.nextBeforeRevision}
            onClick={() =>
              void work(async (w) => {
                if (!selected) return;
                const page = await client.history(
                  scope,
                  selected,
                  history.nextBeforeRevision,
                  w.controls,
                );
                w.check();
                setHistory(page);
              })
            }
          >
            Older authored versions
          </button>
        </section>
      ) : null}
      <p>Template assignment and Theme selection are subsequent Brand setup steps.</p>
    </section>
  );
}
