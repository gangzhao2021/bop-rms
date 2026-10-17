import type { GuestSession } from "@bop/identity";
import type { DigitalReceiptChain } from "../../domain/digital-receipt.js";

export interface DigitalReceiptQueryPorts {
  readonly authorization: {
    authorizeGuest(input: {
      readonly orderReference: string;
      readonly observedAt: string;
    }): Promise<{
      readonly guestSession: GuestSession;
      /**
       * WP-2423 (v15 3cd0f8dd M5): the visit has ended (table closed or idle) and the device is
       * reading its own receipt within the Session's absolute lifetime; read only.
       */
      readonly endedVisit?: true;
    } | null>;
    authorizeResume(input: {
      readonly orderReference: string;
      readonly observedAt: string;
      readonly resumeGrantReference: string;
    }): Promise<{
      readonly orderReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly consumedAt: string;
    } | null>;
  };
  readonly receipts: {
    load(orderReference: string): Promise<DigitalReceiptChain | null>;
  };
}
