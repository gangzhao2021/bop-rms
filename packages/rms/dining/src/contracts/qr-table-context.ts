import {
  parseBrandReference,
  parseCanonicalInstant,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type OrganizationLifecycle,
  type StoreReference,
} from "@bop/tenant";

export type QrReference = string & { readonly __qrReference: unique symbol };
export type PublicStoreReference = string & { readonly __publicStoreReference: unique symbol };
export type PublicTableReference = string & { readonly __publicTableReference: unique symbol };
export type TableReference = string & { readonly __tableReference: unique symbol };
export type EvidenceReference = string & { readonly __evidenceReference: unique symbol };
export type PublicKeyReference = string & { readonly __publicKeyReference: unique symbol };
export type QrLocale = string & { readonly __qrLocale: unique symbol };
export type QrChannel = "DineIn" | "Pickup";

export interface ResolveQrTableContextRequest {
  readonly qrToken: string;
  readonly evaluatedAt: CanonicalInstant;
  readonly purpose: "CustomerEntry";
}
export interface QrProtectedHeader {
  readonly alg: "ES256";
  readonly kid: string;
  readonly typ: "BOP-QR";
}
export interface QrSignedPayload {
  readonly schemaVersion: 1;
  readonly qrReference: QrReference;
  readonly publicStoreReference: PublicStoreReference;
  readonly publicTableReference: PublicTableReference | null;
  readonly channel: QrChannel;
  readonly locale: QrLocale;
  readonly issuedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly revocationVersion: number;
}
export interface ParsedQrCompact {
  readonly header: QrProtectedHeader;
  readonly encodedPayload: string;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}
export interface QrVerificationKey {
  readonly kid: string;
  readonly algorithm: "ES256";
  readonly state: "Current" | "Overlap";
  readonly publicKeyReference: PublicKeyReference;
  readonly validFrom: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
  readonly compromisedAt: CanonicalInstant | null;
}
export interface QrVerificationKeySetEvidence {
  readonly registryVersion: number;
  readonly registryEvidenceReference: EvidenceReference;
  readonly validUntil: CanonicalInstant;
  readonly keys: readonly QrVerificationKey[];
}
export interface QrTableContextEvidence {
  readonly publicStoreReference: PublicStoreReference;
  readonly publicTableReference: PublicTableReference | null;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly tableReference: TableReference | null;
  readonly brandLifecycle: OrganizationLifecycle;
  readonly storeLifecycle: OrganizationLifecycle;
  readonly tableLifecycle: "Active" | "Suspended" | "Archived" | null;
  readonly assignmentState: "Active" | "Inactive" | null;
  readonly channel: QrChannel;
  readonly qrState: "Enabled" | "Revoked";
  readonly revocationVersion: number;
  readonly contextEvidenceReference: EvidenceReference;
  readonly validUntil: CanonicalInstant;
}
export interface QrTableContext {
  readonly qrReference: QrReference;
  readonly publicStoreReference: PublicStoreReference;
  readonly publicTableReference: PublicTableReference | null;
  readonly channel: QrChannel;
  readonly locale: QrLocale;
  readonly issuedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly revocationVersion: number;
}
export type ResolveQrTableContextResult =
  | Readonly<{ status: "Verified"; context: QrTableContext }>
  | Readonly<{ status: "InvalidRequest" }>
  | Readonly<{ status: "QrUnavailable" }>;

export class QrContractError extends Error {
  constructor() {
    super("qr table context contract is invalid");
    this.name = "QrContractError";
  }
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const kidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const segmentPattern = /^[A-Za-z0-9_-]+$/u;
const fail = (): never => {
  throw new QrContractError();
};

function record(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    fields.some((field, index) => keys[index] !== field) ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    return fail();
  return value as Readonly<Record<string, unknown>>;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return (
        descriptor === undefined ||
        !("value" in descriptor) ||
        (key !== "length" && !descriptor.enumerable)
      );
    })
  )
    return fail();
  return value;
}
function uuid<T extends string>(value: unknown): T {
  if (typeof value !== "string" || !uuidV7.test(value)) return fail();
  return value as T;
}
function instant(value: unknown): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return fail();
  }
}
function decode(segment: string): string {
  if (!segmentPattern.test(segment)) return fail();
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) return fail();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail();
  }
}
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail();
  }
}

export function parseResolveQrTableContextRequest(value: unknown): ResolveQrTableContextRequest {
  const input = record(value, ["qrToken", "evaluatedAt", "purpose"]);
  if (
    typeof input.qrToken !== "string" ||
    input.qrToken.length < 1 ||
    input.qrToken.length > 2048 ||
    input.purpose !== "CustomerEntry"
  )
    return fail();
  return Object.freeze({
    qrToken: input.qrToken,
    evaluatedAt: instant(input.evaluatedAt),
    purpose: "CustomerEntry",
  });
}

export function parseQrCompact(token: string): ParsedQrCompact {
  const parts = token.split(".");
  if (parts.length !== 3) return fail();
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return fail();
  const headerText = decode(encodedHeader);
  const raw = record(json(headerText), ["alg", "kid", "typ"]);
  if (
    raw.alg !== "ES256" ||
    raw.typ !== "BOP-QR" ||
    typeof raw.kid !== "string" ||
    !kidPattern.test(raw.kid)
  )
    return fail();
  const header = Object.freeze({ alg: "ES256", kid: raw.kid, typ: "BOP-QR" } as const);
  if (JSON.stringify(header) !== headerText) return fail();
  if (!segmentPattern.test(encodedSignature)) return fail();
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== encodedSignature)
    return fail();
  return Object.freeze({
    header,
    encodedPayload,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: Uint8Array.from(signature),
  });
}

export function parseQrSignedPayload(encodedPayload: string): QrSignedPayload {
  const text = decode(encodedPayload);
  const raw = record(json(text), [
    "schemaVersion",
    "qrReference",
    "publicStoreReference",
    "publicTableReference",
    "channel",
    "locale",
    "issuedAt",
    "expiresAt",
    "revocationVersion",
  ]);
  if (
    raw.schemaVersion !== 1 ||
    !["DineIn", "Pickup"].includes(raw.channel as string) ||
    typeof raw.locale !== "string" ||
    !localePattern.test(raw.locale) ||
    !Number.isSafeInteger(raw.revocationVersion) ||
    (raw.revocationVersion as number) < 1
  )
    return fail();
  const channel = raw.channel as QrChannel;
  const publicTableReference =
    raw.publicTableReference === null ? null : uuid<PublicTableReference>(raw.publicTableReference);
  if ((channel === "DineIn") !== (publicTableReference !== null)) return fail();
  const payload = Object.freeze({
    schemaVersion: 1,
    qrReference: uuid<QrReference>(raw.qrReference),
    publicStoreReference: uuid<PublicStoreReference>(raw.publicStoreReference),
    publicTableReference,
    channel,
    locale: raw.locale as QrLocale,
    issuedAt: instant(raw.issuedAt),
    expiresAt: instant(raw.expiresAt),
    revocationVersion: raw.revocationVersion as number,
  });
  if (JSON.stringify(payload) !== text) return fail();
  return payload;
}

export function parseQrVerificationKeySetEvidence(value: unknown): QrVerificationKeySetEvidence {
  const raw = record(value, ["registryVersion", "registryEvidenceReference", "validUntil", "keys"]);
  if (!Number.isSafeInteger(raw.registryVersion) || (raw.registryVersion as number) < 1)
    return fail();
  const keys = array(raw.keys, 8).map((item) => {
    const key = record(item, [
      "kid",
      "algorithm",
      "state",
      "publicKeyReference",
      "validFrom",
      "validUntil",
      "compromisedAt",
    ]);
    if (
      typeof key.kid !== "string" ||
      !kidPattern.test(key.kid) ||
      key.algorithm !== "ES256" ||
      !["Current", "Overlap"].includes(key.state as string)
    )
      return fail();
    const validFrom = instant(key.validFrom);
    const validUntil = instant(key.validUntil);
    if (Date.parse(validFrom) >= Date.parse(validUntil)) return fail();
    return Object.freeze({
      kid: key.kid,
      algorithm: "ES256" as const,
      state: key.state as "Current" | "Overlap",
      publicKeyReference: uuid<PublicKeyReference>(key.publicKeyReference),
      validFrom,
      validUntil,
      compromisedAt: key.compromisedAt === null ? null : instant(key.compromisedAt),
    });
  });
  if (
    new Set(keys.map((key) => key.kid)).size !== keys.length ||
    keys.some((key, index) => index > 0 && key.kid <= (keys[index - 1]?.kid ?? ""))
  )
    return fail();
  return Object.freeze({
    registryVersion: raw.registryVersion as number,
    registryEvidenceReference: uuid<EvidenceReference>(raw.registryEvidenceReference),
    validUntil: instant(raw.validUntil),
    keys: Object.freeze(keys),
  });
}

export function parseQrTableContextEvidence(value: unknown): QrTableContextEvidence {
  const raw = record(value, [
    "publicStoreReference",
    "publicTableReference",
    "brandReference",
    "storeReference",
    "tableReference",
    "brandLifecycle",
    "storeLifecycle",
    "tableLifecycle",
    "assignmentState",
    "channel",
    "qrState",
    "revocationVersion",
    "contextEvidenceReference",
    "validUntil",
  ]);
  if (
    !["Draft", "Active", "Suspended", "Archived"].includes(raw.brandLifecycle as string) ||
    !["Draft", "Active", "Suspended", "Archived"].includes(raw.storeLifecycle as string) ||
    !["DineIn", "Pickup"].includes(raw.channel as string) ||
    !["Enabled", "Revoked"].includes(raw.qrState as string) ||
    !Number.isSafeInteger(raw.revocationVersion) ||
    (raw.revocationVersion as number) < 1
  )
    return fail();
  const publicTableReference =
    raw.publicTableReference === null ? null : uuid<PublicTableReference>(raw.publicTableReference);
  const tableReference =
    raw.tableReference === null ? null : uuid<TableReference>(raw.tableReference);
  const channel = raw.channel as QrChannel;
  if (
    (channel === "DineIn") !== (publicTableReference !== null && tableReference !== null) ||
    (channel === "DineIn" &&
      (!["Active", "Suspended", "Archived"].includes(raw.tableLifecycle as string) ||
        !["Active", "Inactive"].includes(raw.assignmentState as string))) ||
    (channel === "Pickup" && (raw.tableLifecycle !== null || raw.assignmentState !== null))
  )
    return fail();
  try {
    return Object.freeze({
      publicStoreReference: uuid<PublicStoreReference>(raw.publicStoreReference),
      publicTableReference,
      brandReference: parseBrandReference(raw.brandReference),
      storeReference: parseStoreReference(raw.storeReference),
      tableReference,
      brandLifecycle: raw.brandLifecycle as OrganizationLifecycle,
      storeLifecycle: raw.storeLifecycle as OrganizationLifecycle,
      tableLifecycle: raw.tableLifecycle as QrTableContextEvidence["tableLifecycle"],
      assignmentState: raw.assignmentState as QrTableContextEvidence["assignmentState"],
      channel,
      qrState: raw.qrState as "Enabled" | "Revoked",
      revocationVersion: raw.revocationVersion as number,
      contextEvidenceReference: uuid<EvidenceReference>(raw.contextEvidenceReference),
      validUntil: instant(raw.validUntil),
    });
  } catch {
    return fail();
  }
}
