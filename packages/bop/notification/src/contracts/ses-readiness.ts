import {
  parseNotificationInstant,
  parseNotificationReference,
  type NotificationReference,
} from "./notification.js";

export type SesEnvironment = "Development" | "Staging" | "Production";

export interface SesReadinessEvidence {
  readonly evidenceReference: NotificationReference;
  readonly identityReference: NotificationReference;
  readonly environment: SesEnvironment;
  readonly region: "ca-central-1";
  readonly dkimStatus: "Verified";
  readonly spfStatus: "Aligned";
  readonly dmarcStatus: "ReportingActive";
  readonly productionAccessStatus: "Granted";
  readonly reviewedAt: string;
  readonly validUntil: string;
}

export class SesReadinessError extends Error {
  readonly code = "SES_READINESS_EVIDENCE_INVALID";
  constructor() {
    super("SES readiness evidence is invalid");
    this.name = "SesReadinessError";
  }
}

function fail(): never {
  throw new SesReadinessError();
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return fail();
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

export function parseSesReadinessEvidence(value: unknown): SesReadinessEvidence {
  const raw = exact(value, [
    "evidenceReference",
    "identityReference",
    "environment",
    "region",
    "dkimStatus",
    "spfStatus",
    "dmarcStatus",
    "productionAccessStatus",
    "reviewedAt",
    "validUntil",
  ]);
  if (
    !["Development", "Staging", "Production"].includes(String(raw.environment)) ||
    raw.region !== "ca-central-1" ||
    raw.dkimStatus !== "Verified" ||
    raw.spfStatus !== "Aligned" ||
    raw.dmarcStatus !== "ReportingActive" ||
    raw.productionAccessStatus !== "Granted"
  )
    return fail();
  let reviewedAt, validUntil;
  try {
    reviewedAt = parseNotificationInstant(raw.reviewedAt);
    validUntil = parseNotificationInstant(raw.validUntil);
  } catch {
    return fail();
  }
  if (Date.parse(reviewedAt) >= Date.parse(validUntil)) return fail();
  return Object.freeze({
    evidenceReference: parseNotificationReference(raw.evidenceReference),
    identityReference: parseNotificationReference(raw.identityReference),
    environment: raw.environment as SesEnvironment,
    region: "ca-central-1",
    dkimStatus: "Verified",
    spfStatus: "Aligned",
    dmarcStatus: "ReportingActive",
    productionAccessStatus: "Granted",
    reviewedAt,
    validUntil,
  });
}

export function assertSesReady(input: {
  readonly evidence: unknown;
  readonly environment: SesEnvironment;
  readonly evaluatedAt: unknown;
}): SesReadinessEvidence {
  const evidence = parseSesReadinessEvidence(input.evidence);
  let evaluatedAt;
  try {
    evaluatedAt = parseNotificationInstant(input.evaluatedAt);
  } catch {
    return fail();
  }
  if (
    evidence.environment !== input.environment ||
    Date.parse(evaluatedAt) < Date.parse(evidence.reviewedAt) ||
    Date.parse(evaluatedAt) >= Date.parse(evidence.validUntil)
  )
    return fail();
  return evidence;
}
