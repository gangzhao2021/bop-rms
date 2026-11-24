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
  createCustomerSessionBootstrapHandler,
} from "../src/customer-session-bootstrap.js";
import {
  composeCustomerDiningSession,
  customerTableBillFacts,
} from "../src/customer-dining-session-read.js";
import {
  guestBillClosedByStaffFacts,
  guestBillWriteOff,
  guestOwnPaymentView,
  guestWholeTablePaidView,
  guestOwnRefunds,
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
}
const visitCsrf = "d".repeat(43);
const ownRefunded = (kind: GuestOwnRefunds) => {
  const minor = guestOwnRefunds(kind)
    .filter((refund) => refund.status !== "Failed")
    .reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n);
  return minor === 0n ? {} : { refundedMinor: minor.toString() };
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
      current === "half-split-open"
      ? current
      : null;
  };
  const wholeTablePaid = () => scenario() === "whole-table-paid-online";
  // Batch 56: the guest's table-payment reads (the bill, and this phone's own payment), as the
  // real port answers them: the payer's own captured payment only, and "not found" for any other
  // phone; once the table closed, only with the ended visit's value.
  const tablePayment = new CustomerDiningTablePaymentHandler({
    allowedOrigin,
    port: {
      read: async () => {
        const part = paidPart();
        if (phone().tableClosed) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        // Batch 57: a table one phone paid in full, still open: the whole-table receipt.
        if (wholeTablePaid()) return guestWholeTablePaidView("Closing");
        if (part === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        return guestOwnPaymentView(part, phone().payer);
      },
      // Batch 57: once staff closed a table paid in full, its settled receipt (ended visit only).
      settledReceipt: async (credentials: { csrfCredential: string }) => {
        if (
          !wholeTablePaid() ||
          !phone().tableClosed ||
          String(credentials.csrfCredential) !== endedCsrf
        )
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        return guestWholeTablePaidView("Closed");
      },
      ownPayment: async (credentials: { csrfCredential: string }) => {
        const part = paidPart();
        const { payer, tableClosed } = phone();
        if (
          part === null ||
          !payer ||
          String(credentials.csrfCredential) !== (tableClosed ? endedCsrf : visitCsrf)
        )
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        return guestOwnPaymentView(
          part,
          true,
          tableClosed ? "Closed" : "Closing",
          phone().refunds ?? "None",
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
            if (wholeTablePaid() && facts.tableLabel !== null)
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
              closedByStaff: closedBillPaid(writeOff),
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
            const { facts, bill } = guestBillClosedByStaffFacts(scenario());
            return composeCustomerDiningSession({
              ...facts,
              order: { ...facts.order, tableBill: customerTableBillFacts(bill) },
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
