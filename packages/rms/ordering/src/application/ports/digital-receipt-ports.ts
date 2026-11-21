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
      /**
       * WP-2423 (v15 8c4480dd M1): the caller verified from Ordering's order header that this is
       * the dine-in Order of the guest's own dining session; a guest at the table who placed a
       * later round reads the table's receipt.
       */
      readonly tableOrder?: true;
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
