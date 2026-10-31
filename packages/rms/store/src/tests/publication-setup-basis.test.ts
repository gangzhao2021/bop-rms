import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
} from "../contracts/store-configuration-administration.js";
import {
  parseStoreSetupDraft,
  storeSetupDraftContentFields,
} from "../contracts/store-setup-draft.js";
import { parseStoreSetupSaveCommand } from "../contracts/store-setup-operation.js";
import { createPostgresStorePublicationContentSource } from "../infrastructure/persistence/publication-content-source.js";
import { createPostgresStorePublicationMaterializer } from "../infrastructure/persistence/publication-materializer.js";

const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]))
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const digest = (value: unknown) => hash(canonical(value));
function fixture(modern = true) {
  const plain = {
    configurationReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(5),
    contactReference: id(6),
    receiptReference: id(7),
    taxConfigurationReference: id(8),
    paymentConfigurationReference: id(9),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({
      isoWeekday: i + 1,
      intervals:
        i === 0
          ? [
              {
                startLocalTime: "09:00:00",
                endLocalTime: "17:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 0,
                leadTimeSeconds: 0,
              },
            ]
          : [],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: id(12),
    publicationReference: id(13),
    liveGateEvidenceReference: id(14),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const old = createStoreConfigurationVersion(plain);
  const fees = ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
    chargeType,
    state: "Disabled",
  }));
  const snapshot = parseStoreSetupDraft({
    profile: "StoreSetupDraftV2",
    setupDraftReference: id(15),
    tenantReference: id(16),
    brandReference: id(2),
    storeReference: id(3),
    revision: 1,
    authoredByReference: id(17),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    baseConfigurationReference: null,
    content: {
      ...Object.fromEntries(
        storeSetupDraftContentFields.map((key) => [key, { state: "Configured", value: old[key] }]),
      ),
      feeContexts: { state: "Configured", value: fees },
    },
    createdAt: at,
    updatedAt: at,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
  });
  const configuration = createStoreConfigurationVersion({
    ...plain,
    ...(modern
      ? {
          setupBasis: {
            profile: "StoreSetupConfigurationBasisV2",
            tenantReference: id(16),
            setupDraftReference: id(15),
            sourceRevision: 1,
            sourceSnapshotDigest: digest(snapshot),
            feeContexts: fees,
          },
        }
      : {}),
  });
  const command = parseStoreSetupSaveCommand({
    profile: "StoreSetupSaveV2",
    tenantReference: id(16),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(17),
    operationReference: id(18),
    expectedSetupReference: null,
    expectedRevision: 0,
    purposeCode: "STORE_SETUP_DRAFT",
    content: snapshot.content,
  });
  const setupRow = {
    snapshot_json: snapshot,
    snapshot_digest: digest(snapshot),
    operation_id: id(18),
    actor_id: id(17),
    expected_setup_id: null,
    expected_revision: "0",
    intent_digest: digest(command),
  };
  const renamed: Record<string, string> = {
    configurationReference: "configuration_id",
    brandReference: "brand_id",
    storeReference: "store_id",
    source: "configuration_source",
  };
  const base = Object.fromEntries(
    Object.entries(configuration)
      .filter(([key]) => !["weeklySchedule", "exceptions", "setupBasis"].includes(key))
      .map(([key, value]) => [
        renamed[key] ?? key.replace(/[A-Z]/gu, (c) => "_" + c.toLowerCase()),
        value,
      ]),
  );
  const publication = {
    base,
    configuration_json: configuration,
    content_digest: digest(configuration),
    publishing_family_reference: id(19),
    configuration_type: "STORE_CONFIGURATION",
    purpose_code: "STORE_CONFIGURATION",
    business_day_start_source: "PlatformDefault",
    recorded_at: new Date(at),
  };
  const tx = {
    query: vi.fn(async (sql: string, values: readonly unknown[]) => {
      // Preserve typed bind capture for the SQL assertions below.
      void values;
      return {
        rows: sql.includes("FROM rms_store.store_setup_draft_revision")
          ? [setupRow]
          : sql.includes("SELECT to_jsonb(v)")
            ? [publication]
            : [],
        rowCount: 1,
      };
    }),
  };
  const options = {
    tenantReference: id(16),
    setupSnapshotReferences: { canonicalize: canonical, hashIntent: hash },
    brandReference: id(2),
    storeReference: id(3),
    configurationReference: id(1),
    authorize: vi.fn(async () => true),
    hashContent: digest,
  };
  return { configuration, snapshot, setupRow, publication, tx, options };
}
const read = (h: ReturnType<typeof fixture>) =>
  createPostgresStorePublicationContentSource(h.options)(h.tx, at);
function writer(h: ReturnType<typeof fixture>) {
  const c = h.configuration;
  const options = {
    ...h.options,
    publishingFamilyReference: id(19),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    businessDayStartSource: "PlatformDefault" as const,
    nextReference: () => id(20),
  };
  const input = {
    operation: {
      command: "Publish" as const,
      operationReference: parseStoreAdministrationReference(id(21)),
      brandReference: c.brandReference,
      storeReference: c.storeReference,
      intentDigest: digest(c),
      resultingVersion: c.configurationVersion,
      configuration: c,
    },
    expectedVersion: c.configurationVersion - 1,
    audit: {
      actorReference: parseStoreAdministrationReference(id(11)),
      auditReference: parseStoreAdministrationReference(id(22)),
      purposeCode: "STORE_CONFIGURATION",
      occurredAt: parseCanonicalInstant(at),
    },
  };
  const materialize = createPostgresStorePublicationMaterializer(options);
  return () => materialize(h.tx, input);
}
describe("Store publication immutable Setup basis (controlled owning SQL, not IAM/Live Gate proof)", () => {
  it("keeps legacy content reads unchanged without Setup or Tenant ports", async () => {
    const h = fixture(false);
    const { tenantReference, setupSnapshotReferences, ...legacy } = h.options;
    void tenantReference;
    void setupSnapshotReferences;
    expect(
      (await createPostgresStorePublicationContentSource(legacy)(h.tx, at)).configuration,
    ).toEqual(h.configuration);
    expect(h.tx.query.mock.calls.some(([sql]) => sql.includes("store_setup_draft_revision"))).toBe(
      false,
    );
  });
  it("joins original authored Setup with a different current publication author", async () => {
    const h = fixture();
    expect((await read(h)).configuration.setupBasis).toEqual(h.configuration.setupBasis);
    const lookup = h.tx.query.mock.calls.find(([sql]) =>
      sql.includes("store_setup_draft_revision"),
    );
    expect(lookup?.[1]).toEqual([id(16), id(2), id(3), id(15), 1, digest(h.snapshot)]);
  });
  it("preserves the entire basis in publication JSON and rechecks after authorization", async () => {
    const h = fixture();
    await writer(h)();
    const insert = h.tx.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO rms_store.store_configuration_publication_content"),
    );
    expect(JSON.parse(String(insert?.[1][7]))).toEqual(h.configuration);
    expect(
      h.tx.query.mock.calls.filter(([sql]) =>
        sql.includes("FROM rms_store.store_setup_draft_revision"),
      ),
    ).toHaveLength(2);
  });
  it.each(["tenant", "references"])(
    "requires captured actual %s for the new basis",
    async (key) => {
      const h = fixture();
      const options = { ...h.options };
      if (key === "tenant") Reflect.deleteProperty(options, "tenantReference");
      else Reflect.deleteProperty(options, "setupSnapshotReferences");
      await expect(createPostgresStorePublicationContentSource(options)(h.tx, at)).rejects.toThrow(
        "STORE_PUBLICATION_CONTENT_UNAVAILABLE",
      );
    },
  );
  it.each(["snapshot_digest", "intent_digest", "actor_id", "expected_revision"])(
    "refuses corrupt owning %s",
    async (field) => {
      const h = fixture();
      Reflect.set(
        h.setupRow,
        field,
        field === "expected_revision"
          ? "1"
          : field === "actor_id"
            ? id(99)
            : "sha256:" + "0".repeat(64),
      );
      await expect(read(h)).rejects.toThrow("STORE_PUBLICATION_CONTENT_UNAVAILABLE");
    },
  );
  it("rehashes full snapshot and refuses an otherwise valid different schedule", async () => {
    const h = fixture();
    h.setupRow.snapshot_json = parseStoreSetupDraft({
      ...h.snapshot,
      content: {
        ...h.snapshot.content,
        businessDayStartLocalTime: { state: "Configured", value: "05:00:00" },
      },
    });
    await expect(read(h)).rejects.toThrow("STORE_PUBLICATION_CONTENT_UNAVAILABLE");
    await expect(writer(h)()).rejects.toThrow();
    expect(h.tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
  it.each([
    ["defaultLocale", "fr-CA"],
    ["timeZone", "America/New_York"],
    ["capacityConfigurationReference", id(77)],
    ["supersedesConfigurationReference", id(78)],
    ["businessDayStartLocalTime", "05:00:00"],
  ])(
    "refuses complete configuration %s drift despite its valid publication hash",
    async (field, value) => {
      const h = fixture();
      h.configuration = createStoreConfigurationVersion({
        ...h.configuration,
        [field]: value,
        ...(field === "supersedesConfigurationReference" ? { configurationVersion: 2 } : {}),
      });
      h.publication.configuration_json = h.configuration;
      Reflect.set(
        h.publication.base,
        "configuration_version",
        h.configuration.configurationVersion,
      );
      h.publication.content_digest = digest(h.configuration);
      h.publication.business_day_start_source = "StoreOverride";
      Reflect.set(
        h.publication.base,
        field.replace(/[A-Z]/gu, (c) => "_" + c.toLowerCase()),
        value,
      );
      await expect(read(h)).rejects.toThrow("STORE_PUBLICATION_CONTENT_UNAVAILABLE");
      await expect(writer(h)()).rejects.toThrow();
      expect(h.tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    },
  );
  it("refuses a declared currency different from the immutable actual Setup", async () => {
    const h = fixture();
    Object.defineProperty(h.publication, "configuration_json", {
      value: { ...h.configuration, currencyCode: "EUR" },
      enumerable: true,
    });
    await expect(read(h)).rejects.toThrow("STORE_PUBLICATION_CONTENT_UNAVAILABLE");
  });
  it("rejects missing Committed original rather than trusting the content hash", async () => {
    const h = fixture();
    h.tx.query = vi.fn(async (sql: string, values: readonly unknown[]) => {
      // Preserve typed bind capture for the SQL assertions below.
      void values;
      return {
        rows: sql.includes("SELECT to_jsonb(v)") ? [h.publication] : [],
        rowCount: 1,
      };
    });
    await expect(read(h)).rejects.toThrow("STORE_PUBLICATION_CONTENT_UNAVAILABLE");
  });
  it("does not invoke getter-shaped owning result data", async () => {
    const h = fixture();
    const getter = vi.fn(() => h.snapshot);
    Object.defineProperty(h.setupRow, "snapshot_json", { get: getter, enumerable: true });
    await expect(read(h)).rejects.toThrow("STORE_PUBLICATION_CONTENT_UNAVAILABLE");
    expect(getter).not.toHaveBeenCalled();
  });
  it("refuses a replaced snapshot hashing port before insert", async () => {
    const h = fixture();
    const materialize = writer(h);
    h.options.setupSnapshotReferences.hashIntent = () => "sha256:" + "0".repeat(64);
    await expect(materialize()).rejects.toThrow();
    expect(h.tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
});
