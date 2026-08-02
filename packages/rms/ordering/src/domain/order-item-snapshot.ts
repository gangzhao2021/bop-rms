import {
  parseCartAggregate,
  parseCustomerNote,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";
import {
  parseCheckoutValidationEvidence,
  type CheckoutValidationEvidence,
} from "./checkout-validation.js";

export interface OrderSnapshotMoney {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
}

export interface OrderCatalogOptionSnapshot {
  readonly optionReference: OrderingReference;
  readonly quantity: number;
  readonly bindingReference: OrderingReference;
  readonly optionSetVersionReference: OrderingReference;
  readonly localizedNames: Readonly<Record<string, string>>;
}

export interface OrderCatalogLineSnapshot {
  readonly snapshotReference: OrderingReference;
  readonly snapshotDigest: OrderingHash;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly sellableType: "Sku";
  readonly productReference: OrderingReference;
  readonly productVersionReference: OrderingReference;
  readonly skuReference: OrderingReference;
  readonly menuVersionReference: OrderingReference;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly unitOfSale: string;
  readonly unitQuantity: string;
  readonly taxClassificationReference: OrderingReference;
  readonly options: readonly OrderCatalogOptionSnapshot[];
  readonly capturedAt: OrderingInstant;
}

export interface OrderPriceResolutionSnapshot {
  readonly priceBookReference: OrderingReference;
  readonly priceBookVersionReference: OrderingReference;
  readonly priceBookDigest: OrderingHash;
  readonly priceEntryReference: OrderingReference;
  readonly unitPrice: OrderSnapshotMoney;
  readonly scopeKind: "Brand" | "Region" | "StoreGroup" | "Store";
  readonly scopeReference: OrderingReference | null;
  readonly channelCode: string | null;
  readonly orderType: "DineIn" | "Pickup" | null;
  readonly priority: number;
  readonly effectiveFrom: OrderingInstant;
  readonly effectiveUntil: OrderingInstant | null;
  readonly reasonCode: string;
}

export interface OrderTaxComponentSnapshot {
  readonly ruleVersionReference: OrderingReference;
  readonly ruleVersionDigest: OrderingHash;
  readonly jurisdictionCode: string;
  readonly taxComponentCode: string;
  readonly taxClassificationReference: OrderingReference;
  readonly treatment: "Taxable" | "Exempt" | "ZeroRated";
  readonly rate: string;
  readonly priceInclusion: "Exclusive" | "Inclusive";
  readonly roundingMode: "HalfUp" | "HalfEven" | "TowardZero" | "AwayFromZero";
  readonly calculationOrder: number;
  readonly compoundOnPriorTax: boolean;
  readonly taxAmount: OrderSnapshotMoney;
}

export interface OrderPricingLineSnapshot {
  readonly quoteReference: OrderingReference;
  readonly quoteVersion: 1;
  readonly quoteInputDigest: OrderingHash;
  readonly lineReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly quantity: number;
  readonly currencyMinorUnitExponent: number;
  readonly currencyMetadataVersion: number;
  readonly currencyMetadataVersionReference: OrderingReference;
  readonly currencyMetadataDigest: OrderingHash;
  readonly unitPrice: OrderSnapshotMoney;
  readonly subtotal: OrderSnapshotMoney;
  readonly discount: OrderSnapshotMoney;
  readonly tax: OrderSnapshotMoney;
  readonly fee: OrderSnapshotMoney;
  readonly total: OrderSnapshotMoney;
  readonly priceResolution: OrderPriceResolutionSnapshot;
  readonly taxConfigurationReference: OrderingReference;
  readonly taxConfigurationVersionReference: OrderingReference;
  readonly taxConfigurationDigest: OrderingHash;
  readonly taxEffectiveFrom: OrderingInstant;
  readonly taxEffectiveUntil: OrderingInstant | null;
  readonly taxComponents: readonly OrderTaxComponentSnapshot[];
  readonly quotedAt: OrderingInstant;
}

export interface OrderItemTransactionSnapshot {
  readonly orderItemReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly cartItemReference: OrderingReference;
  readonly quantity: number;
  readonly customerNote: string | null;
  readonly addedByActorReference: OrderingReference;
  readonly addedByParticipantReference: OrderingReference | null;
  readonly addedAt: OrderingInstant;
  readonly catalog: OrderCatalogLineSnapshot;
  readonly pricing: OrderPricingLineSnapshot;
  readonly snapshotCapturedAt: OrderingInstant;
}

export interface CreateOrderItemSnapshotsInput {
  readonly orderReference: unknown;
  readonly orderBatchReference: unknown;
  readonly snapshotCapturedAt: unknown;
  readonly checkoutValidationEvidence: unknown;
  readonly cart: unknown;
  readonly lines: unknown;
}

export const orderItemSnapshotErrorCodes = [
  "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
  "ORDER_ITEM_SNAPSHOT_VALIDATION_EXPIRED",
] as const;
export type OrderItemSnapshotErrorCode = (typeof orderItemSnapshotErrorCodes)[number];

export class OrderItemSnapshotError extends Error {
  readonly code: OrderItemSnapshotErrorCode;

  constructor(code: OrderItemSnapshotErrorCode) {
    super("order item snapshot input is invalid");
    this.name = "OrderItemSnapshotError";
    this.code = code;
  }
}

const currencyPattern = /^[A-Z]{3}$/u;
const codePattern = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const unitQuantityPattern = /^(?:0*[1-9]\d*)(?:\.\d{1,6})?$|^0\.(?:0{0,5}[1-9]\d{0,5})$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const taxRatePattern = /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{0,11}[1-9])?$/u;
const minimumMinor = -(2n ** 63n);
const maximumMinor = 2n ** 63n - 1n;

function invalid(): never {
  throw new OrderItemSnapshotError("ORDER_ITEM_SNAPSHOT_INPUT_INVALID");
}

function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderItemSnapshotError) throw error;
    return invalid();
  }
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}

function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function optionalInstant(value: unknown): OrderingInstant | null {
  if (value === null) return null;
  try {
    return parseOrderingInstant(value);
  } catch {
    return invalid();
  }
}

function code(value: unknown): string {
  if (typeof value !== "string" || !codePattern.test(value)) return invalid();
  return value;
}

function names(value: unknown): Readonly<Record<string, string>> {
  const raw = closedRecord(value);
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > 20) return invalid();
  const normalized: Record<string, string> = {};
  for (const [locale, name] of entries) {
    if (!localePattern.test(locale) || typeof name !== "string") return invalid();
    const candidate = name.normalize("NFC").trim();
    if (candidate.length < 1 || candidate.length > 200) return invalid();
    normalized[locale] = candidate;
  }
  return Object.freeze(normalized);
}

function closedRecord(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return invalid();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderItemSnapshotError) throw error;
    return invalid();
  }
}

function money(value: unknown, expectedCurrency?: string): OrderSnapshotMoney {
  const raw = closed(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "bigint" ||
    raw.amountMinor < minimumMinor ||
    raw.amountMinor > maximumMinor ||
    typeof raw.currencyCode !== "string" ||
    !currencyPattern.test(raw.currencyCode) ||
    (expectedCurrency !== undefined && raw.currencyCode !== expectedCurrency)
  )
    return invalid();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: raw.currencyCode });
}

function catalogOption(value: unknown): OrderCatalogOptionSnapshot {
  const raw = closed(value, [
    "optionReference",
    "quantity",
    "bindingReference",
    "optionSetVersionReference",
    "localizedNames",
  ]);
  try {
    return Object.freeze({
      optionReference: parseOrderingReference(raw.optionReference),
      quantity: positive(raw.quantity, 999),
      bindingReference: parseOrderingReference(raw.bindingReference),
      optionSetVersionReference: parseOrderingReference(raw.optionSetVersionReference),
      localizedNames: names(raw.localizedNames),
    });
  } catch {
    return invalid();
  }
}

function catalog(value: unknown): OrderCatalogLineSnapshot {
  const raw = closed(value, [
    "snapshotReference",
    "snapshotDigest",
    "brandReference",
    "storeReference",
    "sellableReference",
    "sellableType",
    "productReference",
    "productVersionReference",
    "skuReference",
    "menuVersionReference",
    "localizedNames",
    "unitOfSale",
    "unitQuantity",
    "taxClassificationReference",
    "options",
    "capturedAt",
  ]);
  if (
    raw.sellableType !== "Sku" ||
    typeof raw.unitQuantity !== "string" ||
    !unitQuantityPattern.test(raw.unitQuantity) ||
    !Array.isArray(raw.options) ||
    raw.options.length > 100
  )
    return invalid();
  try {
    const options = Object.freeze(raw.options.map(catalogOption));
    if (new Set(options.map((item) => item.optionReference)).size !== options.length)
      return invalid();
    return Object.freeze({
      snapshotReference: parseOrderingReference(raw.snapshotReference),
      snapshotDigest: parseOrderingHash(raw.snapshotDigest),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      sellableReference: parseOrderingReference(raw.sellableReference),
      sellableType: "Sku",
      productReference: parseOrderingReference(raw.productReference),
      productVersionReference: parseOrderingReference(raw.productVersionReference),
      skuReference: parseOrderingReference(raw.skuReference),
      menuVersionReference: parseOrderingReference(raw.menuVersionReference),
      localizedNames: names(raw.localizedNames),
      unitOfSale: code(raw.unitOfSale),
      unitQuantity: raw.unitQuantity,
      taxClassificationReference: parseOrderingReference(raw.taxClassificationReference),
      options,
      capturedAt: parseOrderingInstant(raw.capturedAt),
    });
  } catch (error) {
    if (error instanceof OrderItemSnapshotError) throw error;
    return invalid();
  }
}

function priceResolution(value: unknown, currencyCode: string): OrderPriceResolutionSnapshot {
  const raw = closed(value, [
    "priceBookReference",
    "priceBookVersionReference",
    "priceBookDigest",
    "priceEntryReference",
    "unitPrice",
    "scopeKind",
    "scopeReference",
    "channelCode",
    "orderType",
    "priority",
    "effectiveFrom",
    "effectiveUntil",
    "reasonCode",
  ]);
  if (
    !["Brand", "Region", "StoreGroup", "Store"].includes(String(raw.scopeKind)) ||
    (raw.scopeKind === "Brand") !== (raw.scopeReference === null) ||
    (raw.channelCode !== null &&
      (typeof raw.channelCode !== "string" || !codePattern.test(raw.channelCode))) ||
    ![null, "DineIn", "Pickup"].includes(raw.orderType as null | string)
  )
    return invalid();
  try {
    const effectiveFrom = parseOrderingInstant(raw.effectiveFrom);
    const effectiveUntil = optionalInstant(raw.effectiveUntil);
    if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))
      return invalid();
    return Object.freeze({
      priceBookReference: parseOrderingReference(raw.priceBookReference),
      priceBookVersionReference: parseOrderingReference(raw.priceBookVersionReference),
      priceBookDigest: parseOrderingHash(raw.priceBookDigest),
      priceEntryReference: parseOrderingReference(raw.priceEntryReference),
      unitPrice: money(raw.unitPrice, currencyCode),
      scopeKind: raw.scopeKind as OrderPriceResolutionSnapshot["scopeKind"],
      scopeReference:
        raw.scopeReference === null ? null : parseOrderingReference(raw.scopeReference),
      channelCode: raw.channelCode as string | null,
      orderType: raw.orderType as OrderPriceResolutionSnapshot["orderType"],
      priority: nonnegative(raw.priority),
      effectiveFrom,
      effectiveUntil,
      reasonCode: code(raw.reasonCode),
    });
  } catch {
    return invalid();
  }
}

function taxComponent(value: unknown, currencyCode: string): OrderTaxComponentSnapshot {
  const raw = closed(value, [
    "ruleVersionReference",
    "ruleVersionDigest",
    "jurisdictionCode",
    "taxComponentCode",
    "taxClassificationReference",
    "treatment",
    "rate",
    "priceInclusion",
    "roundingMode",
    "calculationOrder",
    "compoundOnPriorTax",
    "taxAmount",
  ]);
  if (
    !["Taxable", "Exempt", "ZeroRated"].includes(String(raw.treatment)) ||
    typeof raw.rate !== "string" ||
    !taxRatePattern.test(raw.rate) ||
    !["Exclusive", "Inclusive"].includes(String(raw.priceInclusion)) ||
    !["HalfUp", "HalfEven", "TowardZero", "AwayFromZero"].includes(String(raw.roundingMode)) ||
    typeof raw.compoundOnPriorTax !== "boolean"
  )
    return invalid();
  if (raw.treatment !== "Taxable" && raw.rate !== "0") return invalid();
  try {
    const taxAmount = money(raw.taxAmount, currencyCode);
    if (taxAmount.amountMinor < 0n || (raw.treatment !== "Taxable" && taxAmount.amountMinor !== 0n))
      return invalid();
    return Object.freeze({
      ruleVersionReference: parseOrderingReference(raw.ruleVersionReference),
      ruleVersionDigest: parseOrderingHash(raw.ruleVersionDigest),
      jurisdictionCode: code(raw.jurisdictionCode),
      taxComponentCode: code(raw.taxComponentCode),
      taxClassificationReference: parseOrderingReference(raw.taxClassificationReference),
      treatment: raw.treatment as OrderTaxComponentSnapshot["treatment"],
      rate: raw.rate,
      priceInclusion: raw.priceInclusion as OrderTaxComponentSnapshot["priceInclusion"],
      roundingMode: raw.roundingMode as OrderTaxComponentSnapshot["roundingMode"],
      calculationOrder: nonnegative(raw.calculationOrder),
      compoundOnPriorTax: raw.compoundOnPriorTax,
      taxAmount,
    });
  } catch (error) {
    if (error instanceof OrderItemSnapshotError) throw error;
    return invalid();
  }
}

function pricing(value: unknown): OrderPricingLineSnapshot {
  const raw = closed(value, [
    "quoteReference",
    "quoteVersion",
    "quoteInputDigest",
    "lineReference",
    "sellableReference",
    "quantity",
    "currencyMinorUnitExponent",
    "currencyMetadataVersion",
    "currencyMetadataVersionReference",
    "currencyMetadataDigest",
    "unitPrice",
    "subtotal",
    "discount",
    "tax",
    "fee",
    "total",
    "priceResolution",
    "taxConfigurationReference",
    "taxConfigurationVersionReference",
    "taxConfigurationDigest",
    "taxEffectiveFrom",
    "taxEffectiveUntil",
    "taxComponents",
    "quotedAt",
  ]);
  if (raw.quoteVersion !== 1 || !Array.isArray(raw.taxComponents) || raw.taxComponents.length > 20)
    return invalid();
  try {
    const unitPrice = money(raw.unitPrice);
    const currencyCode = unitPrice.currencyCode;
    const subtotal = money(raw.subtotal, currencyCode);
    const discount = money(raw.discount, currencyCode);
    const tax = money(raw.tax, currencyCode);
    const fee = money(raw.fee, currencyCode);
    const total = money(raw.total, currencyCode);
    const parsedPriceResolution = priceResolution(raw.priceResolution, currencyCode);
    const quotedAt = parseOrderingInstant(raw.quotedAt);
    const taxEffectiveFrom = parseOrderingInstant(raw.taxEffectiveFrom);
    const taxEffectiveUntil = optionalInstant(raw.taxEffectiveUntil);
    const taxComponents = Object.freeze(
      raw.taxComponents.map((item) => taxComponent(item, currencyCode)),
    );
    if (
      [unitPrice, subtotal, discount, tax, fee, total].some((item) => item.amountMinor < 0n) ||
      subtotal.amountMinor - discount.amountMinor + tax.amountMinor + fee.amountMinor !==
        total.amountMinor ||
      parsedPriceResolution.unitPrice.amountMinor !== unitPrice.amountMinor ||
      taxComponents.reduce((sum, item) => sum + item.taxAmount.amountMinor, 0n) !==
        tax.amountMinor ||
      new Set(taxComponents.map((item) => item.calculationOrder)).size !== taxComponents.length ||
      new Set(taxComponents.map((item) => item.ruleVersionReference)).size !==
        taxComponents.length ||
      !Number.isSafeInteger(raw.currencyMinorUnitExponent) ||
      (raw.currencyMinorUnitExponent as number) < 0 ||
      (raw.currencyMinorUnitExponent as number) > 6 ||
      Date.parse(quotedAt) < Date.parse(parsedPriceResolution.effectiveFrom) ||
      (parsedPriceResolution.effectiveUntil !== null &&
        Date.parse(quotedAt) >= Date.parse(parsedPriceResolution.effectiveUntil)) ||
      (taxEffectiveUntil !== null &&
        Date.parse(taxEffectiveUntil) <= Date.parse(taxEffectiveFrom)) ||
      Date.parse(quotedAt) < Date.parse(taxEffectiveFrom) ||
      (taxEffectiveUntil !== null && Date.parse(quotedAt) >= Date.parse(taxEffectiveUntil))
    )
      return invalid();
    return Object.freeze({
      quoteReference: parseOrderingReference(raw.quoteReference),
      quoteVersion: 1,
      quoteInputDigest: parseOrderingHash(raw.quoteInputDigest),
      lineReference: parseOrderingReference(raw.lineReference),
      sellableReference: parseOrderingReference(raw.sellableReference),
      quantity: positive(raw.quantity, 999),
      currencyMinorUnitExponent: raw.currencyMinorUnitExponent as number,
      currencyMetadataVersion: positive(raw.currencyMetadataVersion),
      currencyMetadataVersionReference: parseOrderingReference(
        raw.currencyMetadataVersionReference,
      ),
      currencyMetadataDigest: parseOrderingHash(raw.currencyMetadataDigest),
      unitPrice,
      subtotal,
      discount,
      tax,
      fee,
      total,
      priceResolution: parsedPriceResolution,
      taxConfigurationReference: parseOrderingReference(raw.taxConfigurationReference),
      taxConfigurationVersionReference: parseOrderingReference(
        raw.taxConfigurationVersionReference,
      ),
      taxConfigurationDigest: parseOrderingHash(raw.taxConfigurationDigest),
      taxEffectiveFrom,
      taxEffectiveUntil,
      taxComponents,
      quotedAt,
    });
  } catch (error) {
    if (error instanceof OrderItemSnapshotError) throw error;
    return invalid();
  }
}

function parseLine(value: unknown): OrderItemTransactionSnapshot {
  const raw = closed(value, [
    "orderItemReference",
    "orderBatchReference",
    "cartItemReference",
    "quantity",
    "customerNote",
    "addedByActorReference",
    "addedByParticipantReference",
    "addedAt",
    "catalog",
    "pricing",
    "snapshotCapturedAt",
  ]);
  try {
    return Object.freeze({
      orderItemReference: parseOrderingReference(raw.orderItemReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      cartItemReference: parseOrderingReference(raw.cartItemReference),
      quantity: positive(raw.quantity, 999),
      customerNote: parseCustomerNote(raw.customerNote),
      addedByActorReference: parseOrderingReference(raw.addedByActorReference),
      addedByParticipantReference:
        raw.addedByParticipantReference === null
          ? null
          : parseOrderingReference(raw.addedByParticipantReference),
      addedAt: parseOrderingInstant(raw.addedAt),
      catalog: catalog(raw.catalog),
      pricing: pricing(raw.pricing),
      snapshotCapturedAt: parseOrderingInstant(raw.snapshotCapturedAt),
    });
  } catch (error) {
    if (error instanceof OrderItemSnapshotError) throw error;
    return invalid();
  }
}

export function parseOrderItemTransactionSnapshot(value: unknown): OrderItemTransactionSnapshot {
  const snapshot = parseLine(value);
  if (
    snapshot.catalog.sellableReference !== snapshot.pricing.sellableReference ||
    snapshot.cartItemReference !== snapshot.pricing.lineReference ||
    snapshot.quantity !== snapshot.pricing.quantity ||
    snapshot.catalog.capturedAt !== snapshot.snapshotCapturedAt ||
    Date.parse(snapshot.addedAt) > Date.parse(snapshot.snapshotCapturedAt) ||
    Date.parse(snapshot.pricing.quotedAt) > Date.parse(snapshot.snapshotCapturedAt) ||
    snapshot.pricing.taxComponents.some(
      (component) =>
        component.taxClassificationReference !== snapshot.catalog.taxClassificationReference,
    )
  )
    return invalid();
  return snapshot;
}

function checkout(value: unknown): CheckoutValidationEvidence {
  try {
    return parseCheckoutValidationEvidence(value);
  } catch {
    return invalid();
  }
}

function cart(value: unknown): CartAggregate {
  try {
    return parseCartAggregate(value);
  } catch {
    return invalid();
  }
}

export function createOrderItemSnapshots(
  input: CreateOrderItemSnapshotsInput,
): readonly OrderItemTransactionSnapshot[] {
  const raw = closed(input, [
    "orderReference",
    "orderBatchReference",
    "snapshotCapturedAt",
    "checkoutValidationEvidence",
    "cart",
    "lines",
  ]);
  if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 100) return invalid();
  try {
    const orderReference = parseOrderingReference(raw.orderReference);
    const orderBatchReference = parseOrderingReference(raw.orderBatchReference);
    const snapshotCapturedAt = parseOrderingInstant(raw.snapshotCapturedAt);
    const evidence = checkout(raw.checkoutValidationEvidence);
    const sourceCart = cart(raw.cart);
    if (Date.parse(snapshotCapturedAt) >= Date.parse(evidence.validUntil))
      throw new OrderItemSnapshotError("ORDER_ITEM_SNAPSHOT_VALIDATION_EXPIRED");
    if (
      Date.parse(snapshotCapturedAt) < Date.parse(evidence.validatedAt) ||
      sourceCart.cartReference !== evidence.cartReference ||
      sourceCart.brandReference !== evidence.brandReference ||
      sourceCart.storeReference !== evidence.storeReference ||
      sourceCart.aggregateVersion !== evidence.cartVersion ||
      sourceCart.orderType !== evidence.orderType ||
      sourceCart.sourceChannel !== evidence.sourceChannel ||
      sourceCart.lifecycle?.status !== "Active" ||
      sourceCart.items.length !== evidence.catalogLines.length ||
      orderReference === orderBatchReference
    )
      return invalid();
    const inputs = raw.lines.map((line) =>
      closed(line, ["orderItemReference", "cartItemReference", "catalog", "pricing"]),
    );
    const snapshots = Object.freeze(
      inputs.map((line) => {
        const orderItemReference = parseOrderingReference(line.orderItemReference);
        const cartItemReference = parseOrderingReference(line.cartItemReference);
        const cartItem = sourceCart.items.find(
          (candidate) => candidate.cartItemReference === cartItemReference,
        );
        const lineEvidence = evidence.catalogLines.find(
          (candidate) => candidate.cartItemReference === cartItemReference,
        );
        if (cartItem === undefined || lineEvidence === undefined) return invalid();
        const catalogSnapshot = catalog(line.catalog);
        const pricingSnapshot = pricing(line.pricing);
        const rules = cartItem.catalogSelectionEvidence?.ruleEvidence ?? [];
        if (
          cartItem.catalogSelectionEvidence === null ||
          catalogSnapshot.brandReference !== evidence.brandReference ||
          catalogSnapshot.storeReference !== evidence.storeReference ||
          catalogSnapshot.sellableReference !== cartItem.sellableReference ||
          catalogSnapshot.sellableReference !== lineEvidence.sellableReference ||
          catalogSnapshot.productVersionReference !== lineEvidence.productVersionReference ||
          catalogSnapshot.menuVersionReference !== lineEvidence.menuVersionReference ||
          catalogSnapshot.capturedAt !== snapshotCapturedAt ||
          catalogSnapshot.options.length !== cartItem.optionSelections.length ||
          catalogSnapshot.options.some((option) => {
            const selected = cartItem.optionSelections.find(
              (candidate) => candidate.optionReference === option.optionReference,
            );
            return (
              selected?.quantity !== option.quantity ||
              !rules.some(
                (rule) =>
                  rule.bindingReference === option.bindingReference &&
                  rule.optionSetVersionReference === option.optionSetVersionReference,
              )
            );
          }) ||
          pricingSnapshot.quoteReference !== evidence.quoteReference ||
          pricingSnapshot.quoteInputDigest !== evidence.quoteInputDigest ||
          pricingSnapshot.lineReference !== cartItemReference ||
          pricingSnapshot.sellableReference !== cartItem.sellableReference ||
          pricingSnapshot.quantity !== cartItem.quantity ||
          (pricingSnapshot.priceResolution.channelCode !== null &&
            pricingSnapshot.priceResolution.channelCode !==
              cartItem.catalogSelectionEvidence.catalogChannelCode) ||
          (pricingSnapshot.priceResolution.orderType !== null &&
            pricingSnapshot.priceResolution.orderType !== evidence.orderType) ||
          Date.parse(pricingSnapshot.quotedAt) < Date.parse(sourceCart.updatedAt) ||
          Date.parse(pricingSnapshot.quotedAt) > Date.parse(evidence.validatedAt) ||
          pricingSnapshot.taxComponents.some(
            (component) =>
              component.taxClassificationReference !== catalogSnapshot.taxClassificationReference,
          )
        )
          return invalid();
        return parseOrderItemTransactionSnapshot({
          orderItemReference,
          orderBatchReference,
          cartItemReference,
          quantity: cartItem.quantity,
          customerNote: cartItem.customerNote,
          addedByActorReference: cartItem.addedByActorReference,
          addedByParticipantReference: cartItem.addedByParticipantReference,
          addedAt: cartItem.addedAt,
          catalog: catalogSnapshot,
          pricing: pricingSnapshot,
          snapshotCapturedAt,
        });
      }),
    );
    if (
      snapshots.length !== sourceCart.items.length ||
      new Set(snapshots.map((item) => item.orderItemReference)).size !== snapshots.length ||
      new Set(snapshots.map((item) => item.cartItemReference)).size !== snapshots.length ||
      snapshots.some(
        (item) =>
          item.orderItemReference === orderReference ||
          item.orderItemReference === orderBatchReference,
      )
    )
      return invalid();
    return snapshots;
  } catch (error) {
    if (error instanceof OrderItemSnapshotError) throw error;
    return invalid();
  }
}
