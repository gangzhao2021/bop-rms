/**
 * WP-2423 C3: the strict value parsers every merchant client used to copy. A client supplies its
 * own `fail` (its error class and code) and gets the same checks back, so a malformed reply is
 * refused the same way everywhere instead of in sixty slightly different ways.
 */
export const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const minorPattern = /^(0|[1-9][0-9]*)$/u;

export interface ContractParsers {
  /** A canonical UTC instant (`YYYY-MM-DDTHH:mm:ss.sssZ`) that round-trips through Date. */
  instant(value: unknown): string;
  /** A UUIDv7 reference. */
  reference(value: unknown): string;
  /** Non-empty text up to `max` characters. */
  text(value: unknown, max: number): string;
  /** A non-negative amount in minor units as a decimal string with no leading zeros. */
  minor(value: unknown): string;
  /** A non-negative safe integer. */
  count(value: unknown): number;
  /** A safe integer not below `min`. */
  integer(value: unknown, min?: number): number;
  bool(value: unknown): boolean;
  oneOf<T extends string>(value: unknown, values: readonly T[]): T;
  /** An object whose own keys are exactly `keys`, in any order; nothing missing, nothing extra. */
  exact(value: unknown, keys: readonly string[]): Record<string, unknown>;
  optional<T>(value: unknown, parse: (value: unknown) => T): T | null;
}

export function createContractParsers(fail: () => never): ContractParsers {
  const instant = (value: unknown): string =>
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
      ? value
      : fail();
  const reference = (value: unknown): string =>
    typeof value === "string" && uuidV7Pattern.test(value) ? value : fail();
  const text = (value: unknown, max: number): string =>
    typeof value === "string" && value.length > 0 && value.length <= max ? value : fail();
  const minor = (value: unknown): string =>
    typeof value === "string" && minorPattern.test(value) ? value : fail();
  const integer = (value: unknown, min = 0): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : fail();
  const count = (value: unknown): number => integer(value, 0);
  const bool = (value: unknown): boolean => (typeof value === "boolean" ? value : fail());
  const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
    typeof value === "string" && (values as readonly string[]).includes(value)
      ? (value as T)
      : fail();
  const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))
    )
      return fail();
    return value as Record<string, unknown>;
  };
  const optional = <T>(value: unknown, parse: (value: unknown) => T): T | null =>
    value === null ? null : parse(value);
  return Object.freeze({
    instant,
    reference,
    text,
    minor,
    count,
    integer,
    bool,
    oneOf,
    exact,
    optional,
  });
}
