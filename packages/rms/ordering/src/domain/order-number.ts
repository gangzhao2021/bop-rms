import { resolveStoreBusinessDate, type StoreBusinessDateResolution } from "@rms/store";
import {
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";

export type OrderNumber = string & { readonly __orderNumber: unique symbol };

export interface CreateOrderNumberAllocationInput {
  readonly orderReference: unknown;
  readonly allocatedAt: unknown;
  readonly sequence: unknown;
  readonly businessDateResolution: unknown;
}

export interface OrderNumberAllocation {
  readonly orderReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly businessDate: StoreBusinessDateResolution["businessDate"];
  readonly sequence: bigint;
  readonly orderNumber: OrderNumber;
  readonly allocatedAt: OrderingInstant;
  readonly businessDateResolution: StoreBusinessDateResolution;
}

export const orderNumberErrorCodes = ["ORDER_NUMBER_INPUT_INVALID"] as const;
export type OrderNumberErrorCode = (typeof orderNumberErrorCodes)[number];

export class OrderNumberError extends Error {
  readonly code: OrderNumberErrorCode;

  constructor() {
    super("order number input is invalid");
    this.name = "OrderNumberError";
    this.code = "ORDER_NUMBER_INPUT_INVALID";
  }
}

export function parseOrderNumberReference(value: unknown): OrderingReference {
  try {
    return parseOrderingReference(value);
  } catch {
    throw new OrderNumberError();
  }
}

export function parseOrderNumberInstant(value: unknown): OrderingInstant {
  try {
    return parseOrderingInstant(value);
  } catch {
    throw new OrderNumberError();
  }
}

function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new OrderNumberError();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some((field) => {
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    throw new OrderNumberError();
  return value as Readonly<Record<string, unknown>>;
}

function sequence(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > 9_223_372_036_854_775_807n)
    throw new OrderNumberError();
  return value;
}

export function createOrderNumberAllocation(
  input: CreateOrderNumberAllocationInput,
): OrderNumberAllocation {
  const raw = closed(input, [
    "orderReference",
    "allocatedAt",
    "sequence",
    "businessDateResolution",
  ]);
  try {
    const allocatedAt = parseOrderNumberInstant(raw.allocatedAt);
    const resolutionFields = [
      "brandReference",
      "storeReference",
      "occurredAt",
      "businessDate",
      "businessDateBoundaryAt",
      "boundaryDisambiguation",
      "configurationReference",
      "configurationVersion",
      "contentDigest",
      "timeZone",
      "businessDayStartLocalTime",
    ] as const;
    const resolutionRaw = closed(raw.businessDateResolution, resolutionFields);
    const resolution = resolveStoreBusinessDate({
      occurredAt: resolutionRaw.occurredAt,
      configuration: {
        configurationReference: resolutionRaw.configurationReference,
        configurationVersion: resolutionRaw.configurationVersion,
        brandReference: resolutionRaw.brandReference,
        storeReference: resolutionRaw.storeReference,
        timeZone: resolutionRaw.timeZone,
        businessDayStartLocalTime: resolutionRaw.businessDayStartLocalTime,
        businessDayStartSource:
          resolutionRaw.businessDayStartLocalTime === "04:00:00"
            ? "PlatformDefault"
            : "StoreOverride",
        contentDigest: resolutionRaw.contentDigest,
        effectiveFrom: resolutionRaw.businessDateBoundaryAt,
        effectiveUntil: null,
      },
    });
    if (
      resolutionFields.some(
        (field) => String(resolution[field]) !== String(resolutionRaw[field]),
      ) ||
      String(allocatedAt) !== String(resolution.occurredAt)
    )
      throw new OrderNumberError();
    const value = sequence(raw.sequence);
    return Object.freeze({
      orderReference: parseOrderNumberReference(raw.orderReference),
      brandReference: parseOrderNumberReference(resolution.brandReference),
      storeReference: parseOrderNumberReference(resolution.storeReference),
      businessDate: resolution.businessDate,
      sequence: value,
      orderNumber: value.toString(10) as OrderNumber,
      allocatedAt,
      businessDateResolution: resolution,
    });
  } catch (error) {
    if (error instanceof OrderNumberError) throw error;
    throw new OrderNumberError();
  }
}
