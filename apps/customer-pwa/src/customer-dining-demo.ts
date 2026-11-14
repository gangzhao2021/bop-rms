import type { CustomerEntryClient, CustomerEntryEstablishedContext } from "./entry/types.js";
import type { DiningAdmissionUi } from "./dining/DiningAdmissionPanel.js";

/** Synthetic local UI exercise only. Excluded by the production entry; never calls an API. */
export function createLocalDiningAdmissionDemo() {
  const operationReference = "01902308-0000-7000-8000-000000000001";
  const context: CustomerEntryEstablishedContext = Object.freeze({
    brandDisplayName: "Synthetic Kitchen",
    storeDisplayName: "Dining UI Training Store",
    publicStoreReference: "01902308-0000-7000-8000-000000000002",
    publicTableReference: "01902308-0000-7000-8000-000000000003",
    channel: "DineIn",
    operatingState: "Open",
    availableServiceModes: Object.freeze(["DineIn"] as const),
    locale: "en-CA",
    contextExpiresAt: "2026-09-10T23:59:00.000Z",
    csrfToken: "d".repeat(43),
  });
  let started = false;
  // WP-2423 (same-table-ordering): a code join's first two answers can't be confirmed (the silent
  // retry, then the guest's own); a one-tap QR join is confirmed by the silent retry.
  let unconfirmedResumes = 0;
  const entryClient: CustomerEntryClient = Object.freeze({
    hasEntry: true,
    start: async () => ({ kind: "Established" as const, context }),
    retry: async () => ({ kind: "Established" as const, context }),
  });
  const diningAdmission: DiningAdmissionUi = Object.freeze({
    generateOperationReference: () => operationReference,
    journey: Object.freeze({
      async start(value: unknown) {
        started = true;
        unconfirmedResumes =
          (value as { joinCredential?: unknown }).joinCredential === null ? 0 : 1;
        throw new Error("synthetic unknown admission");
      },
      async resume(value: unknown) {
        if (
          !started ||
          (value as { operationReference?: unknown }).operationReference !== operationReference
        )
          throw new Error("synthetic unavailable admission");
        if (unconfirmedResumes > 0) {
          unconfirmedResumes -= 1;
          throw new Error("synthetic unknown admission");
        }
        return Object.freeze({ status: "Bound" as const, operationReference });
      },
    }),
  });
  return Object.freeze({ entryClient, diningAdmission });
}
