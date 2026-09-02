import {
  parseNotificationDigest,
  parseNotificationInstant,
  parseNotificationReference,
  type NotificationDigest,
  type NotificationReference,
} from "../contracts/notification.js";

export interface ResumeTokenRecord {
  readonly tokenRecordReference: NotificationReference;
  readonly tokenHashDigest: NotificationDigest;
  readonly orderReference: NotificationReference;
  readonly brandReference: NotificationReference;
  readonly storeReference: NotificationReference;
  readonly attemptReference: NotificationReference;
  readonly purpose: "ReceiptResume";
  readonly deliveryOutcome: "Pending" | "Unknown";
  readonly mintedAt: string;
  readonly expiresAt: string;
}

export class ResumeTokenError extends Error {
  readonly code:
    | "RESUME_TOKEN_INPUT_INVALID"
    | "RESUME_TOKEN_SIBLING_LIMIT"
    | "RESUME_TOKEN_DEPENDENCY_UNAVAILABLE"
    | "RESUME_TOKEN_INVALID_OR_CONSUMED";
  constructor(code: ResumeTokenError["code"]) {
    super("resume token operation denied");
    this.name = "ResumeTokenError";
    this.code = code;
  }
}

export interface ResumeTokenPorts {
  readonly tokens: {
    mint(): Promise<{ readonly plaintextToken: string; readonly tokenHashDigest: string }>;
    hash(plaintextToken: string): Promise<string>;
  };
  readonly references: { generateTokenRecord(): string };
  readonly records: {
    listUnexpired(input: {
      readonly orderReference: NotificationReference;
      readonly purpose: "ReceiptResume";
      readonly observedAt: string;
    }): Promise<readonly ResumeTokenRecord[]>;
    append(record: ResumeTokenRecord): Promise<ResumeTokenRecord>;
    consumeAndRevokeSiblings(input: {
      readonly tokenHashDigest: NotificationDigest;
      readonly observedAt: string;
    }): Promise<{
      readonly grantReference: NotificationReference;
      readonly orderReference: NotificationReference;
      readonly brandReference: NotificationReference;
      readonly storeReference: NotificationReference;
      readonly consumedTokenRecordReference: NotificationReference;
      readonly revokedSiblingReferences: readonly NotificationReference[];
    } | null>;
  };
}

const plaintext = /^[A-Za-z0-9_-]{43,128}$/u;

function fail(code: ResumeTokenError["code"]): never {
  throw new ResumeTokenError(code);
}

function exact(
  value: unknown,
  fields: readonly string[],
  code: ResumeTokenError["code"],
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable)
      return fail(code);
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function record(value: unknown): ResumeTokenRecord {
  const fields = [
    "tokenRecordReference",
    "tokenHashDigest",
    "orderReference",
    "brandReference",
    "storeReference",
    "attemptReference",
    "purpose",
    "deliveryOutcome",
    "mintedAt",
    "expiresAt",
  ];
  const raw = exact(value, fields, "RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
  if (
    raw.purpose !== "ReceiptResume" ||
    (raw.deliveryOutcome !== "Pending" && raw.deliveryOutcome !== "Unknown")
  )
    return fail("RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({
    tokenRecordReference: parseNotificationReference(raw.tokenRecordReference),
    tokenHashDigest: parseNotificationDigest(raw.tokenHashDigest),
    orderReference: parseNotificationReference(raw.orderReference),
    brandReference: parseNotificationReference(raw.brandReference),
    storeReference: parseNotificationReference(raw.storeReference),
    attemptReference: parseNotificationReference(raw.attemptReference),
    purpose: "ReceiptResume",
    deliveryOutcome: raw.deliveryOutcome,
    mintedAt: parseNotificationInstant(raw.mintedAt),
    expiresAt: parseNotificationInstant(raw.expiresAt),
  });
}

export function createResumeTokenService(ports: ResumeTokenPorts) {
  return Object.freeze({
    async mintForAttempt(input: {
      readonly orderReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly attemptReference: string;
      readonly mintedAt: string;
      readonly expiresAt: string;
    }) {
      const raw = exact(
        input,
        [
          "orderReference",
          "brandReference",
          "storeReference",
          "attemptReference",
          "mintedAt",
          "expiresAt",
        ],
        "RESUME_TOKEN_INPUT_INVALID",
      );
      let orderReference, brandReference, storeReference, attemptReference, mintedAt, expiresAt;
      try {
        orderReference = parseNotificationReference(raw.orderReference);
        brandReference = parseNotificationReference(raw.brandReference);
        storeReference = parseNotificationReference(raw.storeReference);
        attemptReference = parseNotificationReference(raw.attemptReference);
        mintedAt = parseNotificationInstant(raw.mintedAt);
        expiresAt = parseNotificationInstant(raw.expiresAt);
      } catch {
        return fail("RESUME_TOKEN_INPUT_INVALID");
      }
      const lifetime = Date.parse(expiresAt) - Date.parse(mintedAt);
      if (lifetime <= 0 || lifetime > 30 * 60_000) return fail("RESUME_TOKEN_INPUT_INVALID");
      let active: readonly ResumeTokenRecord[];
      try {
        active = (
          await ports.records.listUnexpired({
            orderReference,
            purpose: "ReceiptResume",
            observedAt: mintedAt,
          })
        ).map(record);
      } catch {
        return fail("RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
      }
      if (active.length > 1 || (active.length === 1 && active[0]?.deliveryOutcome !== "Unknown"))
        return fail("RESUME_TOKEN_SIBLING_LIMIT");
      if (
        active.some(
          (item) =>
            item.orderReference !== orderReference ||
            item.brandReference !== brandReference ||
            item.storeReference !== storeReference ||
            item.attemptReference === attemptReference ||
            Date.parse(item.expiresAt) <= Date.parse(mintedAt),
        )
      )
        return fail("RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
      let minted;
      try {
        minted = await ports.tokens.mint();
      } catch {
        return fail("RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
      }
      if (!plaintext.test(minted.plaintextToken))
        return fail("RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
      const candidate = record({
        tokenRecordReference: ports.references.generateTokenRecord(),
        tokenHashDigest: minted.tokenHashDigest,
        orderReference,
        brandReference,
        storeReference,
        attemptReference,
        purpose: "ReceiptResume",
        deliveryOutcome: "Pending",
        mintedAt,
        expiresAt,
      });
      let saved;
      try {
        saved = record(await ports.records.append(candidate));
      } catch {
        return fail("RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
      }
      if (JSON.stringify(saved) !== JSON.stringify(candidate))
        return fail("RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({ plaintextToken: minted.plaintextToken, record: saved });
    },

    async consume(input: { readonly plaintextToken: string; readonly observedAt: string }) {
      const raw = exact(
        input,
        ["plaintextToken", "observedAt"],
        "RESUME_TOKEN_INVALID_OR_CONSUMED",
      );
      if (typeof raw.plaintextToken !== "string" || !plaintext.test(raw.plaintextToken))
        return fail("RESUME_TOKEN_INVALID_OR_CONSUMED");
      let observedAt, tokenHashDigest;
      try {
        observedAt = parseNotificationInstant(raw.observedAt);
        tokenHashDigest = parseNotificationDigest(await ports.tokens.hash(raw.plaintextToken));
      } catch {
        return fail("RESUME_TOKEN_INVALID_OR_CONSUMED");
      }
      let result;
      try {
        result = await ports.records.consumeAndRevokeSiblings({ tokenHashDigest, observedAt });
      } catch {
        return fail("RESUME_TOKEN_DEPENDENCY_UNAVAILABLE");
      }
      if (!result) return fail("RESUME_TOKEN_INVALID_OR_CONSUMED");
      return Object.freeze({
        grantReference: parseNotificationReference(result.grantReference),
        orderReference: parseNotificationReference(result.orderReference),
        brandReference: parseNotificationReference(result.brandReference),
        storeReference: parseNotificationReference(result.storeReference),
      });
    },
  });
}

export function buildReceiptResumeFragmentLink(input: {
  readonly origin: string;
  readonly orderReference: string;
  readonly plaintextToken: string;
}): string {
  const raw = exact(
    input,
    ["origin", "orderReference", "plaintextToken"],
    "RESUME_TOKEN_INPUT_INVALID",
  );
  if (
    typeof raw.origin !== "string" ||
    !/^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u.test(raw.origin) ||
    typeof raw.plaintextToken !== "string" ||
    !plaintext.test(raw.plaintextToken)
  )
    return fail("RESUME_TOKEN_INPUT_INVALID");
  const orderReference = parseNotificationReference(raw.orderReference);
  return `${raw.origin}/orders/${orderReference}/receipt#resume=${raw.plaintextToken}`;
}
