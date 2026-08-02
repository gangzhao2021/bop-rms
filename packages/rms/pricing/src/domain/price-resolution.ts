import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";

import {
  createCurrencyMetadataSnapshot,
  createMoney,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  type CurrencyMetadataSnapshot,
  type Money,
  type PricingCode,
  type PricingDigest,
  type PricingReference,
} from "./money-tax-contract.js";

export type PriceBookLifecycle = "Draft" | "Published" | "Archived";
export type PriceScopeKind = "Brand" | "Region" | "StoreGroup" | "Store";
export type PriceOrderType = "DineIn" | "Pickup";

export interface PriceEntry {
  readonly entryReference: PricingReference;
  readonly sellableReference: PricingReference;
  readonly scopeKind: PriceScopeKind;
  readonly scopeReference: PricingReference | null;
  readonly channelCode: PricingCode | null;
  readonly orderType: PriceOrderType | null;
  readonly amount: Money;
  readonly effectivePeriod: EffectivePeriod;
  readonly reasonCode: PricingCode;
}

export interface PriceBookSnapshot {
  readonly priceBookReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly stableCode: PricingCode;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: PricingDigest;
  readonly lifecycle: PriceBookLifecycle;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly entries: readonly PriceEntry[];
  readonly createdAt: string;
}

export interface PriceResolutionContext {
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly storeGroupReference: PricingReference | null;
  readonly regionReference: PricingReference | null;
  readonly sellableReference: PricingReference;
  readonly channelCode: PricingCode;
  readonly orderType: PriceOrderType;
  readonly currencyCode: string;
  readonly evaluatedAt: string;
}

export interface ResolvedPrice {
  readonly priceBookReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly snapshotDigest: PricingDigest;
  readonly entryReference: PricingReference;
  readonly sellableReference: PricingReference;
  readonly amount: Money;
  readonly scopeKind: PriceScopeKind;
  readonly scopeReference: PricingReference | null;
  readonly channelCode: PricingCode | null;
  readonly orderType: PriceOrderType | null;
  readonly priority: number;
  readonly effectivePeriod: EffectivePeriod;
  readonly reasonCode: PricingCode;
}

export const priceResolutionErrorCodes = [
  "PRICE_INPUT_INVALID",
  "PRICE_SCOPE_MISMATCH",
  "PRICE_BOOK_NOT_PUBLISHED",
  "PRICE_ENTRY_CONFLICT",
  "PRICE_COVERAGE_MISSING",
] as const;
export type PriceResolutionErrorCode = (typeof priceResolutionErrorCodes)[number];

export class PriceResolutionError extends Error {
  readonly code: PriceResolutionErrorCode;

  constructor(code: PriceResolutionErrorCode) {
    super("price resolution is unavailable");
    this.name = "PriceResolutionError";
    this.code = code;
  }
}

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function fail(code: PriceResolutionErrorCode): never {
  throw new PriceResolutionError(code);
}

function exact(value: object, fields: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("PRICE_INPUT_INVALID");
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field)) ||
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    fail("PRICE_INPUT_INVALID");
}

function reference(value: unknown): PricingReference {
  try {
    return parsePricingReference(value);
  } catch {
    return fail("PRICE_INPUT_INVALID");
  }
}

function code(value: unknown): PricingCode {
  try {
    return parsePricingCode(value);
  } catch {
    return fail("PRICE_INPUT_INVALID");
  }
}

function digest(value: unknown): PricingDigest {
  try {
    return parsePricingDigest(value);
  } catch {
    return fail("PRICE_INPUT_INVALID");
  }
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    fail("PRICE_INPUT_INVALID");
  return value;
}

function period(input: EffectivePeriod): EffectivePeriod {
  try {
    return createEffectivePeriod(input);
  } catch {
    return fail("PRICE_INPUT_INVALID");
  }
}

function createEntry(input: PriceEntry, currencyCode: string): PriceEntry {
  exact(input, [
    "entryReference",
    "sellableReference",
    "scopeKind",
    "scopeReference",
    "channelCode",
    "orderType",
    "amount",
    "effectivePeriod",
    "reasonCode",
  ]);
  if (!(["Brand", "Region", "StoreGroup", "Store"] as const).includes(input.scopeKind))
    fail("PRICE_INPUT_INVALID");
  if (
    (input.scopeKind === "Brand" && input.scopeReference !== null) ||
    (input.scopeKind !== "Brand" && input.scopeReference === null)
  )
    fail("PRICE_INPUT_INVALID");
  if (input.orderType !== null && input.orderType !== "DineIn" && input.orderType !== "Pickup")
    fail("PRICE_INPUT_INVALID");
  const amount = createMoney(input.amount);
  if (amount.amountMinor < 0n || amount.currencyCode !== currencyCode) fail("PRICE_SCOPE_MISMATCH");
  return Object.freeze({
    entryReference: reference(input.entryReference),
    sellableReference: reference(input.sellableReference),
    scopeKind: input.scopeKind,
    scopeReference: input.scopeReference === null ? null : reference(input.scopeReference),
    channelCode: input.channelCode === null ? null : code(input.channelCode),
    orderType: input.orderType,
    amount,
    effectivePeriod: period(input.effectivePeriod),
    reasonCode: code(input.reasonCode),
  });
}

function overlaps(left: EffectivePeriod, right: EffectivePeriod): boolean {
  const leftStart = Date.parse(left.effectiveFrom.instant);
  const rightStart = Date.parse(right.effectiveFrom.instant);
  const leftEnd =
    left.effectiveUntil === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(left.effectiveUntil.instant);
  const rightEnd =
    right.effectiveUntil === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(right.effectiveUntil.instant);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function sameResolutionIdentity(left: PriceEntry, right: PriceEntry): boolean {
  return (
    left.sellableReference === right.sellableReference &&
    left.scopeKind === right.scopeKind &&
    left.scopeReference === right.scopeReference &&
    left.channelCode === right.channelCode &&
    left.orderType === right.orderType
  );
}

export function createPriceBookSnapshot(input: PriceBookSnapshot): PriceBookSnapshot {
  exact(input, [
    "priceBookReference",
    "versionReference",
    "brandReference",
    "stableCode",
    "aggregateVersion",
    "versionNumber",
    "snapshotDigest",
    "lifecycle",
    "currencyMetadata",
    "entries",
    "createdAt",
  ]);
  if (
    !Number.isSafeInteger(input.aggregateVersion) ||
    input.aggregateVersion < 1 ||
    !Number.isSafeInteger(input.versionNumber) ||
    input.versionNumber < 1 ||
    !(["Draft", "Published", "Archived"] as const).includes(input.lifecycle) ||
    !Array.isArray(input.entries)
  )
    fail("PRICE_INPUT_INVALID");
  const currencyMetadata = createCurrencyMetadataSnapshot(input.currencyMetadata);
  const entries = Object.freeze(
    input.entries.map((entry) => createEntry(entry, currencyMetadata.currencyCode)),
  );
  const references = new Set(entries.map((entry) => entry.entryReference));
  if (references.size !== entries.length) fail("PRICE_ENTRY_CONFLICT");
  for (let left = 0; left < entries.length; left += 1)
    for (let right = left + 1; right < entries.length; right += 1)
      if (
        sameResolutionIdentity(entries[left] as PriceEntry, entries[right] as PriceEntry) &&
        overlaps(
          (entries[left] as PriceEntry).effectivePeriod,
          (entries[right] as PriceEntry).effectivePeriod,
        )
      )
        fail("PRICE_ENTRY_CONFLICT");
  if (input.lifecycle === "Published" && entries.length === 0) fail("PRICE_COVERAGE_MISSING");
  return Object.freeze({
    priceBookReference: reference(input.priceBookReference),
    versionReference: reference(input.versionReference),
    brandReference: reference(input.brandReference),
    stableCode: code(input.stableCode),
    aggregateVersion: input.aggregateVersion,
    versionNumber: input.versionNumber,
    snapshotDigest: digest(input.snapshotDigest),
    lifecycle: input.lifecycle,
    currencyMetadata,
    entries,
    createdAt: timestamp(input.createdAt),
  });
}

function isEffective(entry: PriceEntry, at: number): boolean {
  return (
    at >= Date.parse(entry.effectivePeriod.effectiveFrom.instant) &&
    (entry.effectivePeriod.effectiveUntil === null ||
      at < Date.parse(entry.effectivePeriod.effectiveUntil.instant))
  );
}

function scopeMatches(entry: PriceEntry, context: PriceResolutionContext): boolean {
  if (entry.scopeKind === "Brand") return entry.scopeReference === null;
  if (entry.scopeKind === "Region") return entry.scopeReference === context.regionReference;
  if (entry.scopeKind === "StoreGroup") return entry.scopeReference === context.storeGroupReference;
  return entry.scopeReference === context.storeReference;
}

function priority(entry: PriceEntry): number {
  const qualified = entry.channelCode !== null || entry.orderType !== null;
  const base = { Store: 1, StoreGroup: 3, Region: 5, Brand: 7 }[entry.scopeKind];
  return qualified ? base : base + 1;
}

export function resolvePrice(
  snapshotInput: PriceBookSnapshot,
  context: PriceResolutionContext,
): ResolvedPrice {
  const snapshot = createPriceBookSnapshot(snapshotInput);
  exact(context, [
    "brandReference",
    "storeReference",
    "storeGroupReference",
    "regionReference",
    "sellableReference",
    "channelCode",
    "orderType",
    "currencyCode",
    "evaluatedAt",
  ]);
  const evaluatedAt = Date.parse(timestamp(context.evaluatedAt));
  if (
    snapshot.brandReference !== reference(context.brandReference) ||
    snapshot.currencyMetadata.currencyCode !== context.currencyCode
  )
    fail("PRICE_SCOPE_MISMATCH");
  if (snapshot.lifecycle !== "Published") fail("PRICE_BOOK_NOT_PUBLISHED");
  const matches = snapshot.entries
    .filter(
      (entry) =>
        entry.sellableReference === context.sellableReference &&
        scopeMatches(entry, context) &&
        (entry.channelCode === null || entry.channelCode === context.channelCode) &&
        (entry.orderType === null || entry.orderType === context.orderType) &&
        isEffective(entry, evaluatedAt),
    )
    .map((entry) => ({ entry, priority: priority(entry) }))
    .sort((left, right) => left.priority - right.priority);
  if (matches.length === 0) fail("PRICE_COVERAGE_MISSING");
  const selected = matches[0];
  if (selected === undefined) fail("PRICE_COVERAGE_MISSING");
  if (matches.filter((match) => match.priority === selected.priority).length !== 1)
    fail("PRICE_ENTRY_CONFLICT");
  return Object.freeze({
    priceBookReference: snapshot.priceBookReference,
    versionReference: snapshot.versionReference,
    snapshotDigest: snapshot.snapshotDigest,
    entryReference: selected.entry.entryReference,
    sellableReference: selected.entry.sellableReference,
    amount: selected.entry.amount,
    scopeKind: selected.entry.scopeKind,
    scopeReference: selected.entry.scopeReference,
    channelCode: selected.entry.channelCode,
    orderType: selected.entry.orderType,
    priority: selected.priority,
    effectivePeriod: selected.entry.effectivePeriod,
    reasonCode: selected.entry.reasonCode,
  });
}

export function validatePriceCoverage(
  snapshot: PriceBookSnapshot,
  contexts: readonly PriceResolutionContext[],
): void {
  if (!Array.isArray(contexts) || contexts.length === 0) fail("PRICE_COVERAGE_MISSING");
  for (const context of contexts) resolvePrice(snapshot, context);
}
