import { expect, it, vi } from "vitest";
import { bindMerchantStorePaymentConfigurationCommand } from "./merchant-store-payment-configuration-command.js";

const id = (n: number) => `01902421-1424-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const content = {
  customerOnlineCardEnabled: true,
  staffTerminalCardPresentEnabled: false,
  staffTerminalInteracEnabled: false,
};
const body = {
  command: "SaveConfiguration",
  operationReference: id(5),
  expectedConfigurationReference: null,
  expectedRevision: 0,
  content,
};

it("binds the ordinary five-field intent to acquired scope without generated or Provider facts", () => {
  const bound = bindMerchantStorePaymentConfigurationCommand(body, scope);
  expect(bound).toEqual({
    method: "save",
    command: {
      profile: "StorePaymentConfigurationSaveV1",
      ...scope,
      operationReference: id(5),
      expectedConfigurationReference: null,
      expectedRevision: 0,
      content,
      purposeCode: "STORE_PAYMENT_CONFIGURATION",
    },
  });
  expect(Object.isFrozen(bound.command)).toBe(true);
  expect("content" in bound.command && Object.isFrozen(bound.command.content)).toBe(true);
  expect(bound.command).not.toHaveProperty("providerReadiness");
});
it("binds original resolution without retaining payment-rule content", () => {
  const raw = {
    command: "ResolveOriginal",
    operationReference: id(5),
    expectedConfigurationReference: null,
    expectedRevision: 0,
    intentDigest: "sha256:" + "a".repeat(64),
  };
  const result = bindMerchantStorePaymentConfigurationCommand(raw, scope);
  expect(result).toEqual({
    method: "resolve",
    command: {
      profile: "StorePaymentConfigurationResolveV1",
      ...scope,
      operationReference: id(5),
      expectedConfigurationReference: null,
      expectedRevision: 0,
      intentDigest: raw.intentDigest,
      purposeCode: "STORE_PAYMENT_CONFIGURATION",
    },
  });
  expect(result.command).not.toHaveProperty("content");
});
it.each([
  "actorReference",
  "tenantReference",
  "currencyCode",
  "configurationReference",
  "providerReadiness",
  "secretKey",
])("rejects browser authority/result field %s", (key) => {
  expect(() =>
    bindMerchantStorePaymentConfigurationCommand({ ...body, [key]: "SYNTHETIC_FORBIDDEN" }, scope),
  ).toThrow();
});
it.each([
  { ...body, content: { ...content, cashEnabled: true } },
  { ...body, content: { ...content, walletEnabled: true } },
  { ...body, content: { ...content, customerOnlineCardEnabled: "true" } },
  { ...body, content: { customerOnlineCardEnabled: true } },
  { ...body, expectedConfigurationReference: id(6) },
  { ...body, expectedRevision: 1 },
  { ...body, command: "Publish" },
])("rejects unsupported methods, open content and inconsistent original pins", (raw) => {
  expect(() => bindMerchantStorePaymentConfigurationCommand(raw, scope)).toThrow();
});
it("does not evaluate a browser discriminator accessor", () => {
  const getter = vi.fn(() => "SaveConfiguration");
  const raw = { ...body };
  Object.defineProperty(raw, "command", { get: getter, enumerable: true });
  expect(() => bindMerchantStorePaymentConfigurationCommand(raw, scope)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("accepts explicitly disabled rules without claiming Provider readiness", () => {
  const result = bindMerchantStorePaymentConfigurationCommand(
    {
      ...body,
      content: {
        customerOnlineCardEnabled: false,
        staffTerminalCardPresentEnabled: false,
        staffTerminalInteracEnabled: false,
      },
    },
    scope,
  );
  expect(result.method).toBe("save");
  expect(result.command).not.toHaveProperty("providerReadiness");
});
