import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import {
  createOptionSetAuthoringClient,
  OptionSetAuthoringClientError,
  type OptionSetEditorContent,
  type OptionSetAuthoringAction,
  type OptionSetAuthoringScope,
} from "./option-set-authoring-client.js";
import { createOptionSetAuthoringRecovery } from "./option-set-authoring-recovery.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import { parseCatalogReference } from "./catalog-product-command-values.js";
import { OptionSetPublicationPanel } from "./OptionSetPublicationPanel.js";
import { OptionSetHistoryPanel } from "./OptionSetHistoryPanel.js";
import { OptionSetCurrentPublicationPanel } from "./OptionSetCurrentPublicationPanel.js";

type SourceOption = OptionSetEditorContent["sourceAggregate"]["draft"]["options"][number];
type Detail = OptionSetEditorContent["optionDetails"][number];
export interface OptionSetFormOption {
  identity: { kind: "New" } | { kind: "Existing"; optionReference: string };
  stableCode: string;
  lifecycle: SourceOption["lifecycle"];
  localizedNames: Record<string, string>;
  localizedDescriptions: Record<string, string>;
  sortOrder: number;
  defaultEligible: boolean;
  triggeredOptionSetReference: string | null;
  conflictOptionCodes: string[];
}
export interface OptionSetForm {
  internalCode: string;
  defaultLocale: string;
  localizedNames: Record<string, string>;
  localizedDescriptions: Record<string, string>;
  displayStyle: "" | "SingleChoice" | "MultiChoice" | "Quantity";
  minimumSelection: string;
  maximumSelection: string;
  perOptionMaximumQuantity: string;
  maximumTotalQuantity: string;
  allowRepeatedOption: boolean;
  options: OptionSetFormOption[];
  archiveOptionReferences: string[];
  optionDetails: (Omit<Detail, "optionReference"> & { stableCode: string })[];
  conditionalRules: {
    ruleReference: string;
    whenAllSelectedCodes: string[];
    requiredOptionCodes: string[];
  }[];
  conflictRules: { ruleReference: string; forbiddenTogetherCodes: string[] }[];
  scopeSet: OptionSetEditorContent["scopeSet"];
  timeZone: string;
  fromLocal: string;
  fromOffset: string;
  untilLocal: string;
  untilOffset: string;
  acknowledged: boolean;
}
export function emptyOptionSetForm(): OptionSetForm {
  return {
    internalCode: "",
    defaultLocale: "",
    localizedNames: {},
    localizedDescriptions: {},
    displayStyle: "",
    minimumSelection: "",
    maximumSelection: "",
    perOptionMaximumQuantity: "",
    maximumTotalQuantity: "",
    allowRepeatedOption: false,
    options: [],
    archiveOptionReferences: [],
    optionDetails: [],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [],
    timeZone: "",
    fromLocal: "",
    fromOffset: "",
    untilLocal: "",
    untilOffset: "",
    acknowledged: false,
  };
}
export function optionSetFormFromContent(content: OptionSetEditorContent): OptionSetForm {
  const root = content.sourceAggregate,
    draft = root.draft,
    codeFor = (id: string) => {
      const option = draft.options.find((o) => o.optionReference === id);
      if (!option) throw new OptionSetAuthoringClientError("Invalid");
      return option.stableCode;
    };
  return {
    ...emptyOptionSetForm(),
    internalCode: root.internalCode,
    defaultLocale: draft.defaultLocale,
    localizedNames: { ...draft.localizedNames },
    localizedDescriptions: { ...draft.localizedDescriptions },
    displayStyle: draft.displayStyle,
    minimumSelection: String(draft.minimumSelection),
    maximumSelection: draft.maximumSelection === null ? "" : String(draft.maximumSelection),
    perOptionMaximumQuantity: String(draft.perOptionMaximumQuantity),
    maximumTotalQuantity:
      draft.maximumTotalQuantity === null ? "" : String(draft.maximumTotalQuantity),
    allowRepeatedOption: draft.allowRepeatedOption,
    options: draft.options.map((o) => ({
      identity: { kind: "Existing", optionReference: o.optionReference },
      stableCode: o.stableCode,
      lifecycle: o.lifecycle,
      localizedNames: { ...o.localizedNames },
      localizedDescriptions: { ...o.localizedDescriptions },
      sortOrder: o.sortOrder,
      defaultEligible: o.defaultEligible,
      triggeredOptionSetReference: o.triggeredOptionSetReference,
      conflictOptionCodes: o.conflictOptionReferences.map(codeFor),
    })),
    optionDetails: content.optionDetails.map(({ optionReference, ...detail }) => ({
      ...detail,
      stableCode: codeFor(optionReference),
    })),
    conditionalRules: content.conditionalRules.map((r) => ({
      ruleReference: r.ruleReference,
      whenAllSelectedCodes: r.whenAllSelected.map(codeFor),
      requiredOptionCodes: r.requiredOptionReferences.map(codeFor),
    })),
    conflictRules: content.conflictRules.map((r) => ({
      ruleReference: r.ruleReference,
      forbiddenTogetherCodes: r.forbiddenTogether.map(codeFor),
    })),
    scopeSet: content.scopeSet,
    timeZone: content.effectivePeriod.timeZone,
    fromLocal: content.effectivePeriod.effectiveFrom.localDateTime,
    fromOffset: String(content.effectivePeriod.effectiveFrom.utcOffsetMinutes),
    untilLocal: content.effectivePeriod.effectiveUntil?.localDateTime ?? "",
    untilOffset: content.effectivePeriod.effectiveUntil
      ? String(content.effectivePeriod.effectiveUntil.utcOffsetMinutes)
      : "",
  };
}
function boundary(local: string, offset: string) {
  const normalized =
    local.length === 16 ? local + ":00.000" : local.length === 19 ? local + ".000" : local;
  if (!normalized || !offset.trim()) throw new OptionSetAuthoringClientError("Invalid");
  const minutes = Number(offset),
    ms = Date.parse(normalized + "Z") - minutes * 60000;
  if (!Number.isInteger(minutes) || !Number.isFinite(ms))
    throw new OptionSetAuthoringClientError("Invalid");
  return {
    instant: new Date(ms).toISOString(),
    localDateTime: normalized,
    utcOffsetMinutes: minutes,
  };
}
export function optionSetCommandFromForm(
  form: OptionSetForm,
  action: OptionSetAuthoringAction,
  operationReference: string,
  baseline?: OptionSetEditorContent,
) {
  const number = (v: string) => {
      if (!/^\d+$/u.test(v)) throw new OptionSetAuthoringClientError("Invalid");
      return Number(v);
    },
    nullable = (v: string) => (v === "" ? null : number(v));
  const archived = new Set(form.archiveOptionReferences),
    options = form.options.filter(
      (o) => o.identity.kind !== "Existing" || !archived.has(o.identity.optionReference),
    ),
    codes = new Set(options.map((o) => o.stableCode));
  const draft = {
      defaultLocale: form.defaultLocale,
      localizedNames: form.localizedNames,
      localizedDescriptions: form.localizedDescriptions,
      displayStyle: form.displayStyle,
      minimumSelection: number(form.minimumSelection),
      maximumSelection: nullable(form.maximumSelection),
      perOptionMaximumQuantity: number(form.perOptionMaximumQuantity),
      maximumTotalQuantity: nullable(form.maximumTotalQuantity),
      allowRepeatedOption: form.allowRepeatedOption,
      options: options.map((o) => {
        const { identity, ...fields } = o;
        return action === "Edit" ? { ...fields, identity } : fields;
      }),
    },
    additionalContent = {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: form.optionDetails.filter((d) => codes.has(d.stableCode)),
      conditionalRules: form.conditionalRules,
      conflictRules: form.conflictRules,
      scopeSet: form.scopeSet,
      effectivePeriod: {
        timeZone: form.timeZone,
        effectiveFrom: boundary(form.fromLocal, form.fromOffset),
        effectiveUntil: form.untilLocal ? boundary(form.untilLocal, form.untilOffset) : null,
      },
    };
  if (action === "Create")
    return { internalCode: form.internalCode, draft, additionalContent, operationReference };
  if (!baseline) throw new OptionSetAuthoringClientError("Invalid");
  return {
    optionSetReference: baseline.sourceAggregate.optionSetReference,
    expectedAggregateVersion: baseline.sourceAggregate.aggregateVersion,
    draft,
    additionalContent,
    archiveOptionReferences: form.archiveOptionReferences,
    operationReference,
  };
}
function LocaleFields({
  label,
  values,
  onChange,
  disabled,
  description = false,
}: {
  label: string;
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  disabled: boolean;
  description?: boolean;
}) {
  const [newLocale, setNewLocale] = useState("");
  return (
    <fieldset disabled={disabled}>
      <legend>{label}</legend>
      {Object.entries(values).map(([code, text]) => (
        <div key={code}>
          <label>
            {code}
            {description ? (
              <textarea
                aria-label={`${label} ${code}`}
                value={text}
                maxLength={500}
                onChange={(e) => onChange({ ...values, [code]: e.target.value })}
              />
            ) : (
              <input
                aria-label={`${label} ${code}`}
                value={text}
                maxLength={120}
                onChange={(e) => onChange({ ...values, [code]: e.target.value })}
              />
            )}
          </label>
          <button
            type="button"
            onClick={() =>
              onChange(Object.fromEntries(Object.entries(values).filter(([key]) => key !== code)))
            }
          >
            Remove {code}
          </button>
        </div>
      ))}
      <label>
        Add locale
        <input
          value={newLocale}
          placeholder="en-CA"
          onChange={(e) => setNewLocale(e.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          if (newLocale && !Object.hasOwn(values, newLocale)) {
            onChange({ ...values, [newLocale]: "" });
            setNewLocale("");
          }
        }}
      >
        Add {label.toLowerCase()} locale
      </button>
    </fieldset>
  );
}
function Codes({
  label,
  selected,
  codes,
  onChange,
  disabled,
}: {
  label: string;
  selected: readonly string[];
  codes: readonly string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>{label}</legend>
      {codes.map((code) => (
        <label key={code}>
          <input
            type="checkbox"
            checked={selected.includes(code)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, code] : selected.filter((c) => c !== code))
            }
          />
          {code}
        </label>
      ))}
    </fieldset>
  );
}
export function OptionSetFullDraftForm({
  value,
  onChange,
  onSubmit,
  disabled,
  editing,
  storeReference,
}: {
  value: OptionSetForm;
  onChange: (v: OptionSetForm) => void;
  onSubmit: () => void;
  disabled: boolean;
  editing: boolean;
  storeReference: string | null;
}) {
  const patch = (part: Partial<OptionSetForm>) => onChange({ ...value, ...part }),
    codes = value.options.map((o) => o.stableCode),
    option = (index: number, part: Partial<OptionSetFormOption>) =>
      patch({ options: value.options.map((o, i) => (i === index ? { ...o, ...part } : o)) }),
    detail = (stableCode: string, part: Partial<OptionSetForm["optionDetails"][number]>) =>
      patch({
        optionDetails: value.optionDetails.map((d) =>
          d.stableCode === stableCode ? { ...d, ...part } : d,
        ),
      });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!disabled && value.acknowledged) onSubmit();
  };
  return (
    <form onSubmit={submit} aria-label="Complete Option Set Draft">
      <fieldset disabled={disabled}>
        <legend>Identity and localized content</legend>
        <label>
          Internal code
          <input
            required
            value={value.internalCode}
            readOnly={editing}
            onChange={(e) => patch({ internalCode: e.target.value })}
          />
        </label>
        <label>
          Default locale
          <input
            required
            value={value.defaultLocale}
            placeholder="en-CA"
            onChange={(e) => patch({ defaultLocale: e.target.value })}
          />
        </label>
        <LocaleFields
          label="Option Set names"
          values={value.localizedNames}
          onChange={(localizedNames) => patch({ localizedNames })}
          disabled={disabled}
        />
        <LocaleFields
          label="Option Set descriptions"
          values={value.localizedDescriptions}
          onChange={(localizedDescriptions) => patch({ localizedDescriptions })}
          disabled={disabled}
          description
        />
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Selection rules</legend>
        <label>
          Display style
          <select
            required
            value={value.displayStyle}
            onChange={(e) => {
              const displayStyle = e.target.value;
              if (
                displayStyle === "" ||
                displayStyle === "SingleChoice" ||
                displayStyle === "MultiChoice" ||
                displayStyle === "Quantity"
              )
                patch({ displayStyle });
            }}
          >
            <option value="">Choose style</option>
            <option value="SingleChoice">Single choice</option>
            <option value="MultiChoice">Multiple choice</option>
            <option value="Quantity">Quantity</option>
          </select>
        </label>
        <label>
          Minimum selections
          <input
            required
            type="number"
            min="0"
            step="1"
            value={value.minimumSelection}
            onChange={(e) => patch({ minimumSelection: e.target.value })}
          />
        </label>
        <label>
          Maximum selections (empty means no explicit maximum)
          <input
            type="number"
            min="0"
            step="1"
            value={value.maximumSelection}
            onChange={(e) => patch({ maximumSelection: e.target.value })}
          />
        </label>
        <label>
          Per-option maximum quantity
          <input
            required
            type="number"
            min="1"
            step="1"
            value={value.perOptionMaximumQuantity}
            onChange={(e) => patch({ perOptionMaximumQuantity: e.target.value })}
          />
        </label>
        <label>
          Maximum total quantity (empty means no explicit maximum)
          <input
            type="number"
            min="0"
            step="1"
            value={value.maximumTotalQuantity}
            onChange={(e) => patch({ maximumTotalQuantity: e.target.value })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.allowRepeatedOption}
            onChange={(e) => patch({ allowRepeatedOption: e.target.checked })}
          />
          Allow repeated options
        </label>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Options and recorded configuration</legend>
        {value.options.map((o, index) => {
          const d = value.optionDetails.find((d) => d.stableCode === o.stableCode),
            isArchived =
              o.identity.kind === "Existing" &&
              value.archiveOptionReferences.includes(o.identity.optionReference),
            readOnly = o.lifecycle === "Archived" || isArchived;
          return (
            <fieldset
              key={o.identity.kind === "Existing" ? o.identity.optionReference : index}
              disabled={readOnly}
            >
              <legend>
                Option {index + 1}: {o.stableCode || "New option"}
                {isArchived ? " · explicit Archive" : ""}
              </legend>
              <label>
                Stable code
                <input
                  required
                  readOnly={o.identity.kind === "Existing"}
                  value={o.stableCode}
                  onChange={(e) => {
                    const stableCode = e.target.value;
                    patch({
                      options: value.options.map((v, i) =>
                        i === index ? { ...v, stableCode } : v,
                      ),
                      optionDetails: value.optionDetails.map((v) =>
                        v.stableCode === o.stableCode ? { ...v, stableCode } : v,
                      ),
                    });
                  }}
                />
              </label>
              <LocaleFields
                label={`Option ${index + 1} names`}
                values={o.localizedNames}
                onChange={(localizedNames) => option(index, { localizedNames })}
                disabled={disabled || readOnly}
              />
              <LocaleFields
                label={`Option ${index + 1} descriptions`}
                values={o.localizedDescriptions}
                onChange={(localizedDescriptions) => option(index, { localizedDescriptions })}
                disabled={disabled || readOnly}
                description
              />
              <label>
                Lifecycle
                <select
                  value={o.lifecycle}
                  onChange={(e) => {
                    const lifecycle = e.target.value;
                    if (lifecycle === "Draft" || lifecycle === "Active" || lifecycle === "Inactive")
                      option(index, { lifecycle });
                  }}
                >
                  <option>Draft</option>
                  <option>Active</option>
                  <option>Inactive</option>
                  {o.lifecycle === "Archived" && <option>Archived</option>}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={o.defaultEligible}
                  onChange={(e) => option(index, { defaultEligible: e.target.checked })}
                />
                Eligible for default selection
              </label>
              <Codes
                label={`Conflicts for ${o.stableCode || "new option"}`}
                selected={o.conflictOptionCodes}
                codes={codes.filter((c) => c && c !== o.stableCode)}
                onChange={(conflictOptionCodes) => option(index, { conflictOptionCodes })}
                disabled={disabled || readOnly}
              />
              {d && (
                <>
                  <label>
                    Minimum option quantity
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={d.quantityRule.minimumQuantity}
                      onChange={(e) =>
                        detail(o.stableCode, {
                          quantityRule: {
                            ...d.quantityRule,
                            minimumQuantity: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Maximum option quantity
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={d.quantityRule.maximumQuantity}
                      onChange={(e) =>
                        detail(o.stableCode, {
                          quantityRule: {
                            ...d.quantityRule,
                            maximumQuantity: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <p>
                    {d.media ? "Recorded media retained" : "No media selected"} ·{" "}
                    {d.pricingRule ? "Recorded Pricing rule retained" : "No Pricing rule selected"}{" "}
                    ·{" "}
                    {d.consumption
                      ? `Recorded ${d.consumption.kind} consumption: ${d.consumption.quantity} ${d.consumption.unitCode}`
                      : "No consumption source selected"}{" "}
                    ·{" "}
                    {o.triggeredOptionSetReference
                      ? "Recorded nested Option Set retained"
                      : "No nested Option Set selected"}
                  </p>
                  {d.consumption && (
                    <label>
                      Recorded consumption quantity
                      <input
                        value={d.consumption.quantity}
                        inputMode="decimal"
                        onChange={(e) =>
                          detail(o.stableCode, {
                            consumption: d.consumption
                              ? { ...d.consumption, quantity: e.target.value }
                              : null,
                          })
                        }
                      />
                    </label>
                  )}
                  {d.media && (
                    <LocaleFields
                      label={`Option ${index + 1} media alternative text`}
                      values={d.media.altText}
                      disabled={disabled || readOnly}
                      onChange={(altText) =>
                        detail(o.stableCode, { media: d.media ? { ...d.media, altText } : null })
                      }
                    />
                  )}
                </>
              )}
              <button
                type="button"
                disabled={index === 0}
                onClick={() => {
                  const options = [...value.options],
                    previous = options[index - 1];
                  if (!previous) return;
                  options[index - 1] = o;
                  options[index] = previous;
                  patch({ options: options.map((v, i) => ({ ...v, sortOrder: i })) });
                }}
              >
                Move option up
              </button>
              {o.identity.kind === "New" && (
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      options: value.options.filter((_, i) => i !== index),
                      optionDetails: value.optionDetails.filter(
                        (d) => d.stableCode !== o.stableCode,
                      ),
                    })
                  }
                >
                  Remove unsaved new option
                </button>
              )}
            </fieldset>
          );
        })}
        {value.options.map((o, index) =>
          o.identity.kind === "Existing" && o.lifecycle !== "Archived" ? (
            <label key={index}>
              <input
                type="checkbox"
                checked={value.archiveOptionReferences.includes(o.identity.optionReference)}
                onChange={(e) => {
                  if (o.identity.kind !== "Existing") return;
                  patch({
                    archiveOptionReferences: e.target.checked
                      ? [...value.archiveOptionReferences, o.identity.optionReference]
                      : value.archiveOptionReferences.filter(
                          (id) =>
                            o.identity.kind !== "Existing" || id !== o.identity.optionReference,
                        ),
                  });
                }}
              />
              Archive {o.stableCode} explicitly; original history is retained
            </label>
          ) : null,
        )}
        <button
          type="button"
          disabled={value.options.some((o) => !o.stableCode)}
          onClick={() => {
            patch({
              options: [
                ...value.options,
                {
                  identity: { kind: "New" },
                  stableCode: "",
                  lifecycle: "Draft",
                  localizedNames: {},
                  localizedDescriptions: {},
                  sortOrder: value.options.length,
                  defaultEligible: false,
                  triggeredOptionSetReference: null,
                  conflictOptionCodes: [],
                },
              ],
              optionDetails: [
                ...value.optionDetails,
                {
                  stableCode: "",
                  quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
                  media: null,
                  pricingRule: null,
                  consumption: null,
                  triggeredOptionSetVersionReference: null,
                },
              ],
            });
          }}
        >
          Add option
        </button>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Conditional and conflict rules</legend>
        {value.conditionalRules.map((r, i) => (
          <fieldset key={r.ruleReference}>
            <legend>Conditional rule {i + 1}</legend>
            <Codes
              label="When all selected"
              codes={codes}
              selected={r.whenAllSelectedCodes}
              disabled={disabled}
              onChange={(whenAllSelectedCodes) =>
                patch({
                  conditionalRules: value.conditionalRules.map((v, n) =>
                    n === i ? { ...v, whenAllSelectedCodes } : v,
                  ),
                })
              }
            />
            <Codes
              label="Require options"
              codes={codes}
              selected={r.requiredOptionCodes}
              disabled={disabled}
              onChange={(requiredOptionCodes) =>
                patch({
                  conditionalRules: value.conditionalRules.map((v, n) =>
                    n === i ? { ...v, requiredOptionCodes } : v,
                  ),
                })
              }
            />
            <button
              type="button"
              onClick={() =>
                patch({ conditionalRules: value.conditionalRules.filter((_, n) => n !== i) })
              }
            >
              Remove conditional rule
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            patch({
              conditionalRules: [
                ...value.conditionalRules,
                {
                  ruleReference: serviceOperationReference(),
                  whenAllSelectedCodes: [],
                  requiredOptionCodes: [],
                },
              ],
            })
          }
        >
          Add conditional rule
        </button>
        {value.conflictRules.map((r, i) => (
          <fieldset key={r.ruleReference}>
            <legend>Conflict rule {i + 1}</legend>
            <Codes
              label="Cannot be selected together"
              codes={codes}
              selected={r.forbiddenTogetherCodes}
              disabled={disabled}
              onChange={(forbiddenTogetherCodes) =>
                patch({
                  conflictRules: value.conflictRules.map((v, n) =>
                    n === i ? { ...v, forbiddenTogetherCodes } : v,
                  ),
                })
              }
            />
            <button
              type="button"
              onClick={() =>
                patch({ conflictRules: value.conflictRules.filter((_, n) => n !== i) })
              }
            >
              Remove conflict rule
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            patch({
              conflictRules: [
                ...value.conflictRules,
                { ruleReference: serviceOperationReference(), forbiddenTogetherCodes: [] },
              ],
            })
          }
        >
          Add conflict rule
        </button>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Scope and effective period</legend>
        {value.scopeSet.map((s, i) => (
          <p key={i}>
            Recorded {s.level} scope
            <label>
              Channel codes (comma separated)
              <input
                value={s.channelCodes.join(",")}
                onChange={(e) =>
                  patch({
                    scopeSet: value.scopeSet.map((v, n) =>
                      n === i
                        ? {
                            ...v,
                            channelCodes: e.target.value
                              .split(",")
                              .map((c) => c.trim())
                              .filter(Boolean),
                          }
                        : v,
                    ),
                  })
                }
              />
            </label>
            <label>
              Order type codes (comma separated)
              <input
                value={s.orderTypeCodes.join(",")}
                onChange={(e) =>
                  patch({
                    scopeSet: value.scopeSet.map((v, n) =>
                      n === i
                        ? {
                            ...v,
                            orderTypeCodes: e.target.value
                              .split(",")
                              .map((c) => c.trim())
                              .filter(Boolean),
                          }
                        : v,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              onClick={() => patch({ scopeSet: value.scopeSet.filter((_, n) => n !== i) })}
            >
              Remove scope
            </button>
          </p>
        ))}
        <button
          type="button"
          onClick={() =>
            patch({
              scopeSet: [
                ...value.scopeSet,
                { level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] },
              ],
            })
          }
        >
          Add current Brand scope
        </button>
        <button
          type="button"
          disabled={!storeReference}
          onClick={() => {
            if (storeReference)
              patch({
                scopeSet: [
                  ...value.scopeSet,
                  {
                    level: "Store",
                    reference: storeReference,
                    channelCodes: [],
                    orderTypeCodes: [],
                  },
                ],
              });
          }}
        >
          Add selected Store scope
        </button>
        <label>
          IANA time zone
          <input
            required
            value={value.timeZone}
            placeholder="America/Toronto"
            onChange={(e) => patch({ timeZone: e.target.value })}
          />
        </label>
        <label>
          Effective from local date and time
          <input
            required
            type="datetime-local"
            step="0.001"
            value={value.fromLocal}
            onChange={(e) => patch({ fromLocal: e.target.value })}
          />
        </label>
        <label>
          From UTC offset in minutes
          <input
            required
            type="number"
            min="-840"
            max="840"
            step="1"
            value={value.fromOffset}
            onChange={(e) => patch({ fromOffset: e.target.value })}
          />
        </label>
        <label>
          Effective until local date and time (optional)
          <input
            type="datetime-local"
            step="0.001"
            value={value.untilLocal}
            onChange={(e) => patch({ untilLocal: e.target.value })}
          />
        </label>
        <label>
          Until UTC offset in minutes
          <input
            type="number"
            min="-840"
            max="840"
            step="1"
            required={Boolean(value.untilLocal)}
            value={value.untilOffset}
            onChange={(e) => patch({ untilOffset: e.target.value })}
          />
        </label>
      </fieldset>
      <p role="note">
        Media, Pricing, consumption and nested Option Set source selection are not connected yet.
        Recorded references are retained. Draft content is not publication or reference
        qualification.
      </p>
      <label>
        <input
          type="checkbox"
          disabled={disabled}
          checked={value.acknowledged}
          onChange={(e) => patch({ acknowledged: e.target.checked })}
        />
        I reviewed this complete Draft and its unqualified source configuration
      </label>
      <button type="submit" disabled={disabled || !value.acknowledged}>
        {editing ? "Save complete Draft" : "Create Option Set"}
      </button>
    </form>
  );
}
export interface OptionSetAuthoringPageProps {
  readonly brandReference: string | null;
  readonly storeReference: string | null;
  readonly brandLabel?: string;
  readonly storeLabel?: string;
  readonly csrf: string;
  readonly optionSetReference?: string;
}
export function OptionSetCreatePage(props: OptionSetAuthoringPageProps) {
  return <OptionSetWorkspace {...props} mode="Create" />;
}
export function OptionSetDetailPage(props: OptionSetAuthoringPageProps) {
  return <OptionSetWorkspace {...props} mode="Detail" />;
}
export function OptionSetEditPage(props: OptionSetAuthoringPageProps) {
  return <OptionSetWorkspace {...props} mode="Edit" />;
}
function OptionSetWorkspace(
  props: OptionSetAuthoringPageProps & { mode: "Create" | "Detail" | "Edit" },
) {
  const params = useParams(),
    set =
      props.mode === "Create"
        ? null
        : (props.optionSetReference ?? params.optionSetId ?? params.id ?? null),
    identity = useRef({
      brand: props.brandReference,
      store: props.storeReference,
      csrf: props.csrf,
      mode: props.mode,
      set,
      epoch: 0,
    });
  if (
    identity.current.brand !== props.brandReference ||
    identity.current.store !== props.storeReference ||
    identity.current.csrf !== props.csrf ||
    identity.current.mode !== props.mode ||
    identity.current.set !== set
  )
    identity.current = {
      brand: props.brandReference,
      store: props.storeReference,
      csrf: props.csrf,
      mode: props.mode,
      set,
      epoch: identity.current.epoch + 1,
    };
  const epoch = identity.current.epoch,
    action = props.mode === "Create" ? "Create" : "Edit",
    client = useMemo(() => createOptionSetAuthoringClient(), []),
    capability = useMemo(() => createStoreCapabilityClient(), []),
    manager = useMemo(
      () =>
        props.mode !== "Detail" && (set || action === "Create")
          ? createOptionSetAuthoringRecovery({
              action,
              optionSetReference: set,
              currentContext: () => identity.current.epoch,
              client,
            })
          : null,
      [action, set, epoch, client, props.mode],
    );
  const [selected, setSelected] = useState<{
      brandReference: string;
      storeReference: string;
    } | null>(null),
    [form, setForm] = useState(emptyOptionSetForm),
    [current, setCurrent] = useState<OptionSetEditorContent | null>(null),
    [observedScope, setObservedScope] = useState<OptionSetAuthoringScope | null>(null),
    [message, setMessage] = useState("Loading current identity and pending operation…"),
    [busy, setBusy] = useState(true),
    [dirty, setDirty] = useState(false),
    [publicationPending, setPublicationPending] = useState(props.mode !== "Create"),
    [revision, setRevision] = useState(0),
    [loadedEpoch, setLoadedEpoch] = useState(-1),
    abort = useRef<AbortController | null>(null);
  const valid = () => identity.current.epoch === epoch,
    status = manager?.view(),
    blocked =
      busy ||
      loadedEpoch !== epoch ||
      !status?.checked ||
      status.pending ||
      publicationPending ||
      !selected ||
      !/^[-_A-Za-z0-9]{43}$/u.test(props.csrf) ||
      props.mode === "Detail" ||
      (props.mode === "Create" && Boolean(current || status?.confirmedSet)) ||
      (props.mode === "Edit" && !current);
  useEffect(() => {
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setBusy(true);
    setSelected(null);
    setCurrent(null);
    setObservedScope(null);
    setForm(emptyOptionSetForm());
    setDirty(false);
    setPublicationPending(props.mode !== "Create");
    setLoadedEpoch(-1);
    setMessage("Loading current identity and pending operation…");
    void (async () => {
      try {
        if (!props.storeReference || !/^[-_A-Za-z0-9]{43}$/u.test(props.csrf))
          throw new OptionSetAuthoringClientError("Unavailable");
        if (set) parseCatalogReference(set);
        const source = await capability.load(
          {
            scope: {
              storeReference: props.storeReference,
              ...(props.brandReference ? { brandReference: props.brandReference } : {}),
            },
            capabilityKey:
              props.mode === "Create"
                ? "catalog.cat_optionset_create"
                : props.mode === "Detail"
                  ? "catalog.cat_optionset_detail"
                  : "catalog.cat_optionset_edit",
            csrf: props.csrf,
          },
          controller.signal,
        );
        if (!valid() || controller.signal.aborted) return;
        if (source.backendExecution !== "Allow") {
          setMessage(
            source.reason === "Disabled"
              ? "Disabled: this Option Set feature is disabled."
              : "Unavailable: current capability is unavailable.",
          );
          return;
        }
        const anchor = {
          brandReference: source.brandReference,
          storeReference: source.storeReference,
        };
        setSelected(anchor);
        if (props.mode === "Detail") {
          if (!set) throw new OptionSetAuthoringClientError("Invalid");
          const view = await client.readCurrent(
            { optionSetReference: set, expectedAggregateVersion: null },
            anchor,
            props.csrf,
            controller.signal,
          );
          if (!valid() || controller.signal.aborted) return;
          setCurrent(view.content);
          setObservedScope(view.scope);
          setForm(optionSetFormFromContent(view.content));
        } else {
          if (!manager) throw new OptionSetAuthoringClientError("Unavailable");
          const scope = await manager.inspect(anchor, props.csrf, controller.signal);
          if (!valid() || controller.signal.aborted) return;
          setLoadedEpoch(epoch);
          if (set) {
            const view = await client.readCurrent(
              { optionSetReference: set, expectedAggregateVersion: null },
              scope,
              props.csrf,
              controller.signal,
            );
            if (!valid() || controller.signal.aborted) return;
            setCurrent(view.content);
            setObservedScope(view.scope);
            setForm(optionSetFormFromContent(view.content));
          }
        }
        setLoadedEpoch(epoch);
        setMessage(
          manager?.view().pending
            ? "Original operation pending. Resolve its outcome before a new save."
            : "Current Draft; source qualification is not evaluated.",
        );
      } catch (error) {
        if (valid() && !controller.signal.aborted)
          setMessage(
            error instanceof OptionSetAuthoringClientError ||
              error instanceof StoreCapabilityClientError
              ? `${error.code}: current identity or Draft is unavailable.`
              : "Unavailable: current identity or Draft is unavailable.",
          );
      } finally {
        if (valid() && !controller.signal.aborted) {
          setBusy(false);
          setRevision((v) => v + 1);
        }
      }
    })();
    return () => controller.abort();
  }, [
    manager,
    props.brandReference,
    props.storeReference,
    props.csrf,
    set,
    client,
    capability,
    epoch,
    props.mode,
  ]);
  async function run(kind: "Save" | "Retry" | "Resolve") {
    if (
      busy ||
      (publicationPending && kind !== "Resolve") ||
      !manager ||
      !selected ||
      loadedEpoch !== epoch
    )
      return;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setBusy(true);
    try {
      if (kind === "Save") {
        if (blocked) return;
        const command = optionSetCommandFromForm(
            form,
            action,
            serviceOperationReference(),
            current ?? undefined,
          ),
          result = await manager.write(
            command,
            selected,
            props.csrf,
            current ?? undefined,
            controller.signal,
          );
        if (!valid() || controller.signal.aborted) return;
        setCurrent(result.current.content);
        setForm(optionSetFormFromContent(result.current.content));
        setDirty(false);
        setMessage("Original save confirmed; current content refreshed.");
      } else if (kind === "Retry") {
        const result = await manager.retry(selected, props.csrf, controller.signal);
        if (!valid() || controller.signal.aborted) return;
        setCurrent(result.current.content);
        setForm(optionSetFormFromContent(result.current.content));
        setDirty(false);
        setMessage("Original save confirmed; current content refreshed.");
      } else {
        const result = await manager.resolve(selected, props.csrf, controller.signal);
        if (!valid() || controller.signal.aborted) return;
        if (result.current) {
          setCurrent(result.current.content);
          setForm(optionSetFormFromContent(result.current.content));
          setDirty(false);
        }
        setMessage(
          result.result.resolution.outcome === "Committed"
            ? "Original committed save recovered; current content refreshed."
            : "Original absence was permanently abandoned. A new save may now be started.",
        );
      }
    } catch (error) {
      if (valid() && !controller.signal.aborted)
        setMessage(
          error instanceof OptionSetAuthoringClientError
            ? `${error.code}${error.attemptCode ? " / " + error.attemptCode : ""}: request not confirmed. Retain and resolve the original operation.`
            : "Unavailable: retain and resolve the original operation.",
        );
    } finally {
      if (valid() && !controller.signal.aborted) {
        setBusy(false);
        setRevision((v) => v + 1);
      }
    }
  }
  void revision;
  const actualSet = current?.sourceAggregate.optionSetReference ?? status?.confirmedSet ?? set;
  return (
    <main className="catalog-page" aria-busy={busy}>
      <header>
        <p>
          {props.mode === "Create"
            ? "CAT-OPTIONSET-CREATE"
            : props.mode === "Edit"
              ? "CAT-OPTIONSET-EDIT"
              : "CAT-OPTIONSET-DETAIL"}
        </p>
        <h1>
          {props.mode === "Create"
            ? "Create Option Set"
            : props.mode === "Edit"
              ? "Edit Option Set Draft"
              : "Option Set detail"}
        </h1>
        <p>
          {props.brandLabel ?? "Selected Brand"} · {props.storeLabel ?? "Selected Store"}
        </p>
        <Link to="/app/commerce/option-sets">Back to Option Sets</Link>
      </header>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {status?.pending && (
        <section aria-label="Original operation recovery">
          <p>Pending original blocks new operations, including after reload.</p>
          <button
            type="button"
            disabled={busy || loadedEpoch !== epoch}
            onClick={() => void run("Resolve")}
          >
            Resolve original operation
          </button>
          <button
            type="button"
            disabled={busy || !status.canRetry || loadedEpoch !== epoch}
            onClick={() => void run("Retry")}
          >
            Retry exact original request
          </button>
          {status.cleanupFailed && (
            <p>Local durable cleanup failed. The original remains locked.</p>
          )}
        </section>
      )}
      <button
        type="button"
        disabled={busy || publicationPending}
        onClick={() => {
          setLoadedEpoch(-1);
          identity.current = { ...identity.current, epoch: identity.current.epoch + 1 };
          setRevision((v) => v + 1);
        }}
      >
        Refresh current Draft (discard unsaved fields)
      </button>
      {loadedEpoch === epoch && dirty && current && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setForm(optionSetFormFromContent(current));
            setDirty(false);
          }}
        >
          Discard unsaved fields
        </button>
      )}
      {loadedEpoch === epoch && current && (
        <section aria-label="Current complete Draft">
          <h2>
            {
              current.sourceAggregate.draft.localizedNames[
                current.sourceAggregate.draft.defaultLocale
              ]
            }
          </h2>
          <p>
            {current.sourceAggregate.internalCode} · Draft · current root{" "}
            {current.sourceAggregate.aggregateVersion} · reference eligibility not evaluated
          </p>
          <p>
            The editable Draft is separate from recorded versions and the current Published content.
          </p>
          {actualSet && (
            <>
              <Link to={`/app/commerce/option-sets/${actualSet}`}>Open current detail</Link>
              {props.mode !== "Edit" && (
                <Link to={`/app/commerce/option-sets/${actualSet}/edit`}>Edit current Draft</Link>
              )}
            </>
          )}
        </section>
      )}
      {props.mode === "Detail" && set && observedScope && loadedEpoch === epoch && (
        <>
          <OptionSetCurrentPublicationPanel
            optionSetReference={set}
            scope={observedScope}
            csrf={props.csrf}
            refreshKey={current?.sourceAggregate.aggregateVersion ?? 0}
          />
          <OptionSetHistoryPanel
            optionSetReference={set}
            scope={observedScope}
            csrf={props.csrf}
            refreshKey={current?.sourceAggregate.aggregateVersion ?? 0}
          />
        </>
      )}
      {props.mode !== "Create" && set && selected && (
        <OptionSetPublicationPanel
          optionSetReference={set}
          savedAggregateVersion={current?.sourceAggregate.aggregateVersion ?? null}
          scope={selected}
          csrf={props.csrf}
          blocked={busy || dirty || loadedEpoch !== epoch || Boolean(status?.pending)}
          unsavedChanges={dirty}
          onPendingChange={setPublicationPending}
          onCurrentRefresh={async () => {
            const controller = new AbortController();
            const view = await client.readCurrent(
              { optionSetReference: set, expectedAggregateVersion: null },
              selected,
              props.csrf,
              controller.signal,
            );
            if (!valid()) throw new OptionSetAuthoringClientError("ScopeChanged");
            setCurrent(view.content);
            setObservedScope(view.scope);
            setForm(optionSetFormFromContent(view.content));
            setDirty(false);
          }}
        />
      )}
      <OptionSetFullDraftForm
        value={loadedEpoch === epoch ? form : emptyOptionSetForm()}
        onChange={(value) => {
          setDirty(true);
          setForm(value);
        }}
        onSubmit={() => void run("Save")}
        disabled={blocked}
        editing={props.mode !== "Create" || Boolean(current)}
        storeReference={props.storeReference}
      />
      {props.mode === "Create" && actualSet && (
        <p>
          Create was confirmed.{" "}
          <Link to={`/app/commerce/option-sets/${actualSet}`}>
            Open the actual created Option Set
          </Link>{" "}
          to refresh or edit.
        </p>
      )}
    </main>
  );
}
