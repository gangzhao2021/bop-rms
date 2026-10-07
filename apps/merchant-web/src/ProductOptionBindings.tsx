import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  parseProductVersion,
  type ProductVersion,
  type ProductOptionBinding,
} from "./catalog-product-command-values.js";
import {
  createProductOptionPickerClient,
  ProductOptionPickerError,
  type ProductOptionPickerScope,
  type ProductOptionPickerView,
} from "./product-option-picker-client.js";
import {
  createProductAuthoringRecoveryClient,
  ProductAuthoringRecoveryError,
} from "./product-authoring-recovery-client.js";
import {
  createOptionSetListClient,
  OptionSetListClientError,
  type OptionSetListItem,
} from "./option-set-list-client.js";
export interface ProductOptionBindingsProps {
  readonly draft: ProductVersion;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly csrf: string;
  readonly locked: boolean;
  readonly onChange: (draft: ProductVersion) => void;
  readonly onBlockedChange: (blocked: boolean) => void;
  readonly registerBeforeSave: (prepare: (signal: AbortSignal) => Promise<void>) => void;
  readonly rawInputs?: ProductOptionBindingRawInputs;
  readonly onRawInputsChange?: Dispatch<SetStateAction<ProductOptionBindingRawInputs>>;
}
export type ProductOptionBindingRawInputs = Readonly<Record<string, string>>;
/** A picker head conflict is recoverable in the retained Binding editor; it
 * is not an owning Product aggregate CAS conflict. */
export const productOptionPickerSaveErrorCode = (error: ProductOptionPickerError): string =>
  error.code === "Conflict" ? "OptionSourceConflict" : error.code;
const integer = (v: string, nullable = false, positive = false) =>
  (nullable && v === "") ||
  (/^(?:0|[1-9]\d{0,9})$/u.test(v) && BigInt(v) <= 2147483647n && (!positive || BigInt(v) > 0n));
const code = (v: string) => /^[A-Z][A-Z0-9_-]{0,63}$/u.test(v);
export function productOptionBindingRawInputsValid(inputs: ProductOptionBindingRawInputs): boolean {
  return Object.entries(inputs).every(([key, value]) => {
    if (!key.endsWith("channels"))
      return integer(value, key.endsWith("min") || key.endsWith("max"), key.includes("qty"));
    const channels = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return channels.every(code) && new Set(channels).size === channels.length;
  });
}
export function clearProductOptionBindingRawQuantity(
  inputs: ProductOptionBindingRawInputs,
  bindingReference: string,
  optionReference: string,
): ProductOptionBindingRawInputs {
  return Object.fromEntries(
    Object.entries(inputs).filter(([key]) => key !== bindingReference + "qty-" + optionReference),
  );
}
const messages: Record<ProductOptionPickerError["code"], string> = {
  Invalid: "These Option choices could not be verified.",
  Denied: "You do not have permission to read these Option choices.",
  FeatureDisabled: "Option selection is disabled for this Store.",
  Conflict: "The selected version changed. Refresh and review the choices.",
  Stale: "The Option observation expired. Refresh the choices.",
  ScopeChanged: "Your identity or selected scope changed. Refresh the Draft.",
  Unavailable: "Option choices are unavailable or offline. Retry the read.",
};
export function productOptionBindingsValid(
  draft: ProductVersion,
  sources: Readonly<Record<string, ProductOptionPickerView>>,
): boolean {
  try {
    parseProductVersion(draft);
  } catch {
    return false;
  }
  return (
    draft.optionBindings.length <= 32 &&
    draft.optionBindings.every((b) => {
      const s = sources[b.bindingReference];
      return Boolean(
        s &&
        !s.selectionDisabled &&
        s.optionSetReference === b.optionSetReference &&
        s.versionReference === b.optionSetVersionReference &&
        code(b.purpose) &&
        b.enabledOptionReferences.every((r) =>
          s.options.some((o) => o.optionReference === r && !o.selectionDisabled),
        ) &&
        b.defaultSelections.every(
          (d) =>
            b.enabledOptionReferences.includes(d.optionReference) &&
            s.options.some(
              (o) =>
                o.optionReference === d.optionReference &&
                o.defaultEligible &&
                o.lifecycle !== "Inactive" &&
                !o.selectionDisabled &&
                d.quantity >= o.quantityRule.minimumQuantity &&
                (o.quantityRule.maximumQuantity === null ||
                  d.quantity <= o.quantityRule.maximumQuantity),
            ),
        ) &&
        (b.maximumSelectionOverride === null ||
          b.minimumSelectionOverride === null ||
          b.minimumSelectionOverride <= b.maximumSelectionOverride),
      );
    })
  );
}
export function removeProductOptionBinding(
  draft: ProductVersion,
  reference: string,
): ProductVersion {
  if (!draft.editorContent) throw new ProductOptionPickerError("Invalid");
  return {
    ...draft,
    optionBindings: draft.optionBindings.filter((b) => b.bindingReference !== reference),
    editorContent: {
      ...draft.editorContent,
      optionRules: draft.editorContent.optionRules.filter((r) => r.bindingReference !== reference),
    },
  };
}
/** Change only the chosen condition using the current owning Draft choices.
 * An unavailable original is retained until it is explicitly cleared or replaced. */
export function changeProductOptionBindingVariantCondition(
  draft: ProductVersion,
  bindingReference: string,
  dimensionReference: string,
  valueReference: string | null,
): ProductVersion {
  const content = draft.editorContent,
    rule = content?.optionRules.find((r) => r.bindingReference === bindingReference),
    dimension = content?.variantDimensions.find((d) => d.dimensionReference === dimensionReference);
  if (
    !content ||
    !rule ||
    !draft.optionBindings.some((b) => b.bindingReference === bindingReference) ||
    (valueReference === null
      ? !dimension &&
        !rule.variantCondition.some((s) => s.dimensionReference === dimensionReference)
      : !dimension?.values.some((v) => v.valueReference === valueReference))
  )
    throw new ProductOptionPickerError("Invalid");
  return {
    ...draft,
    editorContent: {
      ...content,
      optionRules: content.optionRules.map((r) =>
        r.bindingReference === bindingReference
          ? {
              ...r,
              variantCondition: [
                ...r.variantCondition.filter((s) => s.dimensionReference !== dimensionReference),
                ...(valueReference === null ? [] : [{ dimensionReference, valueReference }]),
              ],
            }
          : r,
      ),
    },
  };
}
export function ProductOptionBindings(props: ProductOptionBindingsProps) {
  const {
    draft,
    brandReference,
    storeReference,
    csrf,
    locked,
    onChange,
    onBlockedChange,
    registerBeforeSave,
  } = props;
  const client = useMemo(() => createProductOptionPickerClient(), []),
    list = useMemo(() => createOptionSetListClient(), []),
    context = useMemo(() => createProductAuthoringRecoveryClient(), []);
  const [reload, setReload] = useState(0);
  const baseIdentity = JSON.stringify([brandReference, storeReference, csrf]),
    lastBase = useRef(baseIdentity);
  const identity = JSON.stringify([brandReference, storeReference, csrf, reload]),
    currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const current = useRef(props);
  current.current = props;
  const [state, setState] = useState<{
    identity: string;
    scope: ProductOptionPickerScope | null;
    sources: Record<string, ProductOptionPickerView>;
    errors: Record<string, string>;
    loading: boolean;
  }>({ identity, scope: null, sources: {}, errors: {}, loading: true });
  const [search, setSearch] = useState(""),
    [results, setResults] = useState<readonly OptionSetListItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [searchError, setSearchError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [target, setTarget] = useState<string | null>(null),
    [replacement, setReplacement] = useState(false),
    [remove, setRemove] = useState<string | null>(null),
    [localInputs, setLocalInputs] = useState<ProductOptionBindingRawInputs>({});
  const inputs = props.rawInputs ?? localInputs,
    setInputs = props.onRawInputsChange ?? setLocalInputs,
    controlledInputs = props.rawInputs !== undefined,
    inputId = useId();
  const controllers = useRef(new Set<AbortController>()),
    epoch = useRef(0);
  const active = state.identity === identity ? state : null;
  const displayError = (e: unknown) =>
    e instanceof ProductOptionPickerError || e instanceof OptionSetListClientError
      ? messages[e.code]
      : e instanceof ProductAuthoringRecoveryError && e.code !== "PendingOriginal"
        ? messages[e.code]
        : messages.Unavailable;
  const valid = Boolean(
    active?.scope &&
    !active.loading &&
    !active.errors.context &&
    !draft.optionBindings.some((b) => active.errors[b.bindingReference]) &&
    productOptionBindingsValid(draft, active.sources) &&
    productOptionBindingRawInputsValid(inputs),
  );
  useEffect(() => {
    onBlockedChange(!valid || busy);
  }, [valid, busy, onBlockedChange]);
  const lookup = useCallback(
    async (
      signal: AbortSignal,
      scope: ProductOptionPickerScope,
      binding: ProductOptionBinding,
      mode: "Pinned" | "CurrentPublished" = "Pinned",
    ) =>
      client.load({
        command: {
          optionSetReference: binding.optionSetReference,
          versionReference: mode === "Pinned" ? binding.optionSetVersionReference : null,
        },
        expectedScope: scope,
        csrf,
        signal,
      }),
    [client, csrf],
  );
  useEffect(() => {
    const captured = identity,
      sequence = ++epoch.current,
      controller = new AbortController();
    controllers.current.add(controller);
    setState({ identity: captured, scope: null, sources: {}, errors: {}, loading: true });
    setResults([]);
    setCursor(null);
    setSearchError(null);
    setTarget(null);
    setReplacement(false);
    setRemove(null);
    // The complete form owns controlled text and its explicit reset rules.
    // A picker remount/scope observation must not discard unsaved raw inputs.
    if (lastBase.current !== baseIdentity && !controlledInputs) setLocalInputs({});
    lastBase.current = baseIdentity;
    const live = () =>
      !controller.signal.aborted &&
      currentIdentity.current === captured &&
      epoch.current === sequence;
    void (async () => {
      try {
        const actual = await context.context(
          "ReplaceDraft",
          { brandReference, storeReference },
          csrf,
          controller.signal,
        );
        if (!live()) return;
        const scope = {
            tenantReference: actual.tenantReference,
            brandReference: actual.brandReference,
            storeReference: actual.storeReference,
            actorReference: actual.actorReference,
          },
          sources: Record<string, ProductOptionPickerView> = {},
          errors: Record<string, string> = {};
        for (const b of current.current.draft.optionBindings) {
          try {
            const source = await lookup(controller.signal, scope, b);
            if (!live()) return;
            sources[b.bindingReference] = source;
          } catch (e) {
            if (!live()) return;
            errors[b.bindingReference] = displayError(e);
          }
        }
        if (live()) setState({ identity: captured, scope, sources, errors, loading: false });
      } catch (e) {
        if (live())
          setState({
            identity: captured,
            scope: null,
            sources: {},
            errors: { context: displayError(e) },
            loading: false,
          });
      }
    })().finally(() => controllers.current.delete(controller));
    return () => {
      controller.abort();
      for (const c of controllers.current) c.abort();
      controllers.current.clear();
    };
  }, [
    identity,
    baseIdentity,
    context,
    brandReference,
    storeReference,
    csrf,
    lookup,
    controlledInputs,
  ]);
  useEffect(() => {
    const captured = identity;
    registerBeforeSave(async (signal) => {
      const scope = active?.scope;
      if (!scope || active.loading || currentIdentity.current !== captured)
        throw new ProductOptionPickerError("ScopeChanged");
      const preparedDraft = current.current.draft;
      const actual = await context.context(
        "ReplaceDraft",
        { brandReference, storeReference },
        csrf,
        signal,
      );
      if (
        signal.aborted ||
        currentIdentity.current !== captured ||
        actual.actorReference !== scope.actorReference ||
        actual.tenantReference !== scope.tenantReference
      )
        throw new ProductOptionPickerError("ScopeChanged");
      const sources: Record<string, ProductOptionPickerView> = {};
      for (const b of preparedDraft.optionBindings) {
        const rule = preparedDraft.editorContent?.optionRules.find(
          (r) => r.bindingReference === b.bindingReference,
        );
        if (!rule) throw new ProductOptionPickerError("Invalid");
        const fresh = await lookup(signal, scope, b, rule.versionResolution);
        if (
          signal.aborted ||
          currentIdentity.current !== captured ||
          current.current.draft !== preparedDraft
        )
          throw new ProductOptionPickerError("ScopeChanged");
        if (fresh.versionReference !== b.optionSetVersionReference) {
          setState((v) =>
            v.identity === captured
              ? { ...v, errors: { ...v.errors, [b.bindingReference]: messages.Conflict } }
              : v,
          );
          throw new ProductOptionPickerError("Conflict");
        }
        sources[b.bindingReference] = fresh;
      }
      if (!productOptionBindingsValid(preparedDraft, sources))
        throw new ProductOptionPickerError("Invalid");
      setState((previous) =>
        previous.identity === captured ? { ...previous, sources, errors: {} } : previous,
      );
    });
  }, [active, identity, registerBeforeSave, context, brandReference, storeReference, csrf, lookup]);
  async function refreshBinding(b: ProductOptionBinding) {
    const scope = active?.scope;
    if (!scope) return;
    const preparedDraft = current.current.draft;
    const controller = new AbortController(),
      captured = identity;
    controllers.current.add(controller);
    setBusy(true);
    try {
      const source = await lookup(controller.signal, scope, b);
      if (
        controller.signal.aborted ||
        currentIdentity.current !== captured ||
        current.current.draft !== preparedDraft
      )
        return;
      setState((v) => ({
        ...v,
        sources: { ...v.sources, [b.bindingReference]: source },
        errors: { ...v.errors, [b.bindingReference]: "" },
      }));
    } catch (e) {
      if (!controller.signal.aborted && currentIdentity.current === captured)
        setState((v) => ({ ...v, errors: { ...v.errors, [b.bindingReference]: displayError(e) } }));
    } finally {
      controllers.current.delete(controller);
      if (currentIdentity.current === captured) setBusy(false);
    }
  }
  async function searchOptions(next: string | null = null) {
    const scope = active?.scope;
    if (!scope) return;
    const controller = new AbortController(),
      captured = identity,
      sequence = ++epoch.current;
    controllers.current.add(controller);
    setBusy(true);
    setSearchError(null);
    try {
      const view = await list.load({
        filters: {
          locale: draft.defaultLocale,
          search: search.trim() || null,
          lifecycle: null,
          selectionType: null,
          includeArchived: false,
          hasProductBinding: null,
          hasPricingReference: null,
          hasConsumptionReference: null,
          hasConflict: null,
          missingTranslationLocale: null,
          publishingStatus: null,
          sort: "updatedAt",
          direction: "DESC",
          limit: 25,
          cursor: next,
        },
        expectedScope: { brandReference, storeReference },
        expectedFullScope: scope,
        csrf,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        currentIdentity.current !== captured ||
        epoch.current !== sequence
      )
        return;
      setResults((old) => (next ? [...old, ...view.items] : view.items));
      setCursor(view.nextCursor);
    } catch (e) {
      if (!controller.signal.aborted && currentIdentity.current === captured)
        setSearchError(displayError(e));
    } finally {
      controllers.current.delete(controller);
      if (currentIdentity.current === captured && epoch.current === sequence) setBusy(false);
    }
  }
  useEffect(() => {
    if (!active?.scope) return;
    if (!search.trim()) return;
    const timer = setTimeout(() => void searchOptions(), 250);
    return () => clearTimeout(timer);
  }, [search, active?.scope]);
  async function select(item: OptionSetListItem) {
    const scope = active?.scope;
    if (!scope || (target && !replacement)) return;
    const preparedDraft = current.current.draft;
    const controller = new AbortController(),
      captured = identity;
    controllers.current.add(controller);
    setBusy(true);
    setSearchError(null);
    try {
      const source = await client.load({
        command: { optionSetReference: item.optionSetReference, versionReference: null },
        expectedScope: scope,
        csrf,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        currentIdentity.current !== captured ||
        current.current.draft !== preparedDraft
      )
        return;
      if (source.selectionDisabled) throw new ProductOptionPickerError("Invalid");
      const value = current.current.draft,
        content = value.editorContent;
      if (!content) throw new ProductOptionPickerError("Invalid");
      const old = value.optionBindings.find((b) => b.bindingReference === target),
        reference = old?.bindingReference ?? source.bindingReference;
      const binding: ProductOptionBinding = {
        bindingReference: reference,
        optionSetReference: source.optionSetReference,
        optionSetVersionReference: source.versionReference,
        purpose: old?.purpose ?? "",
        sortOrder: old?.sortOrder ?? value.optionBindings.length,
        enabledOptionReferences: [],
        defaultSelections: [],
        minimumSelectionOverride: null,
        maximumSelectionOverride: null,
        includedSkuReferences: old?.includedSkuReferences ?? [],
        excludedSkuReferences: old?.excludedSkuReferences ?? [],
        channelCodes: old?.channelCodes ?? [],
        storeOverrideAllowed: old?.storeOverrideAllowed ?? false,
      };
      if (!old && value.optionBindings.some((b) => b.bindingReference === reference))
        throw new ProductOptionPickerError("Conflict");
      if (old)
        setInputs((values) =>
          Object.fromEntries(
            Object.entries(values).filter(
              ([key]) => key === reference + "channels" || !key.startsWith(reference),
            ),
          ),
        );
      onChange({
        ...value,
        optionBindings: old
          ? value.optionBindings.map((b) => (b.bindingReference === reference ? binding : b))
          : [...value.optionBindings, binding],
        editorContent: {
          ...content,
          optionRules: old
            ? content.optionRules
            : [
                ...content.optionRules,
                {
                  bindingReference: reference,
                  versionResolution: "CurrentPublished",
                  pricingRule: null,
                  conditionalRule: null,
                  conflictRule: null,
                  variantCondition: [],
                },
              ],
        },
      });
      setState((v) => ({
        ...v,
        sources: { ...v.sources, [reference]: source },
        errors: { ...v.errors, [reference]: "" },
      }));
      setTarget(null);
      setReplacement(false);
    } catch (e) {
      if (!controller.signal.aborted && currentIdentity.current === captured)
        setSearchError(displayError(e));
    } finally {
      controllers.current.delete(controller);
      if (currentIdentity.current === captured) setBusy(false);
    }
  }
  const change = (reference: string, update: Partial<ProductOptionBinding>) =>
    onChange({
      ...draft,
      optionBindings: draft.optionBindings.map((b) =>
        b.bindingReference === reference ? { ...b, ...update } : b,
      ),
    });
  const numeric = (
    b: ProductOptionBinding,
    key: string,
    label: string,
    value: number | null,
    changeValue: (value: number | null) => void,
    positive = false,
  ) => {
    const text = inputs[b.bindingReference + key] ?? (value === null ? "" : String(value)),
      valid = integer(text, !positive, positive),
      field = positive
        ? "default-" + b.defaultSelections.findIndex((d) => key === "qty-" + d.optionReference)
        : key,
      hintId = `${inputId}-binding-${draft.optionBindings.indexOf(b)}-${field}-hint`;
    return (
      <label>
        {label}
        <input
          aria-label={label}
          inputMode="numeric"
          maxLength={10}
          aria-invalid={!valid || undefined}
          aria-describedby={hintId}
          value={text}
          onChange={(e) => {
            const text = e.currentTarget.value;
            setInputs((v) => ({ ...v, [b.bindingReference + key]: text }));
            if (integer(text, !positive, positive)) changeValue(text === "" ? null : Number(text));
          }}
        />
        <span id={hintId}>
          {valid
            ? positive
              ? "Whole-number quantity."
              : "Blank keeps the owning default."
            : `Enter a ${positive ? "positive" : "non-negative"} whole number up to 2147483647${positive ? "" : ", or leave blank"}.`}
        </span>
      </label>
    );
  };
  return (
    <section aria-label="Product Option bindings">
      <h4>Option bindings</h4>
      <p>
        Recorded choices are Draft intent. Saving does not authorize sale. Historical selections and
        rules stay recorded until explicitly changed.
      </p>
      <button
        type="button"
        disabled={locked || busy}
        onClick={() => setReload((value) => value + 1)}
      >
        Refresh all Option choices
      </button>
      {active?.loading || !active ? <p role="status">Loading Option choices…</p> : null}
      {Object.entries(active?.errors ?? {}).map(([key, error]) =>
        error ? (
          <p role="alert" key={key}>
            {error}
          </p>
        ) : null,
      )}
      <fieldset disabled={locked || busy || !active?.scope}>
        <legend>Choose an Option Set</legend>
        <label>
          Search Option Sets
          <input value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
        </label>
        <button type="button" onClick={() => void searchOptions()}>
          Search Option Sets
        </button>
        {target ? (
          <label>
            <input
              type="checkbox"
              checked={replacement}
              onChange={(e) => setReplacement(e.currentTarget.checked)}
            />
            Replace this binding’s selected version and clear its enabled Options, defaults and
            overrides
          </label>
        ) : null}
        <ul>
          {results.map((item) => (
            <li key={item.optionSetReference}>
              {item.name} · {item.internalCode}
              <button
                type="button"
                disabled={Boolean(target && !replacement)}
                onClick={() => void select(item)}
              >
                Select {item.name}
              </button>
            </li>
          ))}
        </ul>
        {cursor ? (
          <button type="button" onClick={() => void searchOptions(cursor)}>
            Load more Option Sets
          </button>
        ) : null}
        {searchError ? <p role="alert">{searchError}</p> : null}
      </fieldset>
      {draft.optionBindings.map((b, index) => {
        const source = active?.sources[b.bindingReference],
          rule = draft.editorContent?.optionRules.find(
            (r) => r.bindingReference === b.bindingReference,
          );
        return (
          <fieldset disabled={locked || busy} key={b.bindingReference}>
            <legend>Option binding {index + 1}</legend>
            <p>
              {source
                ? (source.localizedNames[draft.defaultLocale] ??
                  source.localizedNames[source.defaultLocale])
                : "Recorded selection · choices unavailable"}{" "}
              · {rule?.versionResolution ?? "Recorded"}
            </p>
            {source ? (
              <p>
                Source: {source.sourceAuthority} · observed{" "}
                <time dateTime={source.observedAt}>{source.observedAt}</time>. Saving rechecks
                current authority. Reference eligibility is not evaluated by this picker.
              </p>
            ) : null}
            <button type="button" onClick={() => void refreshBinding(b)}>
              Refresh binding {index + 1} choices
            </button>
            <button
              type="button"
              onClick={() => {
                setTarget(b.bindingReference);
                setReplacement(false);
              }}
            >
              Choose replacement for binding {index + 1}
            </button>
            <label>
              Option binding {index + 1} purpose
              <input
                value={b.purpose}
                onChange={(e) => change(b.bindingReference, { purpose: e.currentTarget.value })}
                maxLength={64}
              />
            </label>
            <label>
              Option binding {index + 1} version resolution
              <select
                aria-label={`Option binding ${index + 1} version resolution`}
                value={rule?.versionResolution ?? "Pinned"}
                onChange={(e) => {
                  if (!draft.editorContent) return;
                  onChange({
                    ...draft,
                    editorContent: {
                      ...draft.editorContent,
                      optionRules: draft.editorContent.optionRules.map((r) =>
                        r.bindingReference === b.bindingReference
                          ? {
                              ...r,
                              versionResolution:
                                e.currentTarget.value === "Pinned" ? "Pinned" : "CurrentPublished",
                            }
                          : r,
                      ),
                    },
                  });
                }}
              >
                <option>Pinned</option>
                <option>CurrentPublished</option>
              </select>
            </label>
            <fieldset>
              <legend>Option binding {index + 1} Variant conditions</legend>
              <p>
                Choose Dimension values recorded in this Product Draft. No condition means this
                binding is not restricted by that Dimension. Saving does not qualify applicability.
              </p>
              {draft.editorContent?.variantDimensions.map((dimension) => {
                const selection = rule?.variantCondition.find(
                    (s) => s.dimensionReference === dimension.dimensionReference,
                  ),
                  available =
                    !selection ||
                    dimension.values.some((v) => v.valueReference === selection.valueReference),
                  name = dimension.localizedNames[draft.defaultLocale] ?? dimension.code;
                return (
                  <label key={dimension.dimensionReference}>
                    Option binding {index + 1} {name} condition
                    <select
                      aria-label={`Option binding ${index + 1} ${name} condition`}
                      value={selection?.valueReference ?? ""}
                      aria-invalid={!available || undefined}
                      onChange={(e) =>
                        onChange(
                          changeProductOptionBindingVariantCondition(
                            draft,
                            b.bindingReference,
                            dimension.dimensionReference,
                            e.currentTarget.value || null,
                          ),
                        )
                      }
                    >
                      <option value="">Any value (no condition)</option>
                      {!available && selection ? (
                        <option value={selection.valueReference}>Recorded value unavailable</option>
                      ) : null}
                      {dimension.values.map((value) => (
                        <option key={value.valueReference} value={value.valueReference}>
                          {value.localizedNames[draft.defaultLocale] ?? value.code}
                        </option>
                      ))}
                    </select>
                    {!available ? (
                      <span role="status">
                        Recorded value is unavailable in this Draft. Choose a current value or
                        explicitly clear this condition.
                      </span>
                    ) : null}
                  </label>
                );
              })}
              {rule?.variantCondition
                .filter(
                  (s) =>
                    !draft.editorContent?.variantDimensions.some(
                      (d) => d.dimensionReference === s.dimensionReference,
                    ),
                )
                .map((selection, conditionIndex) => (
                  <div key={selection.dimensionReference}>
                    <p role="status">
                      Recorded Variant condition {conditionIndex + 1}: Dimension unavailable in this
                      Draft. The original selection is retained.
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        onChange(
                          changeProductOptionBindingVariantCondition(
                            draft,
                            b.bindingReference,
                            selection.dimensionReference,
                            null,
                          ),
                        )
                      }
                    >
                      Clear unavailable condition {conditionIndex + 1} for binding {index + 1}
                    </button>
                  </div>
                ))}
              {!draft.editorContent?.variantDimensions.length && !rule?.variantCondition.length ? (
                <p>No Variant Dimensions recorded in this Product Draft.</p>
              ) : null}
            </fieldset>
            {numeric(
              b,
              "min",
              `Option binding ${index + 1} minimum override`,
              b.minimumSelectionOverride,
              (v) => change(b.bindingReference, { minimumSelectionOverride: v }),
            )}
            {numeric(
              b,
              "max",
              `Option binding ${index + 1} maximum override`,
              b.maximumSelectionOverride,
              (v) => change(b.bindingReference, { maximumSelectionOverride: v }),
            )}
            <p>Enabled Options and defaults</p>
            {source?.options.map((o) => {
              const enabled = b.enabledOptionReferences.includes(o.optionReference),
                selection = b.defaultSelections.find(
                  (d) => d.optionReference === o.optionReference,
                );
              return (
                <div key={o.optionReference}>
                  <label>
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={o.selectionDisabled && !enabled}
                      onChange={(e) => {
                        if (!e.currentTarget.checked)
                          setInputs((values) =>
                            clearProductOptionBindingRawQuantity(
                              values,
                              b.bindingReference,
                              o.optionReference,
                            ),
                          );
                        change(b.bindingReference, {
                          enabledOptionReferences: e.currentTarget.checked
                            ? [...b.enabledOptionReferences, o.optionReference]
                            : b.enabledOptionReferences.filter((r) => r !== o.optionReference),
                          defaultSelections: e.currentTarget.checked
                            ? b.defaultSelections
                            : b.defaultSelections.filter(
                                (s) => s.optionReference !== o.optionReference,
                              ),
                        });
                      }}
                    />
                    Enable{" "}
                    {o.localizedNames[draft.defaultLocale] ??
                      o.localizedNames[source.defaultLocale]}
                    {o.selectionDisabled ? ` · ${o.disabledReason}` : ""}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      disabled={
                        !enabled ||
                        ((!o.defaultEligible ||
                          o.lifecycle === "Inactive" ||
                          o.selectionDisabled) &&
                          !selection)
                      }
                      checked={Boolean(selection)}
                      onChange={(e) => {
                        if (!e.currentTarget.checked)
                          setInputs((values) =>
                            clearProductOptionBindingRawQuantity(
                              values,
                              b.bindingReference,
                              o.optionReference,
                            ),
                          );
                        change(b.bindingReference, {
                          defaultSelections: e.currentTarget.checked
                            ? [
                                ...b.defaultSelections,
                                {
                                  optionReference: o.optionReference,
                                  quantity: Math.max(1, o.quantityRule.minimumQuantity),
                                },
                              ]
                            : b.defaultSelections.filter(
                                (d) => d.optionReference !== o.optionReference,
                              ),
                        });
                      }}
                    />
                    Default {o.stableCode}
                  </label>
                  {selection &&
                  (!o.defaultEligible || o.lifecycle === "Inactive" || o.selectionDisabled) ? (
                    <p role="alert">This recorded default is invalid. Clear it before saving.</p>
                  ) : null}
                  {selection
                    ? numeric(
                        b,
                        `qty-${o.optionReference}`,
                        `Default ${o.stableCode} quantity`,
                        selection.quantity,
                        (v) => {
                          if (v !== null)
                            change(b.bindingReference, {
                              defaultSelections: b.defaultSelections.map((d) =>
                                d.optionReference === o.optionReference ? { ...d, quantity: v } : d,
                              ),
                            });
                        },
                        true,
                      )
                    : null}
                </div>
              );
            })}
            {!source && b.enabledOptionReferences.length ? (
              <>
                <p>
                  Existing enabled Options and defaults are retained. Refresh choices to edit them.
                </p>
                <p>
                  {b.enabledOptionReferences.length} enabled Options · {b.defaultSelections.length}{" "}
                  defaults
                </p>
                <ul>
                  {b.defaultSelections.map((selection, i) => (
                    <li key={selection.optionReference}>
                      Recorded default {i + 1} quantity: {selection.quantity}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <p>SKU applicability</p>
            {draft.skus.map((sku) => (
              <label key={sku.skuReference}>
                Option binding {index + 1} {sku.localizedNames[draft.defaultLocale] ?? sku.skuCode}{" "}
                SKU applicability
                <select
                  aria-label={`Option binding ${index + 1} ${sku.localizedNames[draft.defaultLocale] ?? sku.skuCode} SKU applicability`}
                  value={
                    b.includedSkuReferences.includes(sku.skuReference)
                      ? "Include"
                      : b.excludedSkuReferences.includes(sku.skuReference)
                        ? "Exclude"
                        : "Inherited"
                  }
                  onChange={(e) =>
                    change(b.bindingReference, {
                      includedSkuReferences: [
                        ...b.includedSkuReferences.filter((r) => r !== sku.skuReference),
                        ...(e.currentTarget.value === "Include" ? [sku.skuReference] : []),
                      ],
                      excludedSkuReferences: [
                        ...b.excludedSkuReferences.filter((r) => r !== sku.skuReference),
                        ...(e.currentTarget.value === "Exclude" ? [sku.skuReference] : []),
                      ],
                    })
                  }
                >
                  <option>Inherited</option>
                  <option>Include</option>
                  <option>Exclude</option>
                </select>
              </label>
            ))}
            <label>
              Option binding {index + 1} channel codes (comma separated)
              <input
                value={inputs[b.bindingReference + "channels"] ?? b.channelCodes.join(",")}
                onChange={(e) => {
                  const text = e.currentTarget.value;
                  setInputs((v) => ({ ...v, [b.bindingReference + "channels"]: text }));
                  const values = text
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean);
                  if (values.every(code) && new Set(values).size === values.length)
                    change(b.bindingReference, { channelCodes: values });
                }}
              />
            </label>
            <p>
              Channel codes are recorded intent; registration and applicability are checked by the
              server.
            </p>
            <label>
              <input
                type="checkbox"
                checked={b.storeOverrideAllowed}
                onChange={(e) =>
                  change(b.bindingReference, { storeOverrideAllowed: e.currentTarget.checked })
                }
              />
              Option binding {index + 1} allow Store override
            </label>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => {
                const items = [...draft.optionBindings],
                  previous = items[index - 1];
                if (!previous) return;
                items[index - 1] = b;
                items[index] = previous;
                onChange({
                  ...draft,
                  optionBindings: items.map((item, i) => ({ ...item, sortOrder: i })),
                });
              }}
            >
              Move binding {index + 1} up
            </button>
            <button
              type="button"
              disabled={index === draft.optionBindings.length - 1}
              onClick={() => {
                const items = [...draft.optionBindings],
                  next = items[index + 1];
                if (!next) return;
                items[index] = next;
                items[index + 1] = b;
                onChange({
                  ...draft,
                  optionBindings: items.map((item, i) => ({ ...item, sortOrder: i })),
                });
              }}
            >
              Move binding {index + 1} down
            </button>
            <button type="button" onClick={() => setRemove(b.bindingReference)}>
              Remove binding {index + 1}
            </button>
            {remove === b.bindingReference ? (
              <div>
                <p>
                  Remove this Draft binding and its associated rule? Recorded history remains
                  unchanged.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onChange(removeProductOptionBinding(draft, b.bindingReference));
                    setRemove(null);
                    setInputs((values) =>
                      Object.fromEntries(
                        Object.entries(values).filter(
                          ([key]) => !key.startsWith(b.bindingReference),
                        ),
                      ),
                    );
                  }}
                >
                  Confirm binding removal
                </button>
                <button type="button" onClick={() => setRemove(null)}>
                  Keep binding
                </button>
              </div>
            ) : null}
          </fieldset>
        );
      })}
      <p role="status">
        {busy
          ? "Reading current Option choices…"
          : !valid
            ? "Refresh or correct Option binding choices before saving."
            : "Option binding intent is ready for server revalidation."}
      </p>
    </section>
  );
}
