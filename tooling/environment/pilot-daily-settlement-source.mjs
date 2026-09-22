import process from "node:process";
import { createHash } from "node:crypto";
import { createInternalClosedSettlementWindow } from "./pilot-settlement-window.mjs";
import {
  createPostgresPaymentCaptureWindowSource,
  createPostgresOrdinaryRefundWindowSource,
  createPostgresConfirmedCompensationRefundSource,
  parseSettlementReconciliationCandidate,
  parsePaymentInstant,
  parsePaymentReference,
} from "../../packages/rms/payment/src/index.ts";
import { bindOrdinaryRefundProviderOutcome } from "../../packages/rms/payment/src/application/ordinary-refund-provider-result.ts";
const json = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const digest = (value) => createHash("sha256").update(json(value)).digest("hex");
/** Complete local simulator comparison sources. Never a real Provider balance statement. */
export function createInternalDailySettlementSource({
  resources: r,
  simulator,
  providerAccountReference,
  active,
}) {
  const fail = () => {
    throw Error("DAILY_SETTLEMENT_SOURCE_UNAVAILABLE");
  };
  const scope = {
    ...r.scope,
    tenantReference: r.publicProfile.binding.tenantReference,
    providerAccountReference,
    environment: "Test",
  };
  const guard = async () => {
    if (
      process.env.NODE_ENV !== "development" ||
      simulator.simulation !== true ||
      (await active()) !== true
    )
      return fail();
    return true;
  };
  const readWindow = createInternalClosedSettlementWindow({ resources: r, active: guard });
  const capture = createPostgresPaymentCaptureWindowSource({ scope, authorize: guard });
  const ordinary = createPostgresOrdinaryRefundWindowSource({ scope, authorize: guard });
  const compensation = createPostgresConfirmedCompensationRefundSource({ scope, authorize: guard });
  return async (input = undefined) => {
    await guard();
    const window = await readWindow(input),
      observedAt = parsePaymentInstant(r.now());
    const sourceWindow = { startsAt: window.startsAt, endsAt: window.endsAt, observedAt };
    const internal = await r.transactions.run(async (tx) => ({
      captures: await capture(tx, sourceWindow),
      ordinary: await ordinary(tx, sourceWindow),
    }));
    if (internal.ordinary.unresolvedOperationCount !== 0) return fail();
    let afterRefundReference = null,
      compensationMinor = 0n,
      compensationCount = 0;
    const evidence = [],
      seenFacts = new Set(),
      seenProvider = new Set();
    do {
      await guard();
      const page = await r.transactions.run((tx) =>
        compensation(tx, { observedAt, afterRefundReference, limit: 100 }),
      );
      for (const record of page.records) {
        const fact = record.receipt.fact;
        if (seenFacts.has(fact.refundReference) || seenFacts.size >= 100000) return fail();
        seenFacts.add(fact.refundReference);
        await guard();
        const outcome = bindOrdinaryRefundProviderOutcome(
          record.request,
          await simulator.adapter.lookupRefund(record.request),
        );
        await guard();
        if (
          outcome.kind !== "RefundObservation" ||
          outcome.status !== "succeeded" ||
          outcome.amount.amountMinor !== fact.amount.amountMinor ||
          seenProvider.has(outcome.providerRefundReference) ||
          Date.parse(outcome.createdAt) <
            Math.floor(Date.parse(record.action.claimedAt) / 1000) * 1000 ||
          outcome.createdAt > fact.providerConfirmedAt ||
          outcome.observedAt > parsePaymentInstant(r.now())
        )
          return fail();
        seenProvider.add(outcome.providerRefundReference);
        if (outcome.createdAt >= window.startsAt && outcome.createdAt < window.endsAt) {
          compensationCount++;
          compensationMinor += fact.amount.amountMinor;
        }
        evidence.push({
          receipt: record.receipt,
          action: record.action,
          request: record.request,
          observation: outcome,
        });
      }
      if (
        page.nextAfterRefundReference !== null &&
        (page.records.length === 0 ||
          page.nextAfterRefundReference !== page.records.at(-1)?.receipt.fact.refundReference ||
          (afterRefundReference !== null && page.nextAfterRefundReference <= afterRefundReference))
      )
        return fail();
      afterRefundReference = page.nextAfterRefundReference;
    } while (afterRefundReference !== null);
    await guard();
    const provider = await simulator.readSettlementWindow({
      brandReference: r.scope.brandReference,
      storeReference: r.scope.storeReference,
      environment: "Test",
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    });
    const evidenceObservedAt = parsePaymentInstant(r.now());
    if (
      provider.source !== "InternalTestSimulator" ||
      provider.brandReference !== r.scope.brandReference ||
      provider.storeReference !== r.scope.storeReference ||
      provider.startsAt !== window.startsAt ||
      provider.endsAt !== window.endsAt ||
      provider.currencyCode !== "CAD" ||
      provider.observedAt > evidenceObservedAt
    )
      return fail();
    await guard();
    const sources = {
      window,
      internal,
      compensation: {
        refundCount: compensationCount,
        refundedAmountMinor: compensationMinor,
        records: evidence,
      },
      provider,
    };
    const evidenceDigest = "sha256:" + digest(sources);
    const h = digest([
      "INTERNAL_DAILY_SETTLEMENT_V1",
      scope,
      window.businessDate,
      window.startsAt,
      window.endsAt,
    ]);
    const stamp = Date.parse(window.endsAt).toString(16).padStart(12, "0");
    const candidateReference = parsePaymentReference(
      stamp.slice(0, 8) +
        "-" +
        stamp.slice(8) +
        "-7" +
        h.slice(0, 3) +
        "-" +
        (8 + (parseInt(h[3], 16) & 3)).toString(16) +
        h.slice(4, 7) +
        "-" +
        h.slice(7, 19),
    );
    const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
    const candidate = parseSettlementReconciliationCandidate({
      candidateReference,
      brandReference: r.scope.brandReference,
      storeReference: r.scope.storeReference,
      settlementReference:
        "simset_" + window.businessDate.replaceAll("-", "") + "_" + evidenceDigest.slice(7),
      businessDate: window.businessDate,
      internalCapturedAmount: money(internal.captures.capturedAmountMinor),
      providerCapturedAmount: money(provider.capturedAmountMinor),
      internalRefundedAmount: money(internal.ordinary.refundedAmountMinor + compensationMinor),
      providerRefundedAmount: money(provider.refundedAmountMinor),
      evidenceObservedAt,
    });
    return Object.freeze({ candidate, evidenceDigest, sources });
  };
}
