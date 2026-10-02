import type { ProductVersion, ProductLifecycle } from "./catalog-product-command-values.js";

function IntegerField({
  id,
  label,
  nullable = false,
  positive = false,
  onChange,
  text,
  onInput,
}: {
  id: string;
  label: string;
  nullable?: boolean;
  positive?: boolean;
  onChange: (value: number | null) => void;
  text: string;
  onInput: (text: string, valid: boolean) => void;
}) {
  const valid =
    (nullable && text === "") ||
    (/^(?:0|[1-9]\d{0,9})$/u.test(text) &&
      BigInt(text) <= 2147483647n &&
      (!positive || BigInt(text) > 0n));
  return (
    <label>
      {label}
      <input
        value={text}
        aria-label={label}
        inputMode="numeric"
        maxLength={10}
        aria-invalid={!valid || undefined}
        aria-describedby={id}
        onChange={(event) => {
          const next = event.currentTarget.value;
          const accepted =
            (nullable && next === "") ||
            (/^(?:0|[1-9]\d{0,9})$/u.test(next) &&
              BigInt(next) <= 2147483647n &&
              (!positive || BigInt(next) > 0n));
          onInput(next, accepted);
          if (accepted) onChange(next === "" ? null : Number(next));
        }}
      />
      <span id={id}>
        {valid
          ? nullable
            ? "Blank keeps the owning default."
            : "Whole-number quantity."
          : `Enter a ${positive ? "positive" : "non-negative"} whole number up to 2147483647${nullable ? ", or leave blank" : ""}.`}
      </span>
    </label>
  );
}

/** Existing recorded identities only. Every complete candidate is still admitted
 * by the owning server; local edits never resolve a new reference or activate sale. */
export function ProductRecordedConfigurationFields({
  draft,
  onChange,
  integerInputs,
  onIntegerInput,
}: {
  draft: ProductVersion;
  onChange: (draft: ProductVersion) => void;
  integerInputs: Readonly<Record<string, { readonly text: string; readonly valid: boolean }>>;
  onIntegerInput: (key: string, text: string, valid: boolean) => void;
}) {
  const content = draft.editorContent;
  if (!content) return null;
  const changeSku = (index: number, changes: Partial<ProductVersion["skus"][number]>) =>
    onChange({
      ...draft,
      skus: draft.skus.map((sku, i) => (i === index ? { ...sku, ...changes } : sku)),
    });
  const changeDimension = (
    index: number,
    changes: Partial<(typeof content.variantDimensions)[number]>,
  ) =>
    onChange({
      ...draft,
      editorContent: {
        ...content,
        variantDimensions: content.variantDimensions.map((d, i) =>
          i === index ? { ...d, ...changes } : d,
        ),
      },
    });
  const changeBinding = (
    index: number,
    changes: Partial<ProductVersion["optionBindings"][number]>,
  ) =>
    onChange({
      ...draft,
      optionBindings: draft.optionBindings.map((b, i) => (i === index ? { ...b, ...changes } : b)),
    });
  return (
    <div className="product-recorded-configuration">
      <h4>Recorded SKU configuration</h4>
      <p>
        These are Draft values. Saving a recorded lifecycle does not activate a SKU or authorize
        sale. Unit codes and owning identities stay recorded.
      </p>
      {draft.skus.map((sku, index) => (
        <div key={sku.skuReference}>
          <h5>SKU {index + 1}</h5>
          <label>
            SKU {index + 1} code
            <input
              value={sku.skuCode}
              maxLength={64}
              required
              onChange={(e) => changeSku(index, { skuCode: e.currentTarget.value })}
            />
          </label>
          {Object.entries(sku.localizedNames).map(([locale, text]) => (
            <label key={locale}>
              SKU {index + 1} name · {locale}
              <input
                value={text}
                maxLength={120}
                required
                onChange={(e) =>
                  changeSku(index, {
                    localizedNames: { ...sku.localizedNames, [locale]: e.currentTarget.value },
                  })
                }
              />
            </label>
          ))}
          <label>
            SKU {index + 1} Draft lifecycle
            <select
              value={sku.lifecycle}
              aria-label={`SKU ${index + 1} Draft lifecycle`}
              onChange={(e) =>
                changeSku(index, { lifecycle: e.currentTarget.value as ProductLifecycle })
              }
            >
              {(["Draft", "Active", "Suspended", "Discontinued", "Archived"] as const).map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </label>
          <p>Recorded unit: {sku.unitOfSale}</p>
          <label>
            SKU {index + 1} unit quantity
            <input
              value={sku.unitQuantity}
              inputMode="decimal"
              maxLength={64}
              required
              aria-describedby="complete-draft-validation"
              onChange={(e) => changeSku(index, { unitQuantity: e.currentTarget.value })}
            />
          </label>
        </div>
      ))}
      <h4>Recorded Variant configuration</h4>
      <p>
        Codes, names and requirements can be edited. Existing value identities, SKU selections and
        combinations stay bound; new generation and mapping need current owning sources.
      </p>
      {content.variantDimensions.map((dimension, index) => (
        <div key={dimension.dimensionReference}>
          <h5>Dimension {index + 1}</h5>
          <label>
            Dimension {index + 1} code
            <input
              value={dimension.code}
              maxLength={64}
              required
              onChange={(e) => changeDimension(index, { code: e.currentTarget.value })}
            />
          </label>
          {Object.entries(dimension.localizedNames).map(([locale, text]) => (
            <label key={locale}>
              Dimension {index + 1} name · {locale}
              <input
                value={text}
                maxLength={120}
                required
                onChange={(e) =>
                  changeDimension(index, {
                    localizedNames: {
                      ...dimension.localizedNames,
                      [locale]: e.currentTarget.value,
                    },
                  })
                }
              />
            </label>
          ))}
          <label>
            Dimension {index + 1} selection requirement
            <select
              value={dimension.selectionRequirement}
              aria-label={`Dimension ${index + 1} selection requirement`}
              onChange={(e) =>
                changeDimension(index, {
                  selectionRequirement:
                    e.currentTarget.value === "Required" ? "Required" : "Optional",
                })
              }
            >
              <option>Required</option>
              <option>Optional</option>
            </select>
          </label>
          {dimension.values.map((value, vi) => (
            <div key={value.valueReference}>
              <label>
                Dimension {index + 1} value {vi + 1} code
                <input
                  value={value.code}
                  maxLength={64}
                  required
                  onChange={(e) =>
                    changeDimension(index, {
                      values: dimension.values.map((v, i) =>
                        i === vi ? { ...v, code: e.currentTarget.value } : v,
                      ),
                    })
                  }
                />
              </label>
              {Object.entries(value.localizedNames).map(([locale, text]) => (
                <label key={locale}>
                  Dimension {index + 1} value {vi + 1} name · {locale}
                  <input
                    value={text}
                    maxLength={120}
                    required
                    onChange={(e) =>
                      changeDimension(index, {
                        values: dimension.values.map((v, i) =>
                          i === vi
                            ? {
                                ...v,
                                localizedNames: {
                                  ...v.localizedNames,
                                  [locale]: e.currentTarget.value,
                                },
                              }
                            : v,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
      ))}
      <h4>Recorded Option configuration</h4>
      <p>
        Existing Option identities and pricing, condition and conflict references remain recorded.
        Resolution policy is a Draft intent, not proof of a current published version.
      </p>
      {draft.optionBindings.map((binding, index) => (
        <div key={binding.bindingReference}>
          <h5>Option binding {index + 1}</h5>
          <label>
            Option binding {index + 1} purpose
            <input
              value={binding.purpose}
              maxLength={64}
              required
              onChange={(e) => changeBinding(index, { purpose: e.currentTarget.value })}
            />
          </label>
          <IntegerField
            id={`recorded-option-${index}-min`}
            label={`Option binding ${index + 1} minimum override`}
            nullable
            onChange={(value) => changeBinding(index, { minimumSelectionOverride: value })}
            text={
              integerInputs[`${index}-min`]?.text ??
              (binding.minimumSelectionOverride === null
                ? ""
                : String(binding.minimumSelectionOverride))
            }
            onInput={(text, valid) => onIntegerInput(`${index}-min`, text, valid)}
          />
          <IntegerField
            id={`recorded-option-${index}-max`}
            label={`Option binding ${index + 1} maximum override`}
            nullable
            onChange={(value) => changeBinding(index, { maximumSelectionOverride: value })}
            text={
              integerInputs[`${index}-max`]?.text ??
              (binding.maximumSelectionOverride === null
                ? ""
                : String(binding.maximumSelectionOverride))
            }
            onInput={(text, valid) => onIntegerInput(`${index}-max`, text, valid)}
          />
          {binding.defaultSelections.map((selection, si) => (
            <IntegerField
              key={selection.optionReference}
              id={`recorded-option-${index}-default-${si}`}
              label={`Option binding ${index + 1} default ${si + 1} quantity`}
              positive
              onChange={(value) => {
                if (value !== null)
                  changeBinding(index, {
                    defaultSelections: binding.defaultSelections.map((s, i) =>
                      i === si ? { ...s, quantity: value } : s,
                    ),
                  });
              }}
              text={integerInputs[`${index}-default-${si}`]?.text ?? String(selection.quantity)}
              onInput={(text, valid) => onIntegerInput(`${index}-default-${si}`, text, valid)}
            />
          ))}
          <label>
            Option binding {index + 1} allow Store override
            <input
              type="checkbox"
              checked={binding.storeOverrideAllowed}
              onChange={(e) =>
                changeBinding(index, { storeOverrideAllowed: e.currentTarget.checked })
              }
            />
          </label>
          {content.optionRules
            .filter((rule) => rule.bindingReference === binding.bindingReference)
            .map((rule) => (
              <label key={rule.bindingReference}>
                Option binding {index + 1} version resolution
                <select
                  value={rule.versionResolution}
                  aria-label={`Option binding ${index + 1} version resolution`}
                  onChange={(e) =>
                    onChange({
                      ...draft,
                      editorContent: {
                        ...content,
                        optionRules: content.optionRules.map((r) =>
                          r.bindingReference === binding.bindingReference
                            ? {
                                ...r,
                                versionResolution:
                                  e.currentTarget.value === "Pinned"
                                    ? "Pinned"
                                    : "CurrentPublished",
                              }
                            : r,
                        ),
                      },
                    })
                  }
                >
                  <option>Pinned</option>
                  <option>CurrentPublished</option>
                </select>
              </label>
            ))}
        </div>
      ))}
    </div>
  );
}
