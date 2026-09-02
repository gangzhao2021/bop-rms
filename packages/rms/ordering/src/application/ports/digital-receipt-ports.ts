import type { GuestSession } from "@bop/identity";
import type { DigitalReceiptChain } from "../../domain/digital-receipt.js";

export interface DigitalReceiptQueryPorts {
  readonly authorization: {
    authorizeGuest(input: {
      readonly orderReference: string;
      readonly observedAt: string;
    }): Promise<{ readonly guestSession: GuestSession } | null>;
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
