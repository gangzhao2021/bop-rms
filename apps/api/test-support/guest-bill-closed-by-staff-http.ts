/**
 * Batch 54: the real guest table read and HTTP app on a local server, for the customer browser
 * spec. The read composes the v15 order 52 facts (guest-bill-closed-by-staff.ts) through the real
 * bill mapping and composition, and the app's own handler writes the reply: nothing between the
 * read and the page is a hand-written body.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createApp } from "../src/app.js";
import {
  CustomerDiningTablePaymentHandler,
  customerDiningTablePaymentRoute,
} from "../src/customer-dining-table-payment.js";
import { CustomerDiningSessionHandler } from "../src/customer-dining-session.js";
import { GuestSessionError } from "@bop/identity";
import {
  closedBillPaid,
  closedBillSomeRefunded,
  createCustomerSessionBootstrapHandler,
} from "../src/customer-session-bootstrap.js";
import {
  composeCustomerDiningSession,
  customerDishPaidRounds,
  customerRoundPaymentRefunds,
  customerTableBillFacts,
} from "../src/customer-dining-session-read.js";
import {
  guestBillClosedByStaffFacts,
  guestBillPayments,
  guestPhoneSession,
  guestBillWriteOff,
  guestOwnPaymentView,
  guestWholeTablePaidView,
  guestOwnRefunds,
  guestTableRefundedMinor,
  type GuestBillScenario,
  type GuestOwnRefunds,
} from "./guest-bill-closed-by-staff.js";

/**
 * Batch 56 (v15 b55 live): which phone is asking — the one that paid part of the bill (`payer`)
 * or another guest's — and whether staff then closed the table. The guest's table visit value is
 * "d"×43; the ended visit's read-only value, which the restore gives the payer only, is "C"×43.
 */
export interface GuestBillPhone {
  readonly payer: boolean;
  readonly tableClosed: boolean;
  /** Batch 57 (Q36): what staff refunded of the payer's own payment (absent: nothing). */
  readonly refunds?: GuestOwnRefunds;
  /** Batch 63: see `guestOwnPaymentView`'s options; `merchant`: the settled receipt's header. */
  readonly partOneTipMinor?: string;
  readonly markEven?: boolean;
  readonly bothMine?: boolean;
  readonly merchant?: boolean;
}
/** Batch 63 (F05): the Store's published names and address, TEST-ONLY values. */
const testMerchant = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
  address: {
    addressLines: ["100 Example Street (TEST)"],
    locality: "Exampleville",
    regionCode: "ON",
    postalCode: "A1A 1A1",
    countryCode: "CA",
  },
};
const viewOptions = (current: GuestBillPhone) => ({
  ...(current.partOneTipMinor === undefined ? {} : { partOneTipMinor: current.partOneTipMinor }),
  ...(current.markEven === undefined ? {} : { markEven: current.markEven }),
  ...(current.bothMine === undefined ? {} : { bothMine: current.bothMine }),
});
const visitCsrf = "d".repeat(43);
const ownRefunded = (kind: GuestOwnRefunds) => {
  const minor = guestOwnRefunds(kind)
    .filter((refund) => refund.status !== "Failed")
    .reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n);
  // Batch 60: of it, what is still on its way (the Provider has not answered yet).
  const pending = guestOwnRefunds(kind)
    .filter((refund) => refund.status === "Pending")
    .reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n);
  return minor === 0n
    ? {}
    : {
        refundedMinor: minor.toString(),
        ...(pending === 0n ? {} : { refundPendingMinor: pending.toString() }),
      };
};
const endedCsrf = "C".repeat(43);

/**
 * Batch 55 review: once staff also closed the table (`tableClosed`), the visit restore answers as
 * the real handler does for a closed session whose bill was written off: the Session is over, no
 * party moved, and the settled-table read finds Payment's write-off of this bill.
 */
export async function startGuestBillHttp(
  allowedOrigin: string,
  scenario: () => GuestBillScenario,
  phone: () => GuestBillPhone = () => ({ payer: false, tableClosed: true }),
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const paidPart = () => {
    const current = scenario();
    return current === "by-dish-written-off" ||
      current === "half-split-written-off" ||
      current === "half-split-open" ||
      current === "by-dish-both-paid"
      ? current
      : null;
  };
  const wholeTablePaid = () => scenario() === "whole-table-paid-online";
  // Batch 61 (v15 b60 live, CRT60 B/C): by dish, both phones paid their own dish; once staff
  // closed the table its settled receipt is read, each phone with its own payment only.
  const byDishPaid = () => scenario() === "by-dish-both-paid";
  const paidInFull = () => wholeTablePaid() || byDishPaid();
  // Batch 56: the guest's table-payment reads (the bill, and this phone's own payment), as the
  // real port answers them: the payer's own captured payment only, and "not found" for any other
  // phone; once the table closed, only with the ended visit's value.
  const tablePayment = new CustomerDiningTablePaymentHandler({
    allowedOrigin,
    port: {
      read: async () => {
        const part = paidPart();
        if (phone().tableClosed) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        // Batch 57: a table one phone paid in full, still open: the whole-table receipt. Batch 62:
        // with what staff gave back of that payment.
        if (wholeTablePaid())
          return guestWholeTablePaidView("Closing", phone().refunds ?? "None", phone().payer);
        if (part === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        // Batch 61: with what staff gave back of the table's payments (the bill's refundedMinor).
        return guestOwnPaymentView(
          part,
          phone().payer,
          "Closing",
          phone().refunds ?? "None",
          viewOptions(phone()),
        );
      },
      // Batch 57: once staff closed a table paid in full, its settled receipt (ended visit only).
      settledReceipt: async (credentials: { csrfCredential: string }) => {
        if (
          !paidInFull() ||
          !phone().tableClosed ||
          String(credentials.csrfCredential) !== endedCsrf
        )
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        const view = byDishPaid()
          ? guestOwnPaymentView(
              scenario() as "by-dish-both-paid",
              phone().payer,
              "Closed",
              phone().refunds ?? "None",
              viewOptions(phone()),
            )
          : guestWholeTablePaidView("Closed", phone().refunds ?? "None", phone().payer);
        return phone().merchant === true ? { ...view, merchant: testMerchant } : view;
      },
      ownPayment: async (credentials: { csrfCredential: string }) => {
        const part = paidPart();
        const { payer, tableClosed } = phone();
        // Batch 61: by dish paid in full, phone B paid its own dish too (its own payment only).
        // Batch 62: the phone that paid the whole table has that payment as its own.
        if (
          (part === null && !wholeTablePaid()) ||
          (!payer && !byDishPaid()) ||
          String(credentials.csrfCredential) !== (tableClosed ? endedCsrf : visitCsrf)
        )
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        if (part === null)
          return guestWholeTablePaidView(
            tableClosed ? "Closed" : "Closing",
            phone().refunds ?? "None",
            payer,
          );
        return guestOwnPaymentView(
          part,
          payer,
          tableClosed ? "Closed" : "Closing",
          phone().refunds ?? "None",
          viewOptions(phone()),
        );
      },
    } as never,
  });
  const outer = express();
  outer.post(customerDiningTablePaymentRoute, ...tablePayment.handler());
  outer.use(
    createApp({
      customerSessionBootstrap: createCustomerSessionBootstrapHandler({
        allowedOrigin,
        port: {
          read: async () => {
            throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
          },
          readMovedTable: async () => null,
          readSettledTable: async () => {
            const { facts } = guestBillClosedByStaffFacts(scenario());
            // Batch 57: a table paid in full: its label and read-only receipt access.
            if (paidInFull() && facts.tableLabel !== null)
              return {
                tableLabel: facts.tableLabel,
                csrfToken: endedCsrf,
                store: {
                  brandDisplayName: "Test Merchant 2 - not production",
                  storeDisplayName: "Test Merchant 2 Main - not production",
                },
              };
            const writeOff = guestBillWriteOff(scenario());
            if (writeOff === null || facts.tableLabel === null) return null;
            return {
              tableLabel: facts.tableLabel,
              // Batch 59: with what staff gave back of the table's payments (every phone).
              // Batch 59 review: what the table's payments took (these scenarios pay no tip, so
              // their settlement totals are the captured order money).
              ...((refundedMinor) => {
                const paid = closedBillPaid(writeOff, {
                  paidMinor: writeOff.capturedOrderAllocationMinor,
                  refundedMinor,
                });
                // Batch 61: with part of what stays paid given back, as the real restore says it.
                return {
                  closedByStaff: paid,
                  ...(closedBillSomeRefunded(paid, refundedMinor)
                    ? { someRefunded: true as const }
                    : {}),
                };
              })(paidPart() === null ? 0n : guestTableRefundedMinor(phone().refunds ?? "None")),
              store: {
                brandDisplayName: "Test Merchant 2 - not production",
                storeDisplayName: "Test Merchant 2 Main - not production",
              },
              // Batch 56: the phone that paid part of it (Payment's captured payment, 1413). Batch
              // 57: with what went back to its card, refused refunds left out (as the read sums).
              ...(phone().payer && paidPart() !== null
                ? {
                    yourPayment: {
                      amountMinor: "1413",
                      method: "Online" as const,
                      ...ownRefunded(phone().refunds ?? "None"),
                    },
                    csrfToken: endedCsrf,
                  }
                : {}),
            };
          },
          readEndedVisit: async () => {
            throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
          },
        },
      }),
      customerDiningSession: new CustomerDiningSessionHandler({
        allowedOrigin,
        port: {
          read: async () => {
            // Batch 58: the table's refunds are a table fact: every phone's read carries them.
            // Batch 62: so are those of a payment for the whole table.
            const refunds =
              paidPart() === null && !wholeTablePaid() ? "None" : (phone().refunds ?? "None");
            const { facts, bill } = guestBillClosedByStaffFacts(scenario(), refunds);
            // Batch 60: staff's refunds (all of them of phone A's payment, part 1) tied to the
            // rounds Payment's settlements paid, as the real read does for the asking phone.
            const { plan, settlements } = guestBillPayments(scenario());
            const roundPaymentRefunds = customerRoundPaymentRefunds(
              plan,
              settlements,
              new Map(
                settlements[0] === undefined
                  ? []
                  : [[settlements[0].settlementReference, guestTableRefundedMinor(refunds)]],
              ),
              guestPhoneSession(phone().payer),
            );
            // Batch 61: by dish, the rounds a guest's payment paid some of (the real mapping).
            const dishPaidRounds = customerDishPaidRounds(
              facts.order.splitParts ?? null,
              settlements,
            );
            return composeCustomerDiningSession({
              ...facts,
              order: {
                ...facts.order,
                tableBill: customerTableBillFacts(bill),
                ...(roundPaymentRefunds.size === 0 ? {} : { roundPaymentRefunds }),
                ...(dishPaidRounds.size === 0 ? {} : { dishPaidRounds }),
              },
            });
          },
        },
      }),
    }),
  );
  const server: Server = createServer(outer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
