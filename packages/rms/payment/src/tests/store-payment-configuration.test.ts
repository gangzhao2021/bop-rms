import { describe, expect, it } from "vitest";
import {
  StorePaymentConfigurationError,
  parseStorePaymentConfigurationContent,
  parseStorePaymentConfigurationVersion,
  parseStorePaymentConfigurationSave,
  parseStorePaymentConfigurationResolve,
  parseStorePaymentConfigurationReceipt,
  parseStorePaymentConfigurationCurrent,
} from "../contracts/store-payment-configuration.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  later = "2026-10-05T10:01:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const content = () => ({
  customerOnlineCardEnabled: false,
  staffTerminalCardPresentEnabled: false,
  staffTerminalInteracEnabled: false,
});
const save = () => ({
  profile: "StorePaymentConfigurationSaveV1",
  ...scope,
  operationReference: id(5),
  expectedConfigurationReference: null,
  expectedRevision: 0,
  content: content(),
  purposeCode: "STORE_PAYMENT_CONFIGURATION",
});
const version = () => ({
  profile: "StorePaymentConfigurationV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationReference: id(6),
  revision: 1,
  authoredByReference: id(4),
  previousConfigurationReference: null,
  content: content(),
  currencyCode: "CAD",
  createdAt: at,
  updatedAt: at,
  dataClassification: "Internal",
});
const receipt = () => ({
  profile: "StorePaymentConfigurationReceiptV1",
  ...scope,
  operationReference: id(5),
  intentDigest: "sha256:" + "a".repeat(64),
  expectedConfigurationReference: null,
  expectedRevision: 0,
  outcome: "Committed",
  snapshot: version(),
  auditReference: id(7),
  occurredAt: at,
});
const current = () => ({
  profile: "StorePaymentConfigurationCurrentV1",
  ...scope,
  snapshot: version(),
  observedAt: at,
  validUntil: "2026-10-05T10:00:05.000Z",
  providerReadiness: "NotEvaluated",
});
function invalid(work: () => unknown) {
  expect(work).toThrowError(StorePaymentConfigurationError);
  try {
    work();
  } catch (error) {
    expect(error).toMatchObject({
      code: "STORE_PAYMENT_CONFIGURATION_INPUT_INVALID",
      message: "Store payment configuration is unavailable",
    });
  }
}

describe("Store-owned selection of immutable Payment configurations", () => {
  it("allows all channels disabled to be saved without claiming Provider readiness", () => {
    expect(parseStorePaymentConfigurationSave(save()).content).toEqual(content());
    expect(parseStorePaymentConfigurationCurrent(current()).providerReadiness).toBe("NotEvaluated");
    invalid(() =>
      parseStorePaymentConfigurationCurrent({ ...current(), providerReadiness: "ProviderReady" }),
    );
  });
  it.each(
    Array.from({ length: 8 }, (_, n) => ({
      customerOnlineCardEnabled: Boolean(n & 1),
      staffTerminalCardPresentEnabled: Boolean(n & 2),
      staffTerminalInteracEnabled: Boolean(n & 4),
    })),
  )("keeps each explicit channel decision independent %j", (choices) => {
    expect(parseStorePaymentConfigurationContent(choices)).toEqual(choices);
  });
  it("detaches and deep-freezes normalized save without retaining caller objects", () => {
    const source = save(),
      parsed = parseStorePaymentConfigurationSave(source);
    source.content.customerOnlineCardEnabled = true;
    expect(parsed.content.customerOnlineCardEnabled).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.content)).toBe(true);
  });
  it("creates successor identity while preserving previously selected immutable configuration", () => {
    const original = parseStorePaymentConfigurationVersion(version());
    const successor = parseStorePaymentConfigurationVersion({
      ...version(),
      configurationReference: id(8),
      revision: 2,
      previousConfigurationReference: original.configurationReference,
      authoredByReference: id(9),
      updatedAt: later,
      content: { ...content(), customerOnlineCardEnabled: true },
    });
    const committed = parseStorePaymentConfigurationReceipt({
      ...receipt(),
      actorReference: id(9),
      expectedConfigurationReference: id(6),
      expectedRevision: 1,
      snapshot: successor,
      occurredAt: later,
    });
    expect(original.configurationReference).toBe(id(6));
    expect(original.content.customerOnlineCardEnabled).toBe(false);
    expect(committed.snapshot).toMatchObject({
      configurationReference: id(8),
      previousConfigurationReference: id(6),
      createdAt: at,
      updatedAt: later,
      authoredByReference: id(9),
    });
  });
  it("historical snapshot author can differ from the current authorized reader", () => {
    const parsed = parseStorePaymentConfigurationCurrent({ ...current(), actorReference: id(9) });
    expect(parsed.actorReference).toBe(id(9));
    expect(parsed.snapshot?.authoredByReference).toBe(id(4));
  });
  it("current absence is explicit without declaring an abandoned operation", () => {
    const parsed = parseStorePaymentConfigurationCurrent({ ...current(), snapshot: null });
    expect(parsed.snapshot).toBeNull();
    expect(Object.hasOwn(parsed, "outcome")).toBe(false);
  });
  it("resolve is payload-free original identity and accepts a maximum historical revision", () => {
    const { content: unusedContent, ...original } = save();
    void unusedContent;
    const result = parseStorePaymentConfigurationResolve({
      ...original,
      profile: "StorePaymentConfigurationResolveV1",
      expectedConfigurationReference: id(6),
      expectedRevision: 2147483647,
      intentDigest: receipt().intentDigest,
    });
    expect(result.expectedRevision).toBe(2147483647);
    expect(Object.hasOwn(result, "content")).toBe(false);
    invalid(() => parseStorePaymentConfigurationResolve({ ...result, content: content() }));
  });
  it("Abandoned permits no result snapshot and Committed always requires an exact result", () => {
    expect(
      parseStorePaymentConfigurationReceipt({ ...receipt(), outcome: "Abandoned", snapshot: null })
        .outcome,
    ).toBe("Abandoned");
    invalid(() => parseStorePaymentConfigurationReceipt({ ...receipt(), outcome: "Abandoned" }));
    invalid(() => parseStorePaymentConfigurationReceipt({ ...receipt(), snapshot: null }));
  });
  it.each([
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: 2147483648 },
    { expectedRevision: 2147483647, expectedConfigurationReference: id(6) },
    { expectedRevision: 0, expectedConfigurationReference: id(6) },
    { expectedRevision: 1, expectedConfigurationReference: null },
    { purposeCode: "STORE_SETUP_DRAFT" },
    { operationReference: "opaque-free-text" },
  ])("rejects malformed or exhausted new-save identity %j", (patch) =>
    invalid(() => parseStorePaymentConfigurationSave({ ...save(), ...patch })),
  );
  it.each([
    { revision: 0 },
    { revision: 2 },
    { previousConfigurationReference: id(6) },
    { createdAt: "2026-10-05T09:59:00.000Z" },
    { updatedAt: "2026-10-05T09:59:00.000Z" },
    { currencyCode: "USD" },
    { dataClassification: "Public" },
    { profile: "StorePaymentConfigurationV2" },
  ])("rejects inconsistent version metadata %j", (patch) =>
    invalid(() => parseStorePaymentConfigurationVersion({ ...version(), ...patch })),
  );
  it.each([
    { tenantReference: id(9) },
    { brandReference: id(9) },
    { storeReference: id(9) },
    { authoredByReference: id(9) },
    { revision: 2, previousConfigurationReference: id(6), configurationReference: id(8) },
    { updatedAt: later, createdAt: later },
  ])("committed receipt must match full immutable result tuple %j", (patch) =>
    invalid(() =>
      parseStorePaymentConfigurationReceipt({ ...receipt(), snapshot: { ...version(), ...patch } }),
    ),
  );
  it("rejects replacing a previously selected reference with content under the same ID", () =>
    invalid(() =>
      parseStorePaymentConfigurationReceipt({
        ...receipt(),
        expectedRevision: 1,
        expectedConfigurationReference: id(6),
        snapshot: { ...version(), revision: 2, previousConfigurationReference: id(6) },
      }),
    ));
  it.each([
    { validUntil: at },
    { validUntil: "2026-10-05T10:00:05.001Z" },
    { observedAt: "2026-10-05T09:59:59.999Z" },
    { snapshot: { ...version(), tenantReference: id(9) } },
    { snapshot: { ...version(), brandReference: id(9) } },
    { snapshot: { ...version(), storeReference: id(9) } },
  ])("refuses invalid current scope or observation lease %j", (patch) =>
    invalid(() => parseStorePaymentConfigurationCurrent({ ...current(), ...patch })),
  );
  it.each([
    "mode",
    "providerAccount",
    "apiKey",
    "cashEnabled",
    "applePayEnabled",
    "splitTenderEnabled",
  ])("does not accept additional payment or credential settings %s", (field) =>
    invalid(() => parseStorePaymentConfigurationContent({ ...content(), [field]: true })),
  );
  it.each([null, "true", 1, {}, []])("channel choices must be booleans %j", (value) =>
    invalid(() =>
      parseStorePaymentConfigurationContent({ ...content(), customerOnlineCardEnabled: value }),
    ),
  );
  it("rejects getters and inherited/hidden/extra fields without reading caller accessors", () => {
    let called = false;
    const value = { ...save() };
    Object.defineProperty(value, "content", {
      enumerable: true,
      get: () => {
        called = true;
        return content();
      },
    });
    invalid(() => parseStorePaymentConfigurationSave(value));
    expect(called).toBe(false);
    const nested = { ...content() };
    Object.defineProperty(nested, "staffTerminalInteracEnabled", {
      enumerable: true,
      get: () => {
        called = true;
        return true;
      },
    });
    invalid(() => parseStorePaymentConfigurationContent(nested));
    expect(called).toBe(false);
    invalid(() => parseStorePaymentConfigurationContent(Object.create(content())));
    const extra = { ...content() };
    Object.defineProperty(extra, "private", { value: "not allowed", enumerable: false });
    invalid(() => parseStorePaymentConfigurationContent(extra));
    invalid(() => parseStorePaymentConfigurationSave({ ...save(), providerReadiness: "Ready" }));
  });
  it("validates UUID7, canonical millisecond UTC instants and lowercase prefixed digests", () => {
    invalid(() =>
      parseStorePaymentConfigurationSave({
        ...save(),
        tenantReference: "550e8400-e29b-41d4-a716-446655440000",
      }),
    );
    invalid(() =>
      parseStorePaymentConfigurationVersion({ ...version(), createdAt: "2026-10-05T10:00:00Z" }),
    );
    invalid(() =>
      parseStorePaymentConfigurationVersion({
        ...version(),
        createdAt: "2026-02-30T10:00:00.000Z",
        updatedAt: "2026-02-30T10:00:00.000Z",
      }),
    );
    for (const intentDigest of [
      "a".repeat(64),
      "sha256:" + "A".repeat(64),
      "sha256:" + "a".repeat(63),
    ])
      invalid(() => parseStorePaymentConfigurationReceipt({ ...receipt(), intentDigest }));
  });
});
