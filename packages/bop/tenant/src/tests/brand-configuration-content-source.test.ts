import { describe, expect, it, vi } from "vitest";
import {
  parseTenantBrandConfigurationContentRequest,
  parseTenantOptionSetBrandConfigurationContentRequest,
  createPostgresTenantOptionSetBrandConfigurationContentSource,
  parseTenantStoreBrandConfigurationContentRequest,
  createPostgresTenantStoreBrandConfigurationContentSource,
  tenantBrandConfigurationRequiredFields,
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContent,
  tenantBrandConfigurationContentDigest,
} from "../index.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
const shape = (patch: Record<string, unknown> = {}) => ({
  configurationVersionReference: id(10),
  brandReference: id(2),
  configurationVersion: 1,
  lifecycle: "Draft",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  mediaThemeReference: null,
  catalogSourceReference: id(12),
  platformTemplateReference: id(13),
  overrideAllowedFieldCodes: ["DISPLAY.THEME"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesVersionReference: null,
  reasonCode: "INITIAL_CONFIGURATION",
  authoredByReference: id(20),
  approvedByReference: null,
  approvalEvidenceReference: null,
  publicationReference: null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
  ...patch,
});
const request = {
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(20),
  purposeCode: "CATALOG_PRODUCT_CONTENT",
  configurationVersionReference: id(10),
  expectedBrandVersion: 1,
  originalIntentDigest: "sha256:" + "a".repeat(64),
  observedAt: at,
  validUntil: "2026-09-11T10:00:30.000Z",
};
describe("owning Brand content profile", () => {
  it("preserves the digest across allowed governance transitions", () => {
    const initial = tenantBrandConfigurationContentDigest(shape());
    for (const lifecycle of [
      "PendingApproval",
      "Approved",
      "Published",
      "Superseded",
      "Archived",
    ]) {
      const approved = lifecycle !== "PendingApproval";
      const published = ["Published", "Superseded", "Archived"].includes(lifecycle);
      expect(
        tenantBrandConfigurationContentDigest(
          shape({
            lifecycle,
            approvedByReference: approved ? id(21) : null,
            approvalEvidenceReference: approved ? id(22) : null,
            publicationReference: published ? id(23) : null,
            updatedAt: "2026-09-11T10:01:00.000Z",
          }),
        ),
      ).toBe(initial);
    }
  });
  it.each([
    { configurationVersionReference: id(99) },
    { brandReference: id(99) },
    { configurationVersion: 2, supersedesVersionReference: id(99) },
    { defaultLocale: "fr-CA" },
    { supportedLocales: ["en-CA"] },
    { mediaThemeReference: id(99) },
    { catalogSourceReference: id(99) },
    { platformTemplateReference: id(99) },
    { overrideAllowedFieldCodes: [] },
    { hardRequirementFieldCodes: [] },
    { effectiveFrom: "2026-09-11T10:01:00.000Z" },
    { effectiveUntil: "2026-09-11T11:00:00.000Z" },
    { reasonCode: "CHANGED" },
    { authoredByReference: id(99) },
    { createdAt: "2026-09-11T09:59:00.000Z" },
  ])("structural change invalidates content binding (%#)", (patch) => {
    expect(tenantBrandConfigurationContentDigest(shape(patch))).not.toBe(
      tenantBrandConfigurationContentDigest(shape()),
    );
  });
  it("sorts set members and detaches immutable output", () => {
    const input = shape();
    const result = tenantBrandConfigurationContent(input);
    expect(
      tenantBrandConfigurationContentDigest({ ...input, supportedLocales: ["fr-CA", "en-CA"] }),
    ).toBe(tenantBrandConfigurationContentDigest(input));
    input.supportedLocales.push("de-DE");
    expect(result.supportedLocales).toEqual(["en-CA", "fr-CA"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.supportedLocales)).toBe(true);
    expect(Object.keys(result)).not.toContain("approvedByReference");
    expect(Object.keys(result)).not.toContain("publicationReference");
  });
  it("does not evaluate record or nested array accessors", () => {
    const getter = vi.fn(() => "en-CA");
    const record = shape();
    Object.defineProperty(record, "defaultLocale", { get: getter, enumerable: true });
    expect(() => parseTenantRecordedBrandConfiguration(record)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
    const nested = shape();
    Object.defineProperty(nested.supportedLocales, "0", { get: getter, enumerable: true });
    expect(() => parseTenantRecordedBrandConfiguration(nested)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ...shape(), unsupported: true },
    { ...shape(), supportedLocales: new Array(2) },
    shape({
      lifecycle: "Published",
      approvedByReference: id(20),
      approvalEvidenceReference: id(22),
      publicationReference: id(23),
    }),
  ])("denies malformed metadata (%#)", (input) => {
    expect(() => parseTenantRecordedBrandConfiguration(input)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
  });
});
describe("Brand content query contract", () => {
  it("copies exact bounded current observation intent", () => {
    expect(parseTenantBrandConfigurationContentRequest(request)).toEqual(request);
  });
  it.each([
    {},
    { ...request, unsupported: true },
    { ...request, purposeCode: "OTHER_PURPOSE" },
    { ...request, validUntil: at },
    { ...request, validUntil: "2026-09-11T10:00:30.001Z" },
    { ...request, expectedBrandVersion: 0 },
    { ...request, tenantReference: "unrestricted" },
    { ...request, actorReference: "unrestricted" },
    { ...request, originalIntentDigest: "a".repeat(64) },
  ])("denies incomplete/unbound observation (%#)", (input) => {
    expect(() => parseTenantBrandConfigurationContentRequest(input)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
  });
  it("does not invoke a query accessor", () => {
    const getter = vi.fn(() => at);
    const input = { ...request };
    Object.defineProperty(input, "observedAt", { get: getter, enumerable: true });
    expect(() => parseTenantBrandConfigurationContentRequest(input)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
    expect(getter).not.toHaveBeenCalled();
  });
});

const optionRequest = {
  ...request,
  purposeCode: "CATALOG_OPTION_SET_PUBLICATION" as const,
  optionSetReference: id(30),
  versionReference: id(31),
  expectedAggregateVersion: 2,
  sourceDigest: "sha256:" + "b".repeat(64),
  contentDigest: "sha256:" + "c".repeat(64),
  configurationDigest: "sha256:" + "d".repeat(64),
  graphDigest: "sha256:" + "e".repeat(64),
  activationAt: at,
  validUntil: "2026-09-11T10:00:05.000Z",
};
describe("fixed Option publication Brand content admission", () => {
  it("detaches the complete original graph intent and preserves exact Option purpose", () => {
    const parsed = parseTenantOptionSetBrandConfigurationContentRequest(optionRequest);
    expect(parsed).toEqual(optionRequest);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseTenantBrandConfigurationContentRequest(optionRequest)).toThrow();
  });
  it.each([
    { purposeCode: "CATALOG_PRODUCT_CONTENT" },
    { optionSetReference: "unrestricted" },
    { versionReference: "unrestricted" },
    { expectedAggregateVersion: 0 },
    { sourceDigest: "bad" },
    { contentDigest: "bad" },
    { configurationDigest: "bad" },
    { graphDigest: "bad" },
    { originalIntentDigest: "bad" },
    { activationAt: "invalid" },
    { validUntil: "2026-09-11T10:00:05.001Z" },
    { validUntil: at },
    { extra: true },
  ])("rejects an incomplete or substituted original intent %#", (patch) => {
    expect(() =>
      parseTenantOptionSetBrandConfigurationContentRequest({ ...optionRequest, ...patch }),
    ).toThrow("TENANT_BRAND_CONFIGURATION_UNAVAILABLE");
  });
  it("rejects caller getters before reading any anchor", () => {
    const getter = vi.fn(() => optionRequest.graphDigest);
    const input = { ...optionRequest };
    Object.defineProperty(input, "graphDigest", { get: getter, enumerable: true });
    expect(() => parseTenantOptionSetBrandConfigurationContentRequest(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  function fixture() {
    let now = at,
      allowed = true;
    const configuration = shape({
      lifecycle: "Published",
      approvedByReference: id(21),
      approvalEvidenceReference: id(22),
      publicationReference: id(23),
    });
    const row: Record<string, unknown> = { precise: true };
    const names: Record<string, string> = {
      configurationVersionReference: "configuration_version_id",
      brandReference: "brand_id",
    };
    for (const [key, value] of Object.entries(configuration)) {
      row[names[key] ?? key.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase())] =
        key === "configurationVersion" ? String(value) : value;
    }
    const query = vi.fn(async (sql: string) => {
      if (sql === "SHOW transaction_isolation")
        return { rows: [{ transaction_isolation: "read committed" }] };
      if (sql.includes("FROM bop_tenant.brand WHERE"))
        return {
          rows: [
            { brand_id: id(2), lifecycle: "Active", version: "1", updated_at: at, precise: true },
          ],
        };
      if (sql.includes("FROM bop_tenant.brand_configuration_version")) return { rows: [row] };
      return { rows: [] };
    });
    const tx = { query };
    const seen: unknown[] = [];
    const source = createPostgresTenantOptionSetBrandConfigurationContentSource({
      brandReference: id(2),
      clock: () => now,
      transactions: { run: (work) => work(tx) },
      authority: {
        async withCurrentContentRead(input, fields, work) {
          seen.push(input, fields);
          if (!allowed) throw new Error("DENIED");
          const result = await work();
          if (!allowed) throw new Error("DENIED");
          return result;
        },
        async isCurrent(actual, input, fields) {
          expect(actual).toBe(tx);
          expect(input).toEqual(optionRequest);
          expect(fields).toEqual(tenantBrandConfigurationRequiredFields);
          return allowed;
        },
      },
    });
    return {
      source,
      tx,
      query,
      seen,
      setNow: (value: string) => {
        now = value;
      },
      revoke: () => {
        allowed = false;
      },
    };
  }
  it("uses actual owning materialization under Option purpose without asserting current publication", async () => {
    const f = fixture();
    await f.source.withRecordedConfiguration(optionRequest, async (packet, actual) => {
      expect(actual).toBe(f.tx);
      expect(packet.configuration.configurationVersionReference).toBe(id(10));
      expect(packet.configuration.lifecycle).toBe("Published");
      expect(packet.currentPublication).toBe("NotEvaluated");
      expect(packet.validUntil).toBe(optionRequest.validUntil);
      expect(packet.contentDigest).toBe(
        tenantBrandConfigurationContentDigest(packet.configuration),
      );
    });
    expect(f.seen).toEqual([optionRequest, tenantBrandConfigurationRequiredFields]);
  });
  it.each(["denial", "expiry"])(
    "refuses late %s before returning from the owner holder",
    async (cause) => {
      const f = fixture();
      await expect(
        f.source.withRecordedConfiguration(optionRequest, async () => {
          if (cause === "denial") f.revoke();
          else f.setNow(optionRequest.validUntil);
        }),
      ).rejects.toThrow("TENANT_BRAND_CONFIGURATION_UNAVAILABLE");
    },
  );
  it("refuses purpose substitution before SQL or callback", async () => {
    const f = fixture(),
      work = vi.fn();
    await expect(
      f.source.withRecordedConfiguration(
        {
          ...optionRequest,
          purposeCode: "CATALOG_PRODUCT_CONTENT",
        } as unknown as typeof optionRequest,
        work,
      ),
    ).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});

const storeRequest = {
  ...request,
  purposeCode: "STORE_CONFIGURATION" as const,
  validUntil: "2026-09-11T10:00:05.000Z",
};
describe("fixed Store configuration Brand content admission", () => {
  function fixture(patch: Record<string, unknown> = {}) {
    let now = at;
    let allowed = true;
    const configuration = shape({
      lifecycle: "Published",
      approvedByReference: id(21),
      approvalEvidenceReference: id(22),
      publicationReference: id(23),
      ...patch,
    });
    const row: Record<string, unknown> = { precise: true };
    const names: Record<string, string> = {
      configurationVersionReference: "configuration_version_id",
      brandReference: "brand_id",
    };
    for (const [key, value] of Object.entries(configuration)) {
      row[names[key] ?? key.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase())] =
        key === "configurationVersion" ? String(value) : value;
    }
    const query = vi.fn(async (sql: string) => {
      if (sql === "SHOW transaction_isolation")
        return { rows: [{ transaction_isolation: "read committed" }] };
      if (sql.includes("FROM bop_tenant.brand WHERE"))
        return {
          rows: [
            { brand_id: id(2), lifecycle: "Active", version: "1", updated_at: at, precise: true },
          ],
        };
      if (sql.includes("FROM bop_tenant.brand_configuration_version")) return { rows: [row] };
      return { rows: [] };
    });
    const tx = { query };
    const seen: unknown[] = [];
    const source = createPostgresTenantStoreBrandConfigurationContentSource({
      brandReference: id(2),
      clock: () => now,
      transactions: { run: (work) => work(tx) },
      authority: {
        async withCurrentContentRead(input, fields, work) {
          seen.push(input, fields);
          if (!allowed) throw new Error("DENIED");
          return work();
        },
        async isCurrent(actual, input, fields) {
          expect(actual).toBe(tx);
          expect(input).toEqual(storeRequest);
          expect(fields).toEqual(tenantBrandConfigurationRequiredFields);
          return allowed;
        },
      },
    });
    return {
      source,
      query,
      tx,
      seen,
      revoke: () => {
        allowed = false;
      },
      expire: () => {
        now = storeRequest.validUntil;
      },
    };
  }
  it("detaches the closed Store purpose and retains owning recorded metadata without release eligibility", async () => {
    const input = { ...storeRequest };
    const parsed = parseTenantStoreBrandConfigurationContentRequest(input);
    expect(parsed).toEqual(storeRequest);
    expect(Object.isFrozen(parsed)).toBe(true);
    input.actorReference = id(25);
    expect(parsed.actorReference).toBe(id(20));
    const f = fixture();
    await f.source.withRecordedConfiguration(parsed, async (packet, actual) => {
      expect(actual).toBe(f.tx);
      expect(packet.profile).toBe("TenantRecordedBrandConfigurationV1");
      expect(packet.configuration.configurationVersionReference).toBe(id(10));
      expect(packet.contentDigest).toBe(
        tenantBrandConfigurationContentDigest(packet.configuration),
      );
      expect(packet.validUntil).toBe(storeRequest.validUntil);
      expect(packet.currentPublication).toBe("NotEvaluated");
    });
    expect(f.seen).toEqual([storeRequest, tenantBrandConfigurationRequiredFields]);
    expect(() => parseTenantBrandConfigurationContentRequest(storeRequest)).toThrow();
    expect(() => parseTenantOptionSetBrandConfigurationContentRequest(storeRequest)).toThrow();
  });
  it.each([
    { purposeCode: "CATALOG_PRODUCT_CONTENT" },
    { purposeCode: "CATALOG_OPTION_SET_PUBLICATION" },
    { validUntil: "2026-09-11T10:00:05.001Z" },
    { validUntil: at },
    { expectedBrandVersion: 0 },
    { configurationVersionReference: "unrestricted" },
    { originalIntentDigest: "a".repeat(64) },
    { tenantReference: "unrestricted" },
    { brandReference: id(3) },
    { extra: true },
  ])("refuses substituted Store admission before any SQL %#", async (patch) => {
    const f = fixture();
    const work = vi.fn();
    await expect(
      f.source.withRecordedConfiguration(
        { ...storeRequest, ...patch } as typeof storeRequest,
        work,
      ),
    ).rejects.toThrow("TENANT_BRAND_CONFIGURATION_UNAVAILABLE");
    expect(f.query).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
  it("never executes a Store request getter", () => {
    const getter = vi.fn(() => id(10));
    const input = { ...storeRequest };
    Object.defineProperty(input, "configurationVersionReference", {
      get: getter,
      enumerable: true,
    });
    expect(() => parseTenantStoreBrandConfigurationContentRequest(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([{ configurationVersionReference: id(11) }, { brandReference: id(3) }])(
    "refuses an immutable row with substituted configuration or scope %#",
    async (patch) => {
      const f = fixture(patch);
      const work = vi.fn();
      await expect(f.source.withRecordedConfiguration(storeRequest, work)).rejects.toThrow(
        "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
      );
      expect(work).not.toHaveBeenCalled();
    },
  );
  it.each(["denial", "expiry", "callback failure"])(
    "retains the finite owner boundary on late %s",
    async (cause) => {
      const f = fixture();
      await expect(
        f.source.withRecordedConfiguration(storeRequest, async () => {
          if (cause === "denial") f.revoke();
          else if (cause === "expiry") f.expire();
          else throw new Error("untrusted callback failure");
        }),
      ).rejects.toThrow("TENANT_BRAND_CONFIGURATION_UNAVAILABLE");
    },
  );
});
