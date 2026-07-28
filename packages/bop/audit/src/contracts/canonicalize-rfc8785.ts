const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export class InvalidCanonicalJsonError extends TypeError {
  readonly code = "INVALID_CANONICAL_JSON";

  constructor(field: string) {
    super("invalid canonical JSON value");
    void field;
    this.name = "InvalidCanonicalJsonError";
  }
}

function canonicalString(value: string, field: string): string {
  if (loneSurrogate.test(value)) throw new InvalidCanonicalJsonError(field);
  return JSON.stringify(value);
}

function serialize(value: unknown, stack: Set<object>, field: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return canonicalString(value, field);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidCanonicalJsonError(field);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new InvalidCanonicalJsonError(field);
  if (stack.has(value)) throw new InvalidCanonicalJsonError(field);

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
        ) ||
        ownKeys.length !== value.length + 1
      )
        throw new InvalidCanonicalJsonError(field);
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new InvalidCanonicalJsonError(`${field}[${index}]`);
        items.push(serialize(value[index], stack, `${field}[${index}]`));
      }
      return `[${items.join(",")}]`;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new InvalidCanonicalJsonError(field);
    const ownKeys = Reflect.ownKeys(value);
    const keys = Object.keys(value);
    if (ownKeys.some((key) => typeof key === "symbol") || ownKeys.length !== keys.length)
      throw new InvalidCanonicalJsonError(field);
    const entries = keys.sort().map((key) => {
      const encodedKey = canonicalString(key, `${field}.key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new InvalidCanonicalJsonError(field);
      return `${encodedKey}:${serialize(descriptor.value, stack, `${field}.${key}`)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

export function canonicalizeRfc8785(value: unknown): string {
  return serialize(value, new Set(), "$");
}
