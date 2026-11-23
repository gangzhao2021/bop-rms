/**
 * Batch 54: the real guest table read and HTTP app on a local server, for the customer browser
 * spec. The read composes the v15 order 52 facts (guest-bill-closed-by-staff.ts) through the real
 * bill mapping and composition, and the app's own handler writes the reply: nothing between the
 * read and the page is a hand-written body.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
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
  type GuestBillScenario,
} from "./guest-bill-closed-by-staff.js";

/**
 * Batch 55 review: once staff also closed the table (`tableClosed`), the visit restore answers as
 * the real handler does for a closed session whose bill was written off: the Session is over, no
 * party moved, and the settled-table read finds Payment's write-off of this bill.
 */
export async function startGuestBillHttp(
  allowedOrigin: string,
  scenario: () => GuestBillScenario,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server: Server = createServer(
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
            const writeOff = guestBillWriteOff(scenario());
            if (writeOff === null || facts.tableLabel === null) return null;
            return {
              tableLabel: facts.tableLabel,
              closedByStaff: closedBillPaid(writeOff),
              store: {
                brandDisplayName: "Test Merchant 2 - not production",
                storeDisplayName: "Test Merchant 2 Main - not production",
              },
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
