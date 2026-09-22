import { createMerchantOrdinaryRefundBusinessDate } from "../../../apps/api/src/merchant-ordinary-refund-business-date.ts";
import { createHash } from "node:crypto";
import { exerciseOrdinaryRefundCapture } from "./ordinary-refund-capture.mjs";
import assert from "node:assert/strict";
import { exerciseCustomerReceiptRead } from "./customer-receipt-read.mjs";

/** Original Entry order/payment and actual issuance/read; issuer/template authorities are explicitly synthetic. */
export async function exerciseEntryDiningReceipt({
  admin,
  operating,
  role,
  run,
  scope,
  order,
  result,
  preparation,
  server,
}) {
  await admin.query(
    "GRANT SELECT ON rms_payment.payment_compensation_action_history,rms_payment.payment_compensation_refund,rms_payment.ordinary_refund_request,rms_payment.ordinary_refund_operation,rms_payment.ordinary_refund_dispatch TO " +
      role,
  );
  const failures = [];
  const runner = {
    run: (work) =>
      run((tx) =>
        work({
          query: async (sql, values) => {
            try {
              return await tx.query(sql, values);
            } catch (error) {
              failures.push({
                table: /(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1] ?? "owner",
                code: /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "unknown",
              });
              throw error;
            }
          },
        }),
      ),
  };
  const fact = result.committed.fact;
  try {
    await admin.query("GRANT SELECT ON rms_pricing.price_quote TO " + role);
    const ordinaryRefundFixture = await exerciseOrdinaryRefundCapture({
      client: admin,
      runner: () => runner,
      scope,
      terminalScope: result.terminalScope,
      record: result.record,
      fact,
      captured: result.captured,
      hash: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
      validateOnly: true,
      storePublication: {
        storeOptions: operating,
        businessDate: createMerchantOrdinaryRefundBusinessDate(operating),
      },
    });
    await exerciseCustomerReceiptRead({
      ordinaryRefundFixture,
      server,
      admin,
      runner,
      role,
      scope,
      preparation: {
        orderReference: order.record.order.orderReference,
        total: fact.amount,
        tip: preparation.selected.tip,
      },
      sessionPayment: { input: order.input },
      paymentScope: result.terminalScope,
      paymentFreshAfter: fact.event.occurredAt,
    });
  } catch (error) {
    assert.fail(
      JSON.stringify({
        failures: failures.slice(-10),
        code: /^[A-Z_]{1,64}$/.test(error.code ?? "") ? error.code : "unknown",
        frames: String(error.stack ?? "")
          .split("\n")
          .slice(1, 6)
          .map((line) => /([a-z0-9-]+\.[cm]?[jt]s:[0-9]+:[0-9]+)/i.exec(line)?.[1] ?? "source"),
      }),
    );
  }
}
