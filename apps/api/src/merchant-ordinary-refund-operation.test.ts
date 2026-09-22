import { expect, it } from "vitest";
import {
  createMerchantOrdinaryRefundOperation,
  createMerchantOrdinaryRefundSend,
} from "./merchant-ordinary-refund-operation.js";

const id = (n: number) => "01909975-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it.each(["tenantReference", "brandReference", "storeReference"] as const)(
  "rejects a Store business-date composition for a different %s",
  (key) => {
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
    const unavailable = async (): Promise<never> => {
      throw new Error("unexpected source lookup");
    };
    for (const compose of [createMerchantOrdinaryRefundOperation, createMerchantOrdinaryRefundSend])
      expect(() =>
        compose({
          scope,
          transactions: { run: unavailable },
          provider: { refundPayment: unavailable },
          authorizeRecovery: unavailable,
          generateObservationIdentity: () => ({
            observationReference: id(5),
            auditReference: id(6),
          }),
          providerAccountReference: id(4),
          environment: "Test",
          authorize: unavailable,
          workforce: { resolveContext: unavailable, resolveRoleMapping: unavailable },
          store: {
            ...scope,
            [key]: id(99),
            timeZone: "America/Toronto",
            configurationType: "STORE_CONFIGURATION",
            purposeCode: "STORE_CONFIGURATION",
            requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
            authorize: unavailable,
          },
        }),
      ).toThrow("ORDINARY_REFUND_COMPOSITION_SCOPE_MISMATCH");
  },
);
