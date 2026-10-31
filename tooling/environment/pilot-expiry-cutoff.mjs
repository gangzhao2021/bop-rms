import { storeDayEndExpiryCutoff } from "../../packages/rms/inventory/src/index.ts";

/** WP-2423 / DEC-INV-EXPIRY-CUTOFF: lots stay usable through the end of their expiry date (Store time). */
export const createInternalExpiryCutoff = (resources) => async (_transaction, input) =>
  storeDayEndExpiryCutoff(input.expiryDate, resources.operating.timeZone);
