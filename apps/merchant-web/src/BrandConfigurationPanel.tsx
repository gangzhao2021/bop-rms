import { useEffect, useMemo, useRef, useState } from "react";
import { wordGap } from "./word-gap.js";
import {
  BrandConfigurationClientError,
  createMerchantBrandConfigurationClient,
  parseBrandConfigurationScope,
  parseBrandConfigurationEditable,
  parseBrandTemplateCandidate,
  brandConfigurationEditableFields,
  type BrandConfigurationScope,
  type BrandConfigurationCurrent,
  type BrandConfigurationHistory,
  type BrandConfigurationOriginal,
  type PreparedBrandConfigurationCommand,
  type BrandConfigurationAction,
  type BrandConfigurationEditable,
  type BrandTemplateCandidate,
  type BrandTemplateCandidates,
} from "./merchant-brand-configuration-client.js";
import {
  createBrandConfigurationPendingJournal,
  type BrandConfigurationPendingJournal,
} from "./brand-configuration-pending-journal.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import {
  createMerchantBrandCatalogSourceClient,
  type BrandCatalogSourceCurrent,
} from "./merchant-brand-catalog-source-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { brandChangeDeniedText } from "./access-denied.js";
import { t } from "./i18n/i18n.js";
export interface BrandConfigurationPanelProps {
  readonly scope: BrandConfigurationScope;
  readonly csrf: string;
  readonly brandVersion: number;
  readonly client?: ReturnType<typeof createMerchantBrandConfigurationClient>;
  readonly catalogueClient?: Pick<
    ReturnType<typeof createMerchantBrandCatalogSourceClient>,
    "current"
  >;
  readonly journalFactory?: (scope: BrandConfigurationScope) => BrandConfigurationPendingJournal;
  readonly freshDisabled?: boolean;
}
type Client = ReturnType<typeof createMerchantBrandConfigurationClient>;
/** Both versions are observed owner values. Never predict a next version. */
export function brandConfigurationExpectedBrandVersion(bootstrap: number, recorded?: number) {
  const valid = (value: number) => Number.isInteger(value) && value >= 1 && value <= 2147483647;
  if (!valid(bootstrap) || (recorded !== undefined && !valid(recorded)))
    throw new BrandConfigurationClientError("Invalid");
  return Math.max(bootstrap, recorded ?? bootstrap);
}
const refuse = (): never => {
  throw new BrandConfigurationClientError("ScopeChanged");
};
export async function recoverBrandConfigurationOriginal(input: {
  client: Client;
  journal: BrandConfigurationPendingJournal;
  original: BrandConfigurationOriginal;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}) {
  const check = () => {
    if (!input.isCurrent() || input.signal.aborted) refuse();
  };
  check();
  const controls = { csrf: input.csrf, signal: input.signal },
    receipt = await input.client.resolve(input.original, controls);
  check();
  const reobserved = await input.client.resolve(input.original, controls);
  check();
  const scope = parseBrandConfigurationScope({
      tenantReference: input.original.tenantReference,
      brandReference: input.original.brandReference,
      actorReference: input.original.actorReference,
    }),
    current = await input.client.current(scope, controls);
  check();
  const history = await input.client.history(scope, null, controls);
  check();
  await input.journal.complete(input.original, receipt, reobserved, current, history);
  check();
  return { receipt, current, history };
}
export async function executeBrandConfigurationOriginal(input: {
  client: Client;
  journal: BrandConfigurationPendingJournal;
  prepared: PreparedBrandConfigurationCommand;
  csrf: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  canDispatch: () => boolean;
  onReserved: (original: BrandConfigurationOriginal) => void;
}) {
  const check = () => {
    if (!input.isCurrent() || input.signal.aborted) refuse();
  };
  check();
  await input.journal.reserve(input.prepared.original);
  input.onReserved(input.prepared.original);
  check();
  const held = await input.journal.load();
  check();
  if (canonical(held) !== canonical(input.prepared.original))
    throw new BrandConfigurationClientError("Conflict");
  if (
    !input.canDispatch() ||
    (input.prepared.command.reviewValidUntil !== null &&
      Date.now() >= Date.parse(input.prepared.command.reviewValidUntil))
  )
    throw new BrandConfigurationClientError("Conflict");
  await input.client.execute(input.prepared, { csrf: input.csrf, signal: input.signal });
  check();
  return recoverBrandConfigurationOriginal({ ...input, original: input.prepared.original });
}
const messages: Record<BrandConfigurationClientError["code"], string> = {
  Invalid: t("The request is invalid. Check the configuration fields."),
  // Batch 38: the refusal staff can reach here is worded and translated with the others.
  Denied: brandChangeDeniedText,
  Conflict: t(
    "Someone else changed this brand's configuration. Recover the change still waiting here, then refresh before making a new one.",
  ),
  Unavailable: t(
    "The configuration can't be read just now. Refresh, or recover the change still waiting here.",
  ),
  OutcomeUnknown: t(
    "It isn't known whether your change was saved. Recover it here; don't send it again.",
  ),
  ScopeChanged: t(
    "The brand or the person signed in changed. Go back to the brand and sign-in you started with to recover that change.",
  ),
  Stale: t("What's on screen is out of date. Refresh before making a new change."),
};
/** Batch 40: a configuration's state in staff words, in either language. */
const lifecycleText = (
  lifecycle: NonNullable<BrandConfigurationCurrent["current"]>["configuration"]["lifecycle"],
): string =>
  ({
    Draft: t("Draft"),
    PendingApproval: t("Waiting for approval"),
    Approved: t("Approved"),
    Published: t("Published"),
    Superseded: t("Replaced by a newer version"),
    Archived: t("Archived"),
  })[lifecycle];
const editable = (current: BrandConfigurationCurrent): BrandConfigurationEditable | null =>
  current.current
    ? parseBrandConfigurationEditable(
        Object.fromEntries(
          brandConfigurationEditableFields.map((k) => [k, current.current?.configuration[k]]),
        ),
      )
    : null;
const utc = (value: string): string | null =>
  value === "" ? null : new Date(value + "Z").toISOString();
export function createInitialBrandConfigurationDraft(input: {
  candidate: BrandTemplateCandidate;
  catalogSourceReference: string;
  defaultLocale: string;
  supportedLocales: readonly string[];
  overrideAllowedFieldCodes: readonly string[];
  effectiveFrom: string;
  effectiveUntil: string;
  reasonCode: string;
}): BrandConfigurationEditable {
  const candidate = parseBrandTemplateCandidate(input.candidate),
    from = utc(input.effectiveFrom),
    until = utc(input.effectiveUntil);
  if (
    !from ||
    !input.reasonCode ||
    from < candidate.effectiveFrom ||
    (candidate.effectiveUntil !== null && (until === null || until > candidate.effectiveUntil)) ||
    input.supportedLocales.some((value) => !candidate.supportedLocales.includes(value)) ||
    input.overrideAllowedFieldCodes.some(
      (value) => !candidate.overrideAllowedFieldCodes.includes(value),
    )
  )
    throw new BrandConfigurationClientError("Invalid");
  return parseBrandConfigurationEditable({
    defaultLocale: input.defaultLocale,
    supportedLocales: input.supportedLocales,
    overrideAllowedFieldCodes: input.overrideAllowedFieldCodes,
    hardRequirementFieldCodes: input.candidate.hardRequirementFieldCodes,
    mediaThemeReference: null,
    catalogSourceReference: input.catalogSourceReference,
    platformTemplateReference: input.candidate.templateVersionReference,
    effectiveFrom: from,
    effectiveUntil: until,
    reasonCode: input.reasonCode,
  });
}
/** Refresh only genuine current pages; an old candidate packet cannot renew its lease. */
export async function refreshBrandTemplateSelection(input: {
  client: Pick<Client, "templates">;
  scope: BrandConfigurationScope;
  selectedAfterTemplateReference: string | null;
  csrf: string;
  signal: AbortSignal;
}) {
  const controls = { csrf: input.csrf, signal: input.signal },
    first = await input.client.templates(input.scope, null, controls),
    selected =
      input.selectedAfterTemplateReference === null
        ? first
        : await input.client.templates(input.scope, input.selectedAfterTemplateReference, controls),
    pages = selected === first ? [first] : [first, selected],
    items = [
      ...new Map(
        pages.flatMap((page) => page.items.map((item) => [item.templateReference, item] as const)),
      ).values(),
    ];
  return {
    pages,
    candidates: {
      ...first,
      items,
      observedAt: first.observedAt,
      validUntil: new Date(
        Math.min(...pages.map((page) => Date.parse(page.validUntil))),
      ).toISOString(),
    },
  };
}
export function BrandConfigurationPanel({
  scope: rawScope,
  csrf,
  brandVersion,
  client: injected,
  catalogueClient: injectedCatalogue,
  journalFactory = createBrandConfigurationPendingJournal,
  freshDisabled = false,
}: BrandConfigurationPanelProps) {
  const key = canonical(parseBrandConfigurationScope(rawScope)),
    scope = useMemo(() => parseBrandConfigurationScope(rawScope), [key]),
    client = useMemo(() => injected ?? createMerchantBrandConfigurationClient(), [injected]),
    catalogueClient = useMemo(
      () => injectedCatalogue ?? createMerchantBrandCatalogSourceClient(),
      [injectedCatalogue],
    ),
    journal = useMemo(() => journalFactory(scope), [journalFactory, key]);
  const [current, setCurrent] = useState<BrandConfigurationCurrent | null>(null),
    [history, setHistory] = useState<BrandConfigurationHistory | null>(null),
    [draft, setDraft] = useState<BrandConfigurationEditable | null>(null),
    [pending, setPending] = useState<BrandConfigurationOriginal | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(() => t("Load the current saved configuration.")),
    [online, setOnline] = useState(typeof navigator === "undefined" || navigator.onLine),
    [fresh, setFresh] = useState(false),
    [review, setReview] = useState(""),
    [candidates, setCandidates] = useState<BrandTemplateCandidates | null>(null),
    [catalogue, setCatalogue] = useState<BrandCatalogSourceCurrent | null>(null),
    [selectedVersion, setSelectedVersion] = useState(""),
    [firstFrom, setFirstFrom] = useState(""),
    [firstUntil, setFirstUntil] = useState(""),
    [firstReason, setFirstReason] = useState(""),
    [firstLocale, setFirstLocale] = useState(""),
    [firstLocales, setFirstLocales] = useState<readonly string[]>([]),
    [firstOverrides, setFirstOverrides] = useState<readonly string[]>([]);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    running = useRef(false),
    edits = useRef(0),
    draftRef = useRef(draft),
    disabled = useRef(freshDisabled),
    actualBrandVersion = useRef(brandVersion),
    templatePageCursors = useRef(new Map<string, string | null>()),
    selectedPageCursor = useRef<string | null>(null);
  draftRef.current = draft;
  disabled.current = freshDisabled;
  actualBrandVersion.current = brandVersion;
  const explain = (error: unknown) =>
    setMessage(
      error instanceof BrandConfigurationClientError ? messages[error.code] : messages.Unavailable,
    );
  const adopt = (next: BrandConfigurationCurrent, page: BrandConfigurationHistory) => {
    setCurrent(next);
    setHistory(page);
    setFresh(Date.now() < Date.parse(next.validUntil) && Date.now() < Date.parse(page.validUntil));
    setDraft(editable(next));
  };
  async function load() {
    if (running.current || !online) return;
    running.current = true;
    setBusy(true);
    const epoch = generation.current,
      active = new AbortController();
    controller.current = active;
    try {
      const original = await journal.load();
      if (epoch !== generation.current || active.signal.aborted) return;
      setPending(original);
      const next = await client.current(scope, { csrf, signal: active.signal }),
        page = await client.history(scope, null, { csrf, signal: active.signal }),
        refreshed = await refreshBrandTemplateSelection({
          client,
          scope,
          selectedAfterTemplateReference: selectedPageCursor.current,
          csrf,
          signal: active.signal,
        }),
        templates = refreshed.candidates,
        registry = await catalogueClient.current(scope, { csrf, signal: active.signal });
      if (epoch !== generation.current || active.signal.aborted) return;
      templatePageCursors.current.clear();
      for (const observed of refreshed.pages)
        for (const item of observed.items)
          templatePageCursors.current.set(
            item.templateVersionReference,
            observed.afterTemplateReference,
          );
      setCandidates(templates);
      setCatalogue(registry);
      const keep =
        draftRef.current && current && canonical(draftRef.current) !== canonical(editable(current));
      setCurrent(next);
      setHistory(page);
      setFresh(
        Date.now() < Date.parse(next.validUntil) && Date.now() < Date.parse(page.validUntil),
      );
      if (!keep) setDraft(editable(next));
      setMessage(
        original
          ? t("A change is still waiting to be confirmed. Recover it before making a new one.")
          : next.current
            ? t("Saved configuration loaded.")
            : t(
                "No configuration has been saved. A published platform template and registered catalogue are required to create one.",
              ),
      );
    } catch (error) {
      if (epoch === generation.current && !active.signal.aborted) {
        setFresh(false);
        explain(error);
      }
    } finally {
      if (epoch === generation.current && !active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    generation.current++;
    running.current = false;
    setCurrent(null);
    setHistory(null);
    setDraft(null);
    setPending(null);
    setFresh(false);
    setReview("");
    setCandidates(null);
    templatePageCursors.current.clear();
    selectedPageCursor.current = null;
    setCatalogue(null);
    setSelectedVersion("");
    setFirstFrom("");
    setFirstUntil("");
    setFirstReason("");
    setFirstLocale("");
    setFirstLocales([]);
    setFirstOverrides([]);
    void load();
    return () => {
      generation.current++;
      controller.current?.abort();
      running.current = false;
    };
  }, [key, csrf, client, catalogueClient, journal]);
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) {
        setFresh(false);
        controller.current?.abort();
        running.current = false;
        setBusy(false);
      }
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!current || !history) return;
    const timer = setTimeout(
      () => {
        setFresh(false);
        setMessage(messages.Stale);
      },
      Math.max(
        0,
        Math.min(
          Date.parse(current.validUntil),
          Date.parse(history.validUntil),
          candidates ? Date.parse(candidates.validUntil) : Infinity,
          catalogue ? Date.parse(catalogue.validUntil) : Infinity,
        ) - Date.now(),
      ),
    );
    return () => clearTimeout(timer);
  }, [current, history, candidates, catalogue]);
  function edit(update: Partial<BrandConfigurationEditable>) {
    edits.current++;
    setDraft((v) => (v ? { ...v, ...update } : v));
  }
  const candidate = candidates?.items.find(
    (item) =>
      item.templateVersionReference === (draft?.platformTemplateReference ?? selectedVersion),
  );
  const referenceFresh = () =>
    !!candidates &&
    !!catalogue &&
    Date.now() >= Date.parse(candidates.observedAt) &&
    Date.now() < Date.parse(candidates.validUntil) &&
    Date.now() >= Date.parse(catalogue.observedAt) &&
    Date.now() < Date.parse(catalogue.validUntil);
  function firstDraft(): BrandConfigurationEditable | null {
    if (!candidate || !catalogue?.source) return null;
    try {
      return createInitialBrandConfigurationDraft({
        candidate,
        catalogSourceReference: catalogue.source.sourceReference,
        defaultLocale: firstLocale,
        supportedLocales: firstLocales,
        overrideAllowedFieldCodes: firstOverrides,
        effectiveFrom: firstFrom,
        effectiveUntil: firstUntil,
        reasonCode: firstReason,
      });
    } catch {
      return null;
    }
  }
  function chooseTemplate(version: string) {
    if (busy || pending || freshDisabled) return;
    const selected = candidates?.items.find((item) => item.templateVersionReference === version);
    edits.current++;
    setSelectedVersion(version);
    selectedPageCursor.current = templatePageCursors.current.get(version) ?? null;
    if (selected) {
      if (draft)
        setDraft({
          ...draft,
          platformTemplateReference: version,
          defaultLocale: selected.defaultLocale,
          supportedLocales: [selected.defaultLocale],
          overrideAllowedFieldCodes: [],
          hardRequirementFieldCodes: selected.hardRequirementFieldCodes,
        });
      else {
        setFirstLocale(selected.defaultLocale);
        setFirstLocales([selected.defaultLocale]);
        setFirstOverrides([]);
      }
    }
  }
  async function moreTemplates() {
    if (
      running.current ||
      !online ||
      !candidates?.hasMore ||
      !candidates.nextAfterTemplateReference
    )
      return;
    running.current = true;
    setBusy(true);
    const epoch = generation.current,
      active = new AbortController();
    controller.current = active;
    try {
      // Reobserve the selected page too: never renew old candidates with a later page's lease.
      const first = await client.templates(scope, null, { csrf, signal: active.signal }),
        next = await client.templates(scope, candidates.nextAfterTemplateReference, {
          csrf,
          signal: active.signal,
        });
      if (epoch !== generation.current || active.signal.aborted) return;
      for (const observed of [first, next])
        for (const item of observed.items)
          templatePageCursors.current.set(
            item.templateVersionReference,
            observed.afterTemplateReference,
          );
      const items = [
        ...new Map(
          [...candidates.items, ...first.items, ...next.items].map((item) => [
            item.templateReference,
            item,
          ]),
        ).values(),
      ];
      setCandidates({
        ...next,
        items,
        observedAt: candidates.observedAt,
        validUntil: new Date(
          Math.min(
            Date.parse(candidates.validUntil),
            Date.parse(first.validUntil),
            Date.parse(next.validUntil),
          ),
        ).toISOString(),
      });
    } catch (error) {
      if (epoch === generation.current && !active.signal.aborted) {
        setFresh(false);
        explain(error);
      }
    } finally {
      if (epoch === generation.current && !active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function act(command: BrandConfigurationAction) {
    if (
      running.current ||
      pending ||
      !online ||
      disabled.current ||
      !fresh ||
      !current ||
      (command !== "SaveConfigurationDraft" && !current.current) ||
      (command === "SaveConfigurationDraft" && (!candidate || !referenceFresh()))
    )
      return;
    running.current = true;
    setBusy(true);
    const epoch = generation.current,
      editVersion = edits.current,
      active = new AbortController();
    controller.current = active;
    const isCurrent = () => epoch === generation.current && !active.signal.aborted;
    try {
      const saved = current.current,
        editableDraft = saved ? draft : firstDraft();
      if (command === "SaveConfigurationDraft" && !editableDraft)
        throw new BrandConfigurationClientError("Invalid");
      const prepared = await client.prepare({
        profile: "TenantBrandConfigurationCommandV1",
        ...scope,
        command,
        operationReference: serviceOperationReference(),
        expectedBrandVersion: brandConfigurationExpectedBrandVersion(
          brandVersion,
          saved?.brandVersion,
        ),
        expectedHead: saved
          ? {
              revision: saved.revision,
              configurationVersionReference: saved.configuration.configurationVersionReference,
              sourceDigest: saved.sourceDigest,
            }
          : null,
        purposeCode: "BRAND_CONFIGURATION",
        configuration: command === "SaveConfigurationDraft" ? editableDraft : null,
        reviewValidUntil: command === "SubmitConfiguration" ? utc(review) : null,
      });
      if (!isCurrent()) refuse();
      const result = await executeBrandConfigurationOriginal({
        client,
        journal,
        prepared,
        csrf,
        signal: active.signal,
        isCurrent,
        canDispatch: () =>
          !disabled.current &&
          actualBrandVersion.current === brandVersion &&
          online &&
          editVersion === edits.current &&
          (!(command === "ApproveConfiguration" || command === "PublishConfiguration") ||
            (!!current.recordedReview &&
              Date.now() < Date.parse(current.recordedReview.reviewValidUntil))) &&
          Date.now() < Date.parse(current.validUntil) &&
          (command !== "SaveConfigurationDraft" || referenceFresh()),
        onReserved: (original) => {
          if (isCurrent()) setPending(original);
        },
      });
      if (!isCurrent()) return;
      setPending(null);
      adopt(result.current, result.history);
      setMessage(
        result.receipt.outcome === "Committed"
          ? t("Configuration updated and refreshed.")
          : t("The previous operation did not apply changes. Refresh before trying again."),
      );
    } catch (error) {
      if (isCurrent()) {
        setFresh(false);
        explain(error);
      }
    } finally {
      if (isCurrent()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function recover() {
    if (running.current || !pending || !online) return;
    running.current = true;
    setBusy(true);
    const epoch = generation.current,
      active = new AbortController();
    controller.current = active;
    try {
      const result = await recoverBrandConfigurationOriginal({
        client,
        journal,
        original: pending,
        csrf,
        signal: active.signal,
        isCurrent: () => epoch === generation.current && !active.signal.aborted,
      });
      if (epoch !== generation.current || active.signal.aborted) return;
      setPending(null);
      adopt(result.current, result.history);
      setMessage(
        result.receipt.outcome === "Committed"
          ? t("Previous operation confirmed. Current configuration refreshed.")
          : t("The previous operation did not apply changes. You can try again."),
      );
    } catch (error) {
      if (epoch === generation.current && !active.signal.aborted) explain(error);
    } finally {
      if (epoch === generation.current && !active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function older() {
    if (running.current || !history?.nextBeforeRevision || !online) return;
    running.current = true;
    setBusy(true);
    const epoch = generation.current,
      active = new AbortController();
    controller.current = active;
    try {
      const page = await client.history(scope, history.nextBeforeRevision, {
        csrf,
        signal: active.signal,
      });
      if (epoch !== generation.current || active.signal.aborted) return;
      setHistory(page);
    } catch (error) {
      if (epoch === generation.current && !active.signal.aborted) explain(error);
    } finally {
      if (epoch === generation.current && !active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const saved = current?.current,
    canFresh = !!current && fresh && online && !busy && !pending && !freshDisabled,
    canSave = canFresh && !!candidate && referenceFresh() && !!(saved ? draft : firstDraft()),
    unchanged = !!current && !!draft && canonical(draft) === canonical(editable(current));
  return (
    <section aria-labelledby="brand-configuration-title">
      <h2 id="brand-configuration-title">{t("Brand configuration")}</h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {!online ? (
        <p>
          {t("Offline. A change still waiting stays on this device until it can be recovered.")}
        </p>
      ) : null}
      <div className="card-actions">
        <button disabled={busy || !online} onClick={() => void load()}>
          {t("Refresh configuration")}
        </button>
        {pending ? (
          <button disabled={busy || !online} onClick={() => void recover()}>
            {t("Recover original request")}
          </button>
        ) : null}
      </div>
      {current ? (
        <fieldset disabled={busy || !!pending || freshDisabled || !online}>
          <legend>{t("Published platform template")}</legend>
          <label>
            {t("Platform template")}
            <select
              value={draft?.platformTemplateReference ?? selectedVersion}
              onChange={(e) => chooseTemplate(e.target.value)}
            >
              <option value="">{t("Choose a current published template")}</option>
              {draft && !candidate ? (
                <option value={draft.platformTemplateReference}>
                  {t("Recorded template — unavailable for new selection")}
                </option>
              ) : null}
              {!draft && selectedVersion && !candidate ? (
                <option value={selectedVersion}>
                  {t("Previously selected template — unavailable for new selection")}
                </option>
              ) : null}
              {candidates?.items.map((item) => (
                <option key={item.templateVersionReference} value={item.templateVersionReference}>
                  {item.code} — {item.name}
                </option>
              ))}
            </select>
          </label>
          {candidate ? (
            <div>
              <p>
                {t("{code}: {name}. Content revision {revision}.", {
                  code: candidate.code,
                  name: candidate.name,
                  revision: candidate.revision,
                })}
              </p>
              <p>
                {t(
                  "Locales: {locales}. Hard requirements: {required}. Allowed overrides: {overrides}.",
                  {
                    locales: candidate.supportedLocales.join(", "),
                    required: candidate.hardRequirementFieldCodes.join(", ") || t("none"),
                    overrides: candidate.overrideAllowedFieldCodes.join(", ") || t("none"),
                  },
                )}
              </p>
              <p>
                {t("Template effective from {from}; until {until}.", {
                  from: candidate.effectiveFrom,
                  until: candidate.effectiveUntil ?? t("open"),
                })}
              </p>
            </div>
          ) : (
            <p>
              {t(
                "No current published template selected. A recorded historical link is preserved until you explicitly choose another.",
              )}
            </p>
          )}
          {candidates?.hasMore ? (
            <button type="button" onClick={() => void moreTemplates()}>
              {t("More published templates")}
            </button>
          ) : null}
        </fieldset>
      ) : null}
      {current && !saved && candidate ? (
        <fieldset disabled={busy || !!pending || freshDisabled || !online}>
          <legend>{t("Create configuration draft")}</legend>
          <p>
            {catalogue?.source
              ? t("Catalogue: {catalogue}. Theme: not configured.", {
                  catalogue: `${catalogue.source.code} — ${catalogue.source.label}`,
                })
              : t(
                  "Catalogue: register a catalogue, then refresh configuration. Theme: not configured.",
                )}
          </p>
          <label>
            {t("Default locale")}
            <select
              value={firstLocale}
              onChange={(e) => {
                edits.current++;
                setFirstLocale(e.target.value);
                setFirstLocales((v) => (v.includes(e.target.value) ? v : [...v, e.target.value]));
              }}
            >
              {candidate.supportedLocales.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {candidate.supportedLocales.map((value) => (
            <label key={value} className="brand-configuration-checkbox">
              <input
                type="checkbox"
                checked={firstLocales.includes(value)}
                disabled={value === firstLocale}
                onChange={(e) => {
                  edits.current++;
                  setFirstLocales((v) =>
                    e.target.checked ? [...v, value] : v.filter((item) => item !== value),
                  );
                }}
              />
              {value}
            </label>
          ))}
          {candidate.overrideAllowedFieldCodes.map((value) => (
            <label key={value} className="brand-configuration-checkbox">
              <input
                type="checkbox"
                checked={firstOverrides.includes(value)}
                onChange={(e) => {
                  edits.current++;
                  setFirstOverrides((v) =>
                    e.target.checked ? [...v, value] : v.filter((item) => item !== value),
                  );
                }}
              />
              {t("Allow override {value}", { value })}
            </label>
          ))}
          <label>
            {t("Effective from (UTC)")}
            <input
              type="datetime-local"
              value={firstFrom}
              onChange={(e) => {
                edits.current++;
                setFirstFrom(e.target.value);
              }}
              required
            />
          </label>
          <label>
            {t("Effective until (UTC, blank means open)")}
            <input
              type="datetime-local"
              value={firstUntil}
              onChange={(e) => {
                edits.current++;
                setFirstUntil(e.target.value);
              }}
            />
          </label>
          <label>
            {t("Reason code")}
            <input
              value={firstReason}
              maxLength={64}
              onChange={(e) => {
                edits.current++;
                setFirstReason(e.target.value);
              }}
              required
            />
          </label>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void act("SaveConfigurationDraft")}
          >
            {t("Save configuration draft")}
          </button>
        </fieldset>
      ) : null}
      {saved && draft ? (
        <>
          <p>
            {t("Recorded state: {state}. Content version {version}. Revision {revision}.", {
              state: lifecycleText(saved.configuration.lifecycle),
              version: saved.configuration.configurationVersion,
              revision: saved.revision,
            })}
          </p>
          <p>
            {draft.mediaThemeReference === null
              ? t(
                  "Linked catalogue and platform template. Theme: not configured. Publication checks run when you submit or publish.",
                )
              : t(
                  "Linked catalogue and platform template. Theme: recorded theme linked. Publication checks run when you submit or publish.",
                )}
          </p>
          <fieldset disabled={busy || !!pending || freshDisabled || !online}>
            <legend>{t("Edit saved configuration")}</legend>
            <label>
              {t("Default locale")}
              <select
                value={draft.defaultLocale}
                onChange={(e) =>
                  edit({
                    defaultLocale: e.target.value,
                    supportedLocales: draft.supportedLocales.includes(e.target.value)
                      ? draft.supportedLocales
                      : [...draft.supportedLocales, e.target.value],
                  })
                }
              >
                {(candidate?.supportedLocales ?? draft.supportedLocales).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <p>
              {t(
                "Supported locales: {locales}. Available locales are set by the linked template.",
                { locales: draft.supportedLocales.join(", ") },
              )}
            </p>
            {candidate?.supportedLocales.map((value) => (
              <label key={value} className="brand-configuration-checkbox">
                <input
                  type="checkbox"
                  checked={draft.supportedLocales.includes(value)}
                  disabled={value === draft.defaultLocale}
                  onChange={(e) =>
                    edit({
                      supportedLocales: e.target.checked
                        ? [...draft.supportedLocales, value]
                        : draft.supportedLocales.filter((item) => item !== value),
                    })
                  }
                />
                {value}
              </label>
            ))}
            {candidate?.overrideAllowedFieldCodes.map((value) => (
              <label key={value} className="brand-configuration-checkbox">
                <input
                  type="checkbox"
                  checked={draft.overrideAllowedFieldCodes.includes(value)}
                  onChange={(e) =>
                    edit({
                      overrideAllowedFieldCodes: e.target.checked
                        ? [...draft.overrideAllowedFieldCodes, value]
                        : draft.overrideAllowedFieldCodes.filter((item) => item !== value),
                    })
                  }
                />
                {t("Allow override {value}", { value })}
              </label>
            ))}
            <label>
              {t("Effective from (UTC)")}
              <input
                type="datetime-local"
                value={draft.effectiveFrom.slice(0, 16)}
                onChange={(e) => {
                  try {
                    const value = utc(e.target.value);
                    if (value) edit({ effectiveFrom: value });
                  } catch {
                    setMessage(messages.Invalid);
                  }
                }}
              />
            </label>
            <label>
              {t("Effective until (UTC, blank means open)")}
              <input
                type="datetime-local"
                value={draft.effectiveUntil?.slice(0, 16) ?? ""}
                onChange={(e) => {
                  try {
                    edit({ effectiveUntil: utc(e.target.value) });
                  } catch {
                    setMessage(messages.Invalid);
                  }
                }}
              />
            </label>
            <label>
              {t("Reason code")}
              <input
                value={draft.reasonCode}
                maxLength={64}
                onChange={(e) => edit({ reasonCode: e.target.value })}
              />
            </label>
          </fieldset>
          <button disabled={!canSave} onClick={() => void act("SaveConfigurationDraft")}>
            {t("Save configuration draft")}
          </button>
          <label>
            {t("Review valid until (UTC)")}
            <input
              type="datetime-local"
              value={review}
              disabled={busy || !!pending || freshDisabled}
              onChange={(e) => {
                edits.current++;
                setReview(e.target.value);
              }}
            />
          </label>
          <p>
            {t("Choose a review deadline. Approval and publication must finish before this time.")}
          </p>
          <div className="card-actions">
            <button
              disabled={
                !canFresh ||
                !unchanged ||
                saved.configuration.lifecycle !== "Draft" ||
                review === ""
              }
              onClick={() => void act("SubmitConfiguration")}
            >
              {t("Submit for review")}
            </button>
            <button
              disabled={
                !canFresh ||
                !unchanged ||
                saved.configuration.lifecycle !== "PendingApproval" ||
                !current?.recordedReview ||
                Date.now() >= Date.parse(current?.recordedReview?.reviewValidUntil ?? "") ||
                scope.actorReference === saved.configuration.authoredByReference ||
                scope.actorReference === saved.submittedByReference
              }
              onClick={() => void act("ApproveConfiguration")}
            >
              {t("Approve independently")}
            </button>
            <button
              disabled={
                !canFresh ||
                !unchanged ||
                saved.configuration.lifecycle !== "Approved" ||
                !current?.recordedReview ||
                Date.now() >= Date.parse(current?.recordedReview?.reviewValidUntil ?? "")
              }
              onClick={() => void act("PublishConfiguration")}
            >
              {t("Publish configuration")}
            </button>
          </div>
          {current?.recordedReview ? (
            <p>
              {t("Original review valid until (UTC):")}
              {wordGap()}
              <time dateTime={current.recordedReview.reviewValidUntil}>
                {current.recordedReview.reviewValidUntil}
              </time>
              {t(".")}{" "}
              {Date.now() >= Date.parse(current?.recordedReview?.reviewValidUntil ?? "")
                ? t(
                    "Review expired. New approval or publication is unavailable; original recovery remains available.",
                  )
                : t("Approval and publication must finish before this deadline.")}
            </p>
          ) : null}
        </>
      ) : null}
      {history ? (
        <>
          <h3>{t("Configuration history")}</h3>
          {history.entries.length === 0 ? (
            <p>{t("No recorded configuration history.")}</p>
          ) : (
            <ul>
              {history.entries.map((entry) => (
                <li key={entry.revision}>
                  {t("Revision {revision} · {state} · {recordedAt}", {
                    revision: entry.revision,
                    state: lifecycleText(entry.configuration.lifecycle),
                    recordedAt: entry.recordedAt,
                  })}
                </li>
              ))}
            </ul>
          )}
          <button
            disabled={busy || !online || history.nextBeforeRevision === null}
            onClick={() => void older()}
          >
            {t("Older configuration history")}
          </button>
        </>
      ) : null}
    </section>
  );
}
