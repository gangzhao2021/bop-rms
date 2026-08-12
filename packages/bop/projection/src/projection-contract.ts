export const projectionReferencePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const projectionDigestPattern = /^sha256:[0-9a-f]{64}$/u;
export const projectionInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export class OperationalProjectionError extends Error {
  constructor(
    readonly code: "INPUT_INVALID" | "SCOPE_MISMATCH" | "DUPLICATE_SOURCE" | "SOURCE_CONFLICT",
  ) {
    super("operational projection is unavailable");
    this.name = "OperationalProjectionError";
  }
}
export function projectionFail(code: OperationalProjectionError["code"]): never {
  throw new OperationalProjectionError(code);
}
export function projectionReference(value: unknown): string {
  if (typeof value !== "string" || !projectionReferencePattern.test(value))
    return projectionFail("INPUT_INVALID");
  return value;
}
export function projectionOptionalReference(value: unknown): string | null {
  return value === null ? null : projectionReference(value);
}
export function projectionDigest(value: unknown): string {
  if (typeof value !== "string" || !projectionDigestPattern.test(value))
    return projectionFail("INPUT_INVALID");
  return value;
}
export function projectionInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !projectionInstantPattern.test(value) ||
    new Date(value).toISOString() !== value
  )
    return projectionFail("INPUT_INVALID");
  return value;
}
export function projectionExact(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return projectionFail("INPUT_INVALID");
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return projectionFail("INPUT_INVALID");
    output[field] = descriptor.value;
  }
  return output;
}
export function projectionVersion(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n) return projectionFail("INPUT_INVALID");
  return value;
}
export function assertProjectionScope(
  value: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  expected: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
): void {
  if (
    value.tenantReference !== expected.tenantReference ||
    value.brandReference !== expected.brandReference ||
    value.storeReference !== expected.storeReference
  )
    projectionFail("SCOPE_MISMATCH");
}
export function validateBusinessDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    return projectionFail("INPUT_INVALID");
  return value;
}
