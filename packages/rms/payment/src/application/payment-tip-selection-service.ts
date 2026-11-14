import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { createMoney, type Money } from "@rms/pricing";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import {
  parsePaymentTipSelection,
  samePaymentTipSelection,
  PaymentTipSelectionError,
  type PaymentTipSelection,
} from "./payment-tip-selection.js";

type SelectionCommand = Pick<
  PaymentTipSelection,
  | "selectionReference"
  | "paymentOperationReference"
  | "submissionReference"
  | "cartReference"
  | "cartVersion"
  | "quoteReference"
  | "tip"
>;
export interface PaymentTipSelectionPorts {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly clock: { now(): string };
  readonly authorization: {
    /** Resolve current credentials/CSRF and source ownership; Select also requires current pre-confirmation eligibility. */
    authorize(input: {
      readonly action: "AccessPaymentTipSelection" | "SelectPaymentTip";
      readonly command: SelectionCommand;
      readonly observedAt: string;
    }): Promise<{
      readonly brandReference: string;
      readonly storeReference: string;
      readonly guestSessionReference: string;
      readonly sessionVersion: number;
      readonly validUntil: string;
    } | null>;
  };
  readonly repository: {
    load(reference: string): Promise<PaymentTipSelection | null>;
    append(input: {
      readonly record: PaymentTipSelection;
      readonly audit: AppendAuditRecordInput;
    }): Promise<{ readonly status: "Created" | "Existing"; readonly record: PaymentTipSelection }>;
  };
  readonly audit: {
    create(record: PaymentTipSelection): Promise<AppendAuditRecordInput>;
  };
}
const fail = (code: PaymentTipSelectionError["code"] = "PAYMENT_TIP_UNAVAILABLE"): never => {
  throw new PaymentTipSelectionError(code);
};
/** No Provider effects. Current authorization and an exact stored original are required on recovery. */
export function createPaymentTipSelectionService(ports: PaymentTipSelectionPorts) {
  const brand = parsePaymentReference(ports.scope.brandReference);
  const store = parsePaymentReference(ports.scope.storeReference);
  return Object.freeze({
    async select(value: unknown) {
      try {
        const raw = exactPaymentObject(value, [
          "selectionReference",
          "paymentOperationReference",
          "submissionReference",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "tip",
        ]);
        const tip = createMoney(raw.tip as Money);
        if (
          !Number.isSafeInteger(raw.cartVersion) ||
          (raw.cartVersion as number) < 1 ||
          tip.currencyCode !== "CAD" ||
          tip.amountMinor < 0n ||
          tip.amountMinor > 9223372036854775807n
        )
          return fail("PAYMENT_TIP_INVALID");
        const command: SelectionCommand = Object.freeze({
          selectionReference: parsePaymentReference(raw.selectionReference),
          paymentOperationReference: parsePaymentReference(raw.paymentOperationReference),
          submissionReference: parsePaymentReference(raw.submissionReference),
          cartReference: parsePaymentReference(raw.cartReference),
          cartVersion: raw.cartVersion as number,
          quoteReference: parsePaymentReference(raw.quoteReference),
          tip,
        });
        let previous: string | undefined, fingerprint: string | undefined;
        const now = () => {
          const at = parsePaymentInstant(ports.clock.now());
          if (previous !== undefined && at < previous) return fail();
          previous = at;
          return at;
        };
        const authorize = async (action: "AccessPaymentTipSelection" | "SelectPaymentTip") => {
          const value = await ports.authorization.authorize({ action, command, observedAt: now() });
          if (value === null) return fail();
          const auth = exactPaymentObject(value, [
            "brandReference",
            "storeReference",
            "guestSessionReference",
            "sessionVersion",
            "validUntil",
          ]);
          const captured = Object.freeze({
            brandReference: parsePaymentReference(auth.brandReference),
            storeReference: parsePaymentReference(auth.storeReference),
            guestSessionReference: parsePaymentReference(auth.guestSessionReference),
            sessionVersion: auth.sessionVersion,
            validUntil: parsePaymentInstant(auth.validUntil),
          });
          if (
            captured.brandReference !== brand ||
            captured.storeReference !== store ||
            !Number.isSafeInteger(captured.sessionVersion) ||
            (captured.sessionVersion as number) < 1 ||
            now() >= captured.validUntil
          )
            return fail();
          const current = JSON.stringify(captured);
          if (fingerprint !== undefined && fingerprint !== current) return fail();
          fingerprint = current;
          return captured;
        };
        const authorized = await authorize("AccessPaymentTipSelection");
        const expected = (selectedAt: string) =>
          parsePaymentTipSelection({
            ...command,
            brandReference: brand,
            storeReference: store,
            guestSessionReference: authorized.guestSessionReference,
            selectedAt,
          });
        const original = (value: unknown) => {
          const record = parsePaymentTipSelection(value);
          if (
            record.selectedAt > now() ||
            !samePaymentTipSelection(record, expected(record.selectedAt))
          )
            return fail("PAYMENT_TIP_CONFLICT");
          return record;
        };
        const existing = await ports.repository.load(command.selectionReference);
        await authorize("AccessPaymentTipSelection");
        if (existing !== null)
          return Object.freeze({ status: "Existing" as const, record: original(existing) });
        await authorize("SelectPaymentTip");
        const record = expected(now());
        const audit = validateAuditRecord(await ports.audit.create(record), Date.parse(now()));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "PAYMENT_TIP_SELECT" ||
          audit.targetType !== "PaymentTipSelection" ||
          audit.targetId !== record.selectionReference ||
          audit.reasonCode !== "AUTHORIZED_PAYMENT_TIP_SELECT" ||
          audit.occurredAt !== record.selectedAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return fail();
        await authorize("SelectPaymentTip");
        let saved: unknown;
        try {
          saved = await ports.repository.append({ record, audit });
        } catch {
          await authorize("AccessPaymentTipSelection");
          const recovered = await ports.repository.load(command.selectionReference);
          await authorize("AccessPaymentTipSelection");
          if (recovered === null) return fail();
          return Object.freeze({ status: "Existing" as const, record: original(recovered) });
        }
        const result = exactPaymentObject(saved, ["status", "record"]);
        if (result.status !== "Created" && result.status !== "Existing") return fail();
        await authorize("AccessPaymentTipSelection");
        const stored = original(result.record);
        if (result.status === "Created" && !samePaymentTipSelection(stored, record)) return fail();
        return Object.freeze({ status: result.status, record: stored });
      } catch (error) {
        if (error instanceof PaymentTipSelectionError) throw error;
        return fail();
      }
    },
  });
}
