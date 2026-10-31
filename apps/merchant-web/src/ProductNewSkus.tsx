import { serviceOperationReference } from "./service-control-client.js";
import {
  sellingUnitQuantityValid,
  type ProductSellingUnitsView,
} from "./product-selling-units-client.js";
import type { ProductVersion } from "./catalog-product-command-values.js";
export interface ProductNewSkuRow {
  readonly reference: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: string;
  readonly combination: string;
}
export function newSkuRowsValid(
  rows: readonly ProductNewSkuRow[],
  units: ProductSellingUnitsView | null,
  locale: string,
  draft?: ProductVersion,
) {
  if (!rows.length) return true;
  const variants = Boolean(draft?.editorContent?.variantDimensions.length);
  if (!variants && (rows.length > 1 || Boolean(draft?.skus.length))) return false;
  if (!units || !locale || new Set(rows.map((row) => row.code)).size !== rows.length) return false;
  return rows.every((row) => {
    const unit = units.units.find((unit) => unit.code === row.unit && unit.lifecycle === "Active");
    const combo =
      variants && /^(?:0|[1-9]\d*)$/u.test(row.combination)
        ? draft?.editorContent?.variantCombinations[Number(row.combination)]
        : null;
    return Boolean(
      unit &&
      /^[A-Z][A-Z0-9_-]{0,63}$/u.test(row.code) &&
      row.name.trim() &&
      row.name.length <= 120 &&
      sellingUnitQuantityValid(row.quantity, unit.quantityDecimalPlaces) &&
      !draft?.skus.some((sku) => sku.skuCode === row.code) &&
      (!variants ||
        (combo?.disposition === "NotGenerated" &&
          combo.skuReference === null &&
          draft?.editorContent?.variantDimensions.every(
            (d) =>
              d.selectionRequirement !== "Required" ||
              combo.selections.some((s) => s.dimensionReference === d.dimensionReference),
          ) &&
          rows.filter((other) => other.combination === row.combination).length === 1)),
    );
  });
}
export function selectedSellingUnitsChanged(
  rows: readonly ProductNewSkuRow[],
  previous: ProductSellingUnitsView,
  current: ProductSellingUnitsView,
) {
  return rows.some((row) => {
    const before = previous.units.find((unit) => unit.code === row.unit),
      after = current.units.find((unit) => unit.code === row.unit);
    return (
      !before ||
      !after ||
      after.lifecycle !== "Active" ||
      before.unitReference !== after.unitReference ||
      before.code !== after.code ||
      before.semanticDefinition !== after.semanticDefinition ||
      before.quantityDecimalPlaces !== after.quantityDecimalPlaces ||
      before.lifecycle !== after.lifecycle
    );
  });
}
export function ProductNewSkus({
  rows,
  units,
  locale,
  locked,
  draft,
  onChange,
}: {
  readonly rows: readonly ProductNewSkuRow[];
  readonly units: ProductSellingUnitsView | null;
  readonly locale: string;
  readonly locked: boolean;
  readonly onChange: (rows: readonly ProductNewSkuRow[]) => void;
  readonly draft?: ProductVersion;
}) {
  const fresh =
      units !== null &&
      Date.now() >= Date.parse(units.observedAt) &&
      Date.now() < Date.parse(units.validUntil),
    active = units?.units.filter((unit) => unit.lifecycle === "Active") ?? [];
  const dimensions = draft?.editorContent?.variantDimensions ?? [],
    combinations = draft?.editorContent?.variantCombinations ?? [],
    ungenerated = combinations
      .map((combo, index) => ({ combo, index }))
      .filter(
        ({ combo }) =>
          combo.disposition === "NotGenerated" &&
          combo.skuReference === null &&
          dimensions.every(
            (d) =>
              d.selectionRequirement !== "Required" ||
              combo.selections.some((s) => s.dimensionReference === d.dimensionReference),
          ),
      ),
    available = dimensions.length
      ? ungenerated.length > rows.length
      : !draft?.skus.length && rows.length === 0;
  const edit = (reference: string, change: Partial<ProductNewSkuRow>) =>
    onChange(rows.map((row) => (row.reference === reference ? { ...row, ...change } : row)));
  return (
    <fieldset disabled={locked}>
      <legend>New Draft SKUs</legend>
      {!active.length && (
        <p>Refresh actual registered units before adding SKUs. No unit is selected by default.</p>
      )}
      {units && !fresh && (
        <p>
          The unit observation expired. Saving rereads the current dictionary and requires review if
          a selected meaning or precision changed.
        </p>
      )}
      {draft && !available && rows.length === 0 && (
        <p>
          No unused recorded combination is available. Creating new Variant dimensions or values
          requires a separate explicit configuration.
        </p>
      )}
      {rows.map((row, index) => {
        const selected = active.find((unit) => unit.code === row.unit);
        return (
          <div key={row.reference}>
            <label>
              New SKU {index + 1} code
              <input
                value={row.code}
                required
                maxLength={64}
                aria-invalid={!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(row.code) || undefined}
                onChange={(e) => edit(row.reference, { code: e.currentTarget.value })}
              />
            </label>
            <p>
              Use an uppercase letter first, then uppercase letters, digits, underscores or hyphens.
            </p>
            <label>
              New SKU {index + 1} name · {locale}
              <input
                value={row.name}
                required
                maxLength={120}
                onChange={(e) => edit(row.reference, { name: e.currentTarget.value })}
              />
            </label>
            {dimensions.length > 0 && (
              <label>
                New SKU {index + 1} recorded combination
                <select
                  value={row.combination}
                  required
                  onChange={(e) => edit(row.reference, { combination: e.currentTarget.value })}
                >
                  <option value="">Choose an unused recorded combination</option>
                  {ungenerated
                    .filter(
                      (item) =>
                        !rows.some(
                          (other) =>
                            other.reference !== row.reference &&
                            other.combination === String(item.index),
                        ),
                    )
                    .map(({ combo, index: comboIndex }) => (
                      <option key={comboIndex} value={String(comboIndex)}>
                        {combo.selections
                          .map((s) => {
                            const dimension = dimensions.find(
                                (d) => d.dimensionReference === s.dimensionReference,
                              ),
                              value = dimension?.values.find(
                                (v) => v.valueReference === s.valueReference,
                              );
                            return `${dimension?.localizedNames[locale] ?? dimension?.code}: ${value?.localizedNames[locale] ?? value?.code}`;
                          })
                          .join(" · ") || "Recorded optional empty combination"}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label>
              New SKU {index + 1} selling unit
              <select
                value={row.unit}
                required
                onChange={(e) => edit(row.reference, { unit: e.currentTarget.value })}
              >
                <option value="">Choose a registered Active unit</option>
                {active.map((unit) => (
                  <option key={unit.unitReference} value={unit.code}>
                    {unit.localizedNames[locale] ?? unit.localizedNames[units?.defaultLocale ?? ""]}{" "}
                    · {unit.code}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <p>
                {selected.semanticDefinition} · up to {selected.quantityDecimalPlaces} decimal
                places.
              </p>
            )}
            <label>
              New SKU {index + 1} unit quantity
              <input
                value={row.quantity}
                required
                inputMode="decimal"
                maxLength={21}
                aria-invalid={
                  !selected ||
                  !sellingUnitQuantityValid(row.quantity, selected.quantityDecimalPlaces) ||
                  undefined
                }
                onChange={(e) => edit(row.reference, { quantity: e.currentTarget.value })}
              />
            </label>
            <button
              type="button"
              onClick={() => onChange(rows.filter((other) => other.reference !== row.reference))}
            >
              Remove new SKU {index + 1}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        disabled={!available || !active.length || !locale}
        onClick={() =>
          onChange([
            ...rows,
            {
              reference: serviceOperationReference(),
              code: "",
              name: "",
              unit: "",
              quantity: "",
              combination: "",
            },
          ])
        }
      >
        Add new Draft SKU
      </button>
      {rows.length > 0 && (
        <p>
          New SKUs remain Draft. Positive decimal quantities must match the selected unit's
          registered precision.
        </p>
      )}
    </fieldset>
  );
}
