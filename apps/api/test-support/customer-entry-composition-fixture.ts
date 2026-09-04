import { createHmac, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { vi } from "vitest";
import {
  parseGuestAdmissionEvidence,
  parseGuestRawCredential,
  parseGuestSelectorHash,
  type GuestSessionRecord,
} from "@bop/identity";
import { parseQrTableContextEvidence, parseQrVerificationKeySetEvidence } from "@rms/dining";
import {
  parsePublicStoreResolutionEvidence,
  parseStoreOperatingStatusResolutionEvidence,
} from "@rms/store";
import type {
  CustomerEntryAdmissionInput,
  CustomerEntryCompositionOptions,
} from "../src/customer-entry-composition.js";

export const id = (value: number) =>
  `00000000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
export const now = "2026-01-15T12:00:00.000Z";
const before = "2026-01-01T00:00:00.000Z";
const until = "2026-02-01T00:00:00.000Z";
export const admissionUntil = "2026-01-15T12:01:00.000Z";
const scope = { kind: "Store", brandReference: id(1), storeReference: id(2) };

function publication(configurationType: string, reference: string) {
  const common = {
    familyReference: id(21),
    configurationType,
    purposeCode: "CUSTOMER_ENTRY",
    snapshotReference: reference,
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    scope,
    createdAt: before,
  };
  return {
    publishingLifecycle: {
      ...common,
      lifecycleId: id(22),
      version: 1,
      state: "Published",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      changedAt: before,
    },
    publishingRelease: {
      ...common,
      releaseId: id(23),
      sequence: 1,
      sourceLifecycleId: id(22),
      kind: "Publish",
      previousReleaseId: null,
    },
    effectiveVersion: {
      ...common,
      timingVersionReference: id(24),
      familyReference: id(25),
      configurationReference: reference,
      releaseReference: id(23),
      version: 1,
      period: {
        timeZone: "UTC",
        effectiveFrom: { instant: before, localDateTime: before.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: { instant: until, localDateTime: until.slice(0, -1), utcOffsetMinutes: 0 },
      },
      periodDigest: `sha256:${"b".repeat(64)}`,
      approvalEvidenceReference: id(26),
    },
  };
}

export function fixture() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pepper = randomBytes(32);
  let sequence = 100;
  const records = new Map<string, GuestSessionRecord>();
  const payload = {
    schemaVersion: 1,
    qrReference: id(3),
    publicStoreReference: id(4),
    publicTableReference: id(5) as string | null,
    channel: "DineIn",
    locale: "en-CA",
    issuedAt: before,
    expiresAt: until,
    revocationVersion: 1,
  };
  const token = () => {
    const signingInput = [{ alg: "ES256", kid: "synthetic", typ: "BOP-QR" }, payload]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${signingInput}.${sign("sha256", Buffer.from(signingInput), {
      key: keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url")}`;
  };
  const context = {
    publicStoreReference: id(4),
    publicTableReference: id(5) as string | null,
    brandReference: id(1),
    storeReference: id(2),
    tableReference: id(6) as string | null,
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    tableLifecycle: "Active" as string | null,
    assignmentState: "Active" as string | null,
    channel: "DineIn",
    qrState: "Enabled",
    revocationVersion: 1,
    contextEvidenceReference: id(7),
    validUntil: until,
  };
  const resolution = {
    publicStoreReference: id(4),
    brandReference: id(1),
    storeReference: id(2),
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    lookupEvidenceReference: id(8),
    validUntil: until,
  };
  const profile = {
    profileReference: id(9),
    profileVersion: 1,
    brandReference: id(1),
    storeReference: id(2),
    classification: "Public",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA"],
    localizedFields: {
      "en-CA": { brandDisplayName: "Synthetic Brand", storeDisplayName: "Synthetic Store" },
    },
    currencyCode: "CAD",
    timeZone: "UTC",
    address: {
      countryCode: "CA",
      regionCode: "ON",
      locality: "Exampleville",
      postalCode: "A1A 1A1",
      addressLines: ["100 Example Avenue"],
    },
    businessPhone: "+14165550100",
    website: "https://example.test/store",
    logo: null,
    contentDigest: `sha256:${"a".repeat(64)}`,
    ...publication("STORE_PROFILE", id(9)),
  };
  const operating = {
    configurationReference: id(10),
    configurationVersion: 1,
    brandReference: id(1),
    storeReference: id(2),
    classification: "Public",
    timeZone: "UTC",
    weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
      isoWeekday: index + 1,
      intervals: [
        {
          startLocalTime: "00:00:00",
          endLocalTime: "23:59:59",
          endsNextDay: false,
          serviceModes: ["DineIn", "Pickup"],
        },
      ],
    })),
    exceptions: [],
    temporaryClosures: [],
    contentDigest: `sha256:${"a".repeat(64)}`,
    ...publication("STORE_OPERATING_HOURS", id(10)),
  };
  const admissionEvidence = (input: CustomerEntryAdmissionInput) => ({
    decision: "Allowed",
    evidenceReference: id(11),
    entryRequestReference: input.entryRequestReference,
    brandReference: input.scope.brandReference,
    storeReference: input.scope.storeReference,
    publicStoreReference: input.context.publicStoreReference,
    publicTableReference: input.context.publicTableReference,
    channel: input.context.channel,
    locale: input.context.locale,
    qrReference: input.context.qrReference,
    qrRevocationVersion: input.context.revocationVersion,
    evaluatedAt: now,
    validUntil: admissionUntil,
  });
  const consumed = new Set<string>();
  const admission = vi.fn(async (input: CustomerEntryAdmissionInput) => {
    if (consumed.has(input.entryRequestReference)) return null;
    consumed.add(input.entryRequestReference);
    return parseGuestAdmissionEvidence(admissionEvidence(input));
  });
  const hash = (purpose: string, value: string) =>
    parseGuestSelectorHash(
      createHmac("sha256", pepper).update(`${purpose}:${value}`).digest("hex"),
    );
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected synthetic operation");
  };
  const create = vi.fn(async ({ record }: { record: GuestSessionRecord }) => {
    if (records.has(record.operationReference)) throw new Error("synthetic conflict");
    records.set(record.operationReference, record);
    return record;
  });
  const options: CustomerEntryCompositionOptions = {
    qr: {
      keys: {
        load: vi.fn(async () =>
          parseQrVerificationKeySetEvidence({
            registryVersion: 1,
            registryEvidenceReference: id(12),
            validUntil: until,
            keys: [
              {
                kid: "synthetic",
                algorithm: "ES256",
                state: "Current",
                publicKeyReference: id(13),
                validFrom: before,
                validUntil: until,
                compromisedAt: null,
              },
            ],
          }),
        ),
      },
      verifier: {
        verify: vi.fn(async (input) =>
          verify(
            "sha256",
            Buffer.from(input.signingInput),
            {
              key: keys.publicKey,
              dsaEncoding: "ieee-p1363",
            },
            input.signature,
          )
            ? ("Verified" as const)
            : ("Invalid" as const),
        ),
      },
      contexts: { resolve: vi.fn(async () => parseQrTableContextEvidence(context)) },
      telemetry: { record: vi.fn() },
    },
    profile: {
      resolution: { resolve: vi.fn(async () => parsePublicStoreResolutionEvidence(resolution)) },
      profiles: { loadCandidates: vi.fn(async () => [profile]) },
      telemetry: { record: vi.fn() },
    },
    operating: {
      resolution: {
        resolve: vi.fn(async () => parseStoreOperatingStatusResolutionEvidence(resolution)),
      },
      configurations: { loadCandidates: vi.fn(async () => [operating]) },
      telemetry: { record: vi.fn() },
    },
    admission: { consume: admission },
    session: {
      credentials: {
        generateCredential: vi.fn(() =>
          parseGuestRawCredential(randomBytes(32).toString("base64url")),
        ),
        generateSessionReference: () => id(++sequence),
        hashCredential: hash,
        hashOperationIntent: (intent) => hash("Intent", intent),
        equals: (a, b) => a === b,
      },
      binding: { validate: async () => "Current" },
      store: {
        create,
        resolveOperation: async (operation) => records.get(operation) ?? null,
        resolve: async (selector) =>
          [...records.values()].find((record) => record.sessionSelectorHash === selector) ?? null,
        touchInteractive: unexpected,
        rotate: unexpected,
        revoke: unexpected,
      },
    },
  };
  const input = () => ({
    entryRequestReference: id(++sequence),
    operationReference: id(++sequence),
    requestedAt: now,
    qrToken: token(),
  });
  return {
    options,
    input,
    token,
    records,
    create,
    context,
    resolution,
    payload,
    profile,
    operating,
    admission,
    admissionEvidence,
  };
}
