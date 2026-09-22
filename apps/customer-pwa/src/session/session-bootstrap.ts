import type { MenuJourneyContext } from "../menu/types.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
  setCheckoutSessionReference,
} from "./customer-transaction-context.js";
function menuContext(value: unknown): MenuJourneyContext | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    "publicStoreReference",
    "channel",
    "locale",
    "brandDisplayName",
    "storeDisplayName",
  ];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => typeof raw[key] !== "string"))
    return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      String(raw.publicStoreReference),
    ) ||
    !["DineIn", "Pickup"].includes(String(raw.channel)) ||
    !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u.test(String(raw.locale)) ||
    [raw.brandDisplayName, raw.storeDisplayName].some(
      (name) => typeof name !== "string" || !name.trim() || name.length > 200,
    )
  )
    return null;
  return Object.freeze(raw) as unknown as MenuJourneyContext;
}
/** Restore foreground CSRF and current public menu context in memory only. */
export async function restoreCustomerSession(
  fetcher: typeof fetch = fetch,
  onMenuContext?: (context: MenuJourneyContext) => void,
): Promise<boolean> {
  if (getCustomerCsrfCredential() !== null) return true;
  const current = captureCustomerCsrfContext();
  try {
    const response = await fetcher("/api/v1/customer/session/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { "x-bop-session-bootstrap": "1" },
      signal: AbortSignal.timeout(5000),
    });
    if (
      !current() ||
      !response.ok ||
      response.redirected ||
      !response.headers
        .get("cache-control")
        ?.split(",")
        .some((v) => v.trim().toLowerCase() === "no-store") ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
      !response.body
    )
      return false;
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (!current()) return false;
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) return false;
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !current() ||
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !==
        2 + ("menuContext" in value ? 1 : 0) + ("checkoutSessionReference" in value ? 1 : 0) ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("csrfToken" in value) ||
      typeof value.csrfToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken)
    )
      return false;
    const context = "menuContext" in value ? menuContext(value.menuContext) : undefined;
    if (context === null) return false;
    const checkout =
      "checkoutSessionReference" in value ? value.checkoutSessionReference : undefined;
    if (
      checkout !== undefined &&
      (typeof checkout !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(checkout))
    )
      return false;
    setCustomerCsrfCredential(value.csrfToken);
    if (typeof checkout === "string") setCheckoutSessionReference(checkout);
    if (context) onMenuContext?.(context);
    return true;
  } catch {
    return false;
  }
}
