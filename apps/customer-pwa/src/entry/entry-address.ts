/**
 * The entry codes a guest's address can carry, in one place: the boot that reads them
 * (main.tsx, internal-entry.ts), the same-tab reload (entry-code-change.ts) and the "which Store
 * does this code name" comparison (start-client.ts) all use these, so they cannot drift apart.
 */
const uuidV7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** A public Store reference (UUIDv7). */
export const publicStoreReferencePattern = new RegExp(`^${uuidV7}$`, "u");
/** A table's (or a Store's) signed QR code: `#qr=<code>`; the code itself is checked by its reader. */
export const qrCodePrefix = "#qr=";
/** A Store's own pickup link or poster: `#pickup=<public Store reference>`. */
export const pickupLinkPattern = new RegExp(`^#pickup=(${uuidV7})$`, "u");
/** The InternalTest table launcher: `#internal-dining=<table>`. */
export const tableLauncherPattern = /^#internal-dining=([a-z][a-z0-9-]{0,39})$/u;

/** A pickup link or the table launcher, whose code the boot asks the server for. */
export function isEntryLinkAddress(hash: string): boolean {
  return /^#(?:pickup|internal-dining)=/u.test(hash);
}

/** Any entry code in the address: a scanned QR code, a pickup link or the table launcher. */
export function isEntryCodeAddress(hash: string): boolean {
  return hash.startsWith(qrCodePrefix) || isEntryLinkAddress(hash);
}
