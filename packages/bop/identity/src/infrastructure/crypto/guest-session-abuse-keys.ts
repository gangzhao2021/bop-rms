import { createHmac, createSecretKey } from "node:crypto";
import { isIP } from "node:net";
import type { GuestSessionAbuseKeys } from "../../application/guest-session-request-admission.js";

function canonicalPeer(address: string): string {
  if (typeof address !== "string" || address.length > 64) throw new Error("ABUSE_KEY_UNAVAILABLE");
  const version = isIP(address);
  if (version === 4) return "v4:" + address;
  if (version !== 6 || address.includes("%")) throw new Error("ABUSE_KEY_UNAVAILABLE");
  const canonical = new URL("http://[" + address + "]/").hostname.slice(1, -1);
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words =
    halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
      : left;
  if (words.length !== 8) throw new Error("ABUSE_KEY_UNAVAILABLE");
  const numbers = words.map((word) => Number.parseInt(word, 16));
  if (numbers.slice(0, 5).every((word) => word === 0) && numbers[5] === 65535) {
    const high = numbers[6],
      low = numbers[7];
    if (high === undefined || low === undefined) throw new Error("ABUSE_KEY_UNAVAILABLE");
    return "v4:" + [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return (
    "v6:" +
    numbers
      .slice(0, 4)
      .map((word) => word.toString(16))
      .join(":") +
    "/64"
  );
}

/** Dedicated server-held pepper. Never retain or emit raw address/device values. */
export function createGuestSessionAbuseKeys(pepper: Uint8Array): GuestSessionAbuseKeys {
  if (!(pepper instanceof Uint8Array) || pepper.byteLength !== 32)
    throw new Error("ABUSE_KEY_UNAVAILABLE");
  const copied = Buffer.from(pepper);
  const key = createSecretKey(copied);
  copied.fill(0);
  const digest = (dimension: string, value: string) =>
    createHmac("sha256", key)
      .update("bop-rms:guest-session-abuse:v1:" + dimension + "\0", "utf8")
      .update(value, "utf8")
      .digest();
  return Object.freeze({
    ip: (address: string) => digest("ip", canonicalPeer(address)),
    store: (scope: Parameters<GuestSessionAbuseKeys["store"]>[0]) =>
      digest("store", JSON.stringify([scope.brandReference, scope.storeReference])),
  });
}
