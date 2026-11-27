import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseCanonicalInstant } from "@bop/tenant";
import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import {
  createOptionPriceRuleSnapshot,
  type OptionPriceRuleSnapshot,
} from "../domain/option-price.js";
import {
  createMoney,
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
  type CurrencyMetadataSnapshot,
  type PricingReference,
  type PricingDigest,
} from "../domain/money-tax-contract.js";

export class OptionPriceAuthoringError extends Error {
  constructor(
    readonly code:
      | "OPTION_PRICE_INPUT_INVALID"
      | "OPTION_PRICE_PERMISSION_DENIED"
      | "OPTION_PRICE_VERSION_CONFLICT"
      | "OPTION_PRICE_IDEMPOTENCY_CONFLICT"
      | "OPTION_PRICE_LIFECYCLE_CONFLICT"
      | "OPTION_PRICE_APPROVAL_REQUIRED"
      | "OPTION_PRICE_CONFLICT"
      | "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Option price operation is unavailable");
    this.name = "OptionPriceAuthoringError";
  }
}
export const optionPriceAuthoringFields = Object.freeze([
  "identity",
  "binding",
  "option",
  "aggregateVersion",
  "currentPublished",
  "draft",
  "scope",
  "channel",
  "orderType",
  "currencyMetadata",
  "unitAmount",
  "includedQuantity",
  "effectivePeriod",
  "originalOperation",
  "audit",
  "event",
] as const);
export const optionPriceAuthoringActions = [
  "CreateDraft",
  "ReplaceDraft",
  "Publish",
  "Archive",
] as const;
export type OptionPriceAuthoringAction = (typeof optionPriceAuthoringActions)[number];
export interface OptionPriceAuthoringContent {
  readonly skuReference: PricingReference | null;
  readonly scopeKind: OptionPriceRuleSnapshot["scopeKind"];
  readonly scopeReference: PricingReference | null;
  readonly channelCode: OptionPriceRuleSnapshot["channelCode"];
  readonly orderType: OptionPriceRuleSnapshot["orderType"];
  readonly unitAmountMinor: string;
  readonly includedQuantity: number;
  readonly effectivePeriod: EffectivePeriod;
}
export interface OptionPriceAuthoringCommand {
  readonly action: OptionPriceAuthoringAction;
  readonly operationReference: PricingReference;
  readonly ruleReference: PricingReference;
  readonly expectedAggregateVersion: number | null;
  readonly bindingReference: PricingReference | null;
  readonly optionReference: PricingReference | null;
  readonly content: OptionPriceAuthoringContent | null;
}
export interface OptionPriceAuthoringState {
  readonly profile: "OptionPriceAuthoringStateV1";
  readonly brandReference: PricingReference;
  readonly ruleReference: PricingReference;
  readonly bindingReference: PricingReference;
  readonly optionReference: PricingReference;
  readonly aggregateVersion: number;
  readonly createdAt: string;
  readonly createdByActorReference: PricingReference;
  readonly updatedAt: string;
  readonly draftAuthorActorReference: PricingReference | null;
  readonly draft: OptionPriceRuleSnapshot | null;
  readonly currentPublished: OptionPriceRuleSnapshot | null;
  readonly latestVersion: OptionPriceRuleSnapshot;
}
export interface OptionPriceAuthoringOperation {
  readonly profile: "OptionPriceAuthoringOperationV1";
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly actorReference: PricingReference;
  readonly command: OptionPriceAuthoringCommand;
  readonly intentDigest: PricingDigest;
  readonly outcome: "Committed" | "Abandoned";
  readonly state: OptionPriceAuthoringState | null;
  readonly auditReference: PricingReference;
  readonly eventReference: PricingReference | null;
  readonly occurredAt: string;
}
export const optionPriceAuthoringEventTypes = Object.freeze({
  CreateDraft: "OptionPriceDraftCreated",
  ReplaceDraft: "OptionPriceDraftReplaced",
  Publish: "OptionPriceVersionPublished",
  Archive: "OptionPriceArchived",
} as const);
export interface OptionPriceAuthoringEvent {
  readonly ruleReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly bindingReference: PricingReference;
  readonly optionReference: PricingReference;
  readonly aggregateVersion: number;
  readonly lifecycle: OptionPriceRuleSnapshot["lifecycle"];
  readonly currencyCode: string;
  readonly snapshotDigest: PricingDigest;
  readonly occurredAt: string;
}
export function optionPriceClosed(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new OptionPriceAuthoringError("OPTION_PRICE_INPUT_INVALID");
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new OptionPriceAuthoringError("OPTION_PRICE_INPUT_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new OptionPriceAuthoringError("OPTION_PRICE_INPUT_INVALID");
    result[key] = descriptor.value;
  }
  return result;
}
const invalid = (): never => {
  throw new OptionPriceAuthoringError("OPTION_PRICE_INPUT_INVALID");
};
export function optionPricePositive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    return invalid();
  return Number(value);
}
const optionalReference = (value: unknown) =>
  value === null ? null : parsePricingReference(value);
export function parseOptionPriceAuthoringContent(value: unknown): OptionPriceAuthoringContent {
  const r = optionPriceClosed(value, [
    "skuReference",
    "scopeKind",
    "scopeReference",
    "channelCode",
    "orderType",
    "unitAmountMinor",
    "includedQuantity",
    "effectivePeriod",
  ]);
  if (
    !["Brand", "Store", "StoreGroup", "Region"].includes(String(r.scopeKind)) ||
    (r.scopeKind === "Brand" ? r.scopeReference !== null : r.scopeReference === null) ||
    (r.orderType !== null && r.orderType !== "DineIn" && r.orderType !== "Pickup") ||
    typeof r.unitAmountMinor !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(r.unitAmountMinor) ||
    BigInt(r.unitAmountMinor) > 9223372036854775807n ||
    !Number.isSafeInteger(r.includedQuantity) ||
    Number(r.includedQuantity) < 0 ||
    Number(r.includedQuantity) > 2147483647
  )
    return invalid();
  return Object.freeze({
    skuReference: optionalReference(r.skuReference),
    scopeKind: r.scopeKind as OptionPriceAuthoringContent["scopeKind"],
    scopeReference: optionalReference(r.scopeReference),
    channelCode: r.channelCode === null ? null : parsePricingCode(r.channelCode),
    orderType: r.orderType as OptionPriceAuthoringContent["orderType"],
    unitAmountMinor: r.unitAmountMinor,
    includedQuantity: Number(r.includedQuantity),
    effectivePeriod: createEffectivePeriod(r.effectivePeriod as EffectivePeriod),
  });
}
export function parseOptionPriceAuthoringCommand(value: unknown): OptionPriceAuthoringCommand {
  const r = optionPriceClosed(value, [
    "action",
    "operationReference",
    "ruleReference",
    "expectedAggregateVersion",
    "bindingReference",
    "optionReference",
    "content",
  ]);
  if (!optionPriceAuthoringActions.includes(r.action as OptionPriceAuthoringAction))
    return invalid();
  const action = r.action as OptionPriceAuthoringAction;
  if (
    action === "CreateDraft"
      ? r.bindingReference === null || r.optionReference === null || r.content === null
      : r.bindingReference !== null ||
        r.optionReference !== null ||
        r.expectedAggregateVersion === null ||
        (action === "ReplaceDraft") !== (r.content !== null)
  )
    return invalid();
  return Object.freeze({
    action,
    operationReference: parsePricingReference(r.operationReference),
    ruleReference: parsePricingReference(r.ruleReference),
    expectedAggregateVersion:
      r.expectedAggregateVersion === null ? null : optionPricePositive(r.expectedAggregateVersion),
    bindingReference: optionalReference(r.bindingReference),
    optionReference: optionalReference(r.optionReference),
    content: r.content === null ? null : parseOptionPriceAuthoringContent(r.content),
  });
}
export function optionPriceWireSnapshot(value: OptionPriceRuleSnapshot) {
  const parsed = createOptionPriceRuleSnapshot(value);
  return Object.freeze({
    ...parsed,
    unitAmount: { ...parsed.unitAmount, amountMinor: parsed.unitAmount.amountMinor.toString() },
  });
}
export function parseOptionPriceWireSnapshot(value: unknown): OptionPriceRuleSnapshot {
  const r = optionPriceClosed(value, [
      "ruleReference",
      "versionReference",
      "snapshotDigest",
      "brandReference",
      "bindingReference",
      "optionReference",
      "skuReference",
      "scopeKind",
      "scopeReference",
      "channelCode",
      "orderType",
      "lifecycle",
      "currencyMetadata",
      "unitAmount",
      "includedQuantity",
      "quantityBasis",
      "effectivePeriod",
      "createdAt",
    ]),
    m = optionPriceClosed(r.unitAmount, ["amountMinor", "currencyCode"]);
  if (
    typeof m.amountMinor !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(m.amountMinor) ||
    BigInt(m.amountMinor) > 9223372036854775807n
  )
    return invalid();
  return createOptionPriceRuleSnapshot({
    ...r,
    unitAmount: createMoney({
      amountMinor: BigInt(m.amountMinor),
      currencyCode: m.currencyCode as CurrencyMetadataSnapshot["currencyCode"],
    }),
  } as unknown as OptionPriceRuleSnapshot);
}
export function optionPriceIntentDigest(command: OptionPriceAuthoringCommand): PricingDigest {
  return parsePricingDigest(
    "sha256:" + sha256Hex(canonicalizeRfc8785(parseOptionPriceAuthoringCommand(command))),
  );
}
export function optionPriceWireState(value: OptionPriceAuthoringState) {
  return Object.freeze({
    ...value,
    draft: value.draft === null ? null : optionPriceWireSnapshot(value.draft),
    currentPublished:
      value.currentPublished === null ? null : optionPriceWireSnapshot(value.currentPublished),
    latestVersion: optionPriceWireSnapshot(value.latestVersion),
  });
}
export function parseOptionPriceAuthoringState(value: unknown): OptionPriceAuthoringState {
  const r = optionPriceClosed(value, [
    "profile",
    "brandReference",
    "ruleReference",
    "bindingReference",
    "optionReference",
    "aggregateVersion",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
    "draftAuthorActorReference",
    "draft",
    "currentPublished",
    "latestVersion",
  ]);
  if (r.profile !== "OptionPriceAuthoringStateV1") return invalid();
  const brandReference = parsePricingReference(r.brandReference),
    ruleReference = parsePricingReference(r.ruleReference),
    bindingReference = parsePricingReference(r.bindingReference),
    optionReference = parsePricingReference(r.optionReference),
    createdAt = parseCanonicalInstant(r.createdAt),
    updatedAt = parseCanonicalInstant(r.updatedAt),
    draft = r.draft === null ? null : parseOptionPriceWireSnapshot(r.draft),
    currentPublished =
      r.currentPublished === null ? null : parseOptionPriceWireSnapshot(r.currentPublished),
    latestVersion = parseOptionPriceWireSnapshot(r.latestVersion),
    draftAuthorActorReference = optionalReference(r.draftAuthorActorReference);
  if (
    createdAt > updatedAt ||
    latestVersion.createdAt !== updatedAt ||
    (draft === null) !== (draftAuthorActorReference === null) ||
    (draft !== null && draft.lifecycle !== "Draft") ||
    (currentPublished !== null && currentPublished.lifecycle !== "Published") ||
    (draft !== null &&
      currentPublished !== null &&
      draft.versionReference === currentPublished.versionReference)
  )
    return invalid();
  for (const snapshot of [draft, currentPublished, latestVersion])
    if (
      snapshot !== null &&
      (snapshot.brandReference !== brandReference ||
        snapshot.ruleReference !== ruleReference ||
        snapshot.bindingReference !== bindingReference ||
        snapshot.optionReference !== optionReference ||
        snapshot.createdAt < createdAt ||
        snapshot.createdAt > updatedAt)
    )
      return invalid();
  return Object.freeze({
    profile: "OptionPriceAuthoringStateV1",
    brandReference,
    ruleReference,
    bindingReference,
    optionReference,
    aggregateVersion: optionPricePositive(r.aggregateVersion),
    createdAt,
    createdByActorReference: parsePricingReference(r.createdByActorReference),
    updatedAt,
    draftAuthorActorReference,
    draft,
    currentPublished,
    latestVersion,
  });
}
export function materializeOptionPriceVersion(input: {
  command: OptionPriceAuthoringCommand;
  current: OptionPriceAuthoringState | null;
  brandReference: string;
  versionReference: string;
  occurredAt: string;
  currencyMetadata: CurrencyMetadataSnapshot;
}): OptionPriceRuleSnapshot {
  const command = parseOptionPriceAuthoringCommand(input.command),
    current =
      input.current === null
        ? null
        : parseOptionPriceAuthoringState(optionPriceWireState(input.current)),
    currency = createCurrencyMetadataSnapshot(input.currencyMetadata),
    occurredAt = parseCanonicalInstant(input.occurredAt),
    body = command.content;
  if (
    current &&
    (current.ruleReference !== command.ruleReference ||
      current.brandReference !== parsePricingReference(input.brandReference))
  )
    return invalid();
  if (
    command.action === "CreateDraft" &&
    current &&
    (current.draft !== null ||
      current.currentPublished === null ||
      command.bindingReference !== current.bindingReference ||
      command.optionReference !== current.optionReference)
  )
    throw new OptionPriceAuthoringError("OPTION_PRICE_LIFECYCLE_CONFLICT");
  if (
    (command.action === "ReplaceDraft" && !current?.draft) ||
    (command.action === "Publish" && !current?.draft) ||
    (command.action === "Archive" && !current?.currentPublished)
  )
    throw new OptionPriceAuthoringError("OPTION_PRICE_LIFECYCLE_CONFLICT");
  const previous = command.action === "Archive" ? current?.currentPublished : current?.draft;
  if (!body && !previous) return invalid();
  const content: OptionPriceAuthoringContent =
    body ??
    (previous
      ? {
          skuReference: previous.skuReference,
          scopeKind: previous.scopeKind,
          scopeReference: previous.scopeReference,
          channelCode: previous.channelCode,
          orderType: previous.orderType,
          unitAmountMinor: previous.unitAmount.amountMinor.toString(),
          includedQuantity: previous.includedQuantity,
          effectivePeriod: previous.effectivePeriod,
        }
      : invalid());
  if (
    command.action === "Publish" &&
    previous &&
    canonicalizeRfc8785(previous.currencyMetadata) !== canonicalizeRfc8785(currency)
  )
    throw new OptionPriceAuthoringError("OPTION_PRICE_LIFECYCLE_CONFLICT");
  const versionCurrency =
    command.action === "Archive" && previous ? previous.currencyMetadata : currency;
  const base = {
    ruleReference: command.ruleReference,
    versionReference: parsePricingReference(input.versionReference),
    snapshotDigest: parsePricingDigest("sha256:" + "0".repeat(64)),
    brandReference: parsePricingReference(input.brandReference),
    bindingReference: current?.bindingReference ?? command.bindingReference ?? invalid(),
    optionReference: current?.optionReference ?? command.optionReference ?? invalid(),
    skuReference: content.skuReference,
    scopeKind: content.scopeKind,
    scopeReference: content.scopeReference,
    channelCode: content.channelCode,
    orderType: content.orderType,
    lifecycle:
      command.action === "Publish"
        ? "Published"
        : command.action === "Archive"
          ? "Archived"
          : "Draft",
    currencyMetadata: versionCurrency,
    unitAmount: createMoney({
      amountMinor: BigInt(content.unitAmountMinor),
      currencyCode: versionCurrency.currencyCode,
    }),
    includedQuantity: content.includedQuantity,
    quantityBasis: "PerItemChoice",
    effectivePeriod: content.effectivePeriod,
    createdAt: occurredAt,
  };
  const normalized = createOptionPriceRuleSnapshot(base as OptionPriceRuleSnapshot),
    { snapshotDigest, ...wire } = optionPriceWireSnapshot(normalized);
  void snapshotDigest;
  return createOptionPriceRuleSnapshot({
    ...normalized,
    snapshotDigest: parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(wire))),
  });
}
