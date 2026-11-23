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
import {
  composeCustomerDiningSession,
  customerTableBillFacts,
} from "../src/customer-dining-session-read.js";
import {
  guestBillClosedByStaffFacts,
  type GuestBillScenario,
} from "./guest-bill-closed-by-staff.js";

export async function startGuestBillHttp(
  allowedOrigin: string,
  scenario: () => GuestBillScenario,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server: Server = createServer(
    createApp({
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
