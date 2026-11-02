import { isIP } from "node:net";
import type { Request } from "express";

/**
 * WP-2423 (v15 rush 2026-11-02): whose address a request is, for a limit. Behind the HTTPS entry the
 * peer is always loopback, which is every guest of the installation at once, so loopback is never
 * an answer: only the entry's own header counts there (it replaces any copy a guest sends). A peer
 * that isn't loopback reached this server directly, and is the answer. Null: not known.
 */
export const clientAddressHeader = "x-bop-client-address";
export function trustedClientAddress(request: Pick<Request, "socket" | "headers">): string | null {
  const peer = request.socket.remoteAddress ?? "";
  const plain = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  if (plain !== "::1" && !plain.startsWith("127.")) return isIP(plain) === 0 ? null : plain;
  const stated = request.headers[clientAddressHeader];
  return typeof stated === "string" && isIP(stated) !== 0 ? stated : null;
}
