/**
 * A UUIDv7 operation reference (RFC 9562: 48-bit Unix milliseconds, version 7, variant 10, the rest
 * random). A screen keeps one per pending command, so a retry of the same command stays idempotent.
 * The app's one generator (role administration and service control each had their own copy).
 */
export function newOperationReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 15);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 63);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
