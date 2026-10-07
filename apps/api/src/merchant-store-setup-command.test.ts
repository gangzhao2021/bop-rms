import { expect, it } from "vitest";
import {
  createUnconfiguredStoreSetupDraftContent,
  createUnconfiguredStoreSetupDraftContentV2,
} from "@rms/store";
import { bindMerchantStoreSetupCommand } from "./merchant-store-setup-command.js";

const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const save = () => ({
  command: "SaveDraft",
  operationReference: id(5),
  expectedSetupReference: null,
  expectedRevision: 0,
  content: createUnconfiguredStoreSetupDraftContent(),
});
const resolve = () => ({
  command: "ResolveOriginal",
  operationReference: id(5),
  expectedSetupReference: null,
  expectedRevision: 0,
  intentDigest: `sha256:${"a".repeat(64)}`,
});
const rejected = (input: unknown) =>
  expect(() => bindMerchantStoreSetupCommand(input, scope)).toThrowError(
    expect.objectContaining({ code: "STORE_SETUP_OPERATION_INPUT_INVALID" }),
  );

it("binds a genuinely unconfigured first draft without allocating identity or facts", () => {
  const result = bindMerchantStoreSetupCommand(save(), scope);
  expect(result.method).toBe("save");
  expect(result.command).toEqual({
    profile: "StoreSetupSaveV1",
    ...scope,
    operationReference: id(5),
    expectedSetupReference: null,
    expectedRevision: 0,
    purposeCode: "STORE_SETUP_DRAFT",
    content: createUnconfiguredStoreSetupDraftContent(),
  });
  expect(Object.isFrozen(result.command)).toBe(true);
});
it("preserves partial configured-none and uses the current manager, not a saved author", () => {
  const content = {
    ...createUnconfiguredStoreSetupDraftContent(),
    capacityConfigurationReference: { state: "Configured", value: null },
    effectiveUntil: { state: "Configured", value: null },
  };
  const result = bindMerchantStoreSetupCommand(
    {
      ...save(),
      expectedSetupReference: id(6),
      expectedRevision: 2,
      content,
    },
    { ...scope, actorReference: id(7) },
  );
  expect(result.command.actorReference).toBe(id(7));
  if (result.method !== "save") throw new Error("expected Save");
  expect(result.command.content).toEqual(content);
  expect(result.command.expectedRevision).toBe(2);
});
it("binds payload-free recovery to the exact original root, revision and digest", () => {
  const result = bindMerchantStoreSetupCommand(
    {
      ...resolve(),
      expectedSetupReference: id(6),
      expectedRevision: 2,
    },
    scope,
  );
  expect(result).toEqual({
    method: "resolve",
    command: {
      profile: "StoreSetupResolveV1",
      ...scope,
      operationReference: id(5),
      expectedSetupReference: id(6),
      expectedRevision: 2,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest: `sha256:${"a".repeat(64)}`,
    },
  });
});
it("detaches the original intent from later browser form edits", () => {
  const body = {
    ...save(),
    content: {
      ...createUnconfiguredStoreSetupDraftContent(),
      timeZone: { state: "Configured", value: "America/Toronto" },
    },
  };
  const result = bindMerchantStoreSetupCommand(body, scope);
  body.content.timeZone.value = "America/Vancouver";
  if (result.method !== "save") throw new Error("expected Save");
  expect(result.command.content.timeZone).toEqual({
    state: "Configured",
    value: "America/Toronto",
  });
});
it.each([
  "actorReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "profile",
  "purposeCode",
  "auditReference",
  "occurredAt",
  "setupDraftReference",
  "defaultLocale",
])("rejects browser injection of %s", (key) => rejected({ ...save(), [key]: id(9) }));
it.each([
  { expectedSetupReference: id(6), expectedRevision: 0 },
  { expectedSetupReference: null, expectedRevision: 1 },
  { expectedSetupReference: "invalid", expectedRevision: 1 },
  { expectedRevision: -1 },
  { expectedRevision: 1.5 },
  { expectedRevision: 2147483648 },
  { operationReference: "018f9f40-0000-4000-8000-000000000005" },
  { command: "Publish" },
])("rejects corrupt original identity %j", (change) => rejected({ ...save(), ...change }));
it("never executes top-level or nested getters", () => {
  let calls = 0;
  const body = save();
  Object.defineProperty(body, "command", {
    enumerable: true,
    get: () => {
      calls++;
      return "SaveDraft";
    },
  });
  rejected(body);
  const content = { ...createUnconfiguredStoreSetupDraftContent() };
  Object.defineProperty(content, "timeZone", {
    enumerable: true,
    get: () => {
      calls++;
      return { state: "Unconfigured" };
    },
  });
  rejected({ ...save(), content });
  expect(calls).toBe(0);
});
it("rejects prototypes, symbols, hidden fields and sparse nested arrays", () => {
  rejected(Object.assign(Object.create({ inherited: true }), save()));
  rejected({ ...save(), [Symbol("extra")]: true });
  const hidden = save();
  Object.defineProperty(hidden, "secret", { value: true });
  rejected(hidden);
  const days = new Array(7);
  rejected({
    ...save(),
    content: {
      ...createUnconfiguredStoreSetupDraftContent(),
      weeklySchedule: { state: "Configured", value: days },
    },
  });
});
it("rejects copied PII instead of accepting it as a configured reference", () => {
  rejected({
    ...save(),
    content: { ...createUnconfiguredStoreSetupDraftContent(), contactName: "Synthetic name" },
  });
  rejected({
    ...save(),
    content: {
      ...createUnconfiguredStoreSetupDraftContent(),
      contactReference: { state: "Configured", value: { name: "Synthetic name" } },
    },
  });
});
it.each([
  { content: createUnconfiguredStoreSetupDraftContent() },
  { intentDigest: "a".repeat(64) },
  { intentDigest: `sha256:${"A".repeat(64)}` },
  { expectedSetupReference: id(6) },
])("rejects malformed recovery or extra payload %j", (change) =>
  rejected({ ...resolve(), ...change }),
);
it("validates every actual scope reference and rejects scope accessors", () => {
  for (const key of Object.keys(scope)) {
    expect(() => bindMerchantStoreSetupCommand(save(), { ...scope, [key]: "invalid" })).toThrow();
  }
  let calls = 0;
  const unsafe = { ...scope };
  Object.defineProperty(unsafe, "actorReference", {
    enumerable: true,
    get: () => {
      calls++;
      return id(4);
    },
  });
  expect(() => bindMerchantStoreSetupCommand(save(), unsafe)).toThrow();
  expect(calls).toBe(0);
});

it("binds explicit fee-context content to V2 without changing V1 or payload-free Resolve", () => {
  const result = bindMerchantStoreSetupCommand(
    { ...save(), content: createUnconfiguredStoreSetupDraftContentV2() },
    scope,
  );
  expect(result.command.profile).toBe("StoreSetupSaveV2");
  expect(bindMerchantStoreSetupCommand(save(), scope).command.profile).toBe("StoreSetupSaveV1");
  expect(bindMerchantStoreSetupCommand(resolve(), scope).command.profile).toBe(
    "StoreSetupResolveV1",
  );
});
it("does not execute a feeContexts getter or silently downgrade malformed V2", () => {
  let calls = 0;
  const content = { ...createUnconfiguredStoreSetupDraftContent() };
  Object.defineProperty(content, "feeContexts", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("must not execute");
    },
  });
  rejected({ ...save(), content });
  expect(calls).toBe(0);
  rejected({
    ...save(),
    content: { ...createUnconfiguredStoreSetupDraftContent(), feeContexts: undefined },
  });
});
