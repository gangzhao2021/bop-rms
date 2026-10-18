import { readClosedRecord, parseRawBrowserCredential } from "@bop/identity";
import { parseBrandReference, parseCanonicalInstant, parseOrganizationVersion } from "@bop/tenant";
import {
  MerchantBrandDiscoveryError,
  type MerchantBrandDiscoveryPage,
  type MerchantBrandSelectionReceipt,
} from "./merchant-brand-discovery.js";
const invalid = (): never => {
  throw new MerchantBrandDiscoveryError("Unavailable");
};
const safe = <T>(work: () => T): T => {
  try {
    return work();
  } catch {
    return invalid();
  }
};
const reference = (v: unknown) => String(parseBrandReference(v));
const optional = (v: unknown) => (v === null ? null : reference(v));
const text = (v: unknown, max: number, pattern?: RegExp): string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  v.trim() === v &&
  !/[\p{Cc}\p{Cf}]/u.test(v) &&
  (!pattern || pattern.test(v))
    ? v
    : invalid();
const dense = (v: unknown, max: number): readonly unknown[] => {
  if (
    !Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Array.prototype ||
    v.length > max ||
    Reflect.ownKeys(v).length !== v.length + 1
  )
    return invalid();
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d?.enumerable || !("value" in d)) return invalid();
  }
  return v;
};
export interface MerchantBrandDiscoverySessionPacket {
  readonly authenticated: true;
  readonly csrf: string;
  readonly recentMfaRequired: boolean;
  readonly actorReference: string;
  readonly selectedBrandReference: string | null;
}
export function parseMerchantBrandDiscoverySessionPacket(
  value: unknown,
): MerchantBrandDiscoverySessionPacket {
  return safe(() => {
    const r = readClosedRecord(value, [
      "authenticated",
      "csrf",
      "recentMfaRequired",
      "actorReference",
      "selectedBrandReference",
    ]);
    if (r.authenticated !== true || typeof r.recentMfaRequired !== "boolean") return invalid();
    return Object.freeze({
      authenticated: true,
      csrf: String(parseRawBrowserCredential(r.csrf)),
      recentMfaRequired: r.recentMfaRequired,
      actorReference: reference(r.actorReference),
      selectedBrandReference: optional(r.selectedBrandReference),
    });
  });
}
export function assertMerchantBrandDiscoveryWindow(
  originalObservedAt: unknown,
  currentAt: unknown,
) {
  return safe(() => {
    const origin = parseCanonicalInstant(originalObservedAt),
      at = parseCanonicalInstant(currentAt);
    if (at < origin || Date.parse(at) >= Date.parse(origin) + 5000) return invalid();
    return Object.freeze({ origin, at });
  });
}
export function parseMerchantBrandDiscoveryPagePacket(
  value: unknown,
  expectedActor: unknown,
  expectedAfter: unknown,
  originalObservedAt: unknown,
  currentAt: unknown,
): MerchantBrandDiscoveryPage {
  return safe(() => {
    const actor = reference(expectedActor),
      after = optional(expectedAfter),
      r = readClosedRecord(value, [
        "profile",
        "actorReference",
        "afterBrandReference",
        "items",
        "hasMore",
        "nextAfterBrandReference",
        "observedAt",
        "validUntil",
      ]),
      { origin, at } = assertMerchantBrandDiscoveryWindow(originalObservedAt, currentAt);
    if (
      r.profile !== "MerchantBrandDiscoveryV1" ||
      r.actorReference !== actor ||
      r.afterBrandReference !== after ||
      typeof r.hasMore !== "boolean"
    )
      return invalid();
    const items = dense(r.items, 20).map((value) => {
      const i = readClosedRecord(value, [
        "brandReference",
        "code",
        "displayName",
        "lifecycle",
        "defaultLocale",
        "version",
      ]);
      if (
        i.lifecycle !== "Draft" &&
        i.lifecycle !== "Active" &&
        i.lifecycle !== "Suspended" &&
        i.lifecycle !== "Archived"
      )
        return invalid();
      return Object.freeze({
        brandReference: reference(i.brandReference),
        code: text(i.code, 63, /^[A-Z][A-Z0-9_-]{0,62}$/u),
        displayName: text(i.displayName, 160),
        lifecycle: i.lifecycle,
        defaultLocale: text(
          i.defaultLocale,
          35,
          /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|[0-9]{3})$/u,
        ),
        version: Number(parseOrganizationVersion(i.version)),
      });
    });
    let previous = after;
    for (const item of items) {
      if (previous !== null && item.brandReference <= previous) return invalid();
      previous = item.brandReference;
    }
    const next = optional(r.nextAfterBrandReference);
    if (
      r.hasMore
        ? next === null ||
          (after !== null && next <= after) ||
          (previous !== null && next < previous)
        : next !== null
    )
      return invalid();
    const observedAt = parseCanonicalInstant(r.observedAt),
      validUntil = parseCanonicalInstant(r.validUntil);
    if (
      observedAt < origin ||
      observedAt > at ||
      validUntil <= observedAt ||
      at >= validUntil ||
      Date.parse(validUntil) > Date.parse(observedAt) + 5000
    )
      return invalid();
    return Object.freeze({
      profile: "MerchantBrandDiscoveryV1",
      actorReference: actor,
      afterBrandReference: after,
      items: Object.freeze(items),
      hasMore: r.hasMore,
      nextAfterBrandReference: next,
      observedAt: String(observedAt),
      validUntil: String(validUntil),
    });
  });
}
export function parseMerchantBrandDiscoverySelectionPacket(
  value: unknown,
  expectedActor: unknown,
  expectedBrand: unknown,
): MerchantBrandSelectionReceipt {
  return safe(() => {
    const actor = reference(expectedActor),
      brand = reference(expectedBrand),
      r = readClosedRecord(value, ["actorReference", "brandReference", "href"]);
    if (
      r.actorReference !== actor ||
      r.brandReference !== brand ||
      r.href !== `/app/organization/brands/${brand}`
    )
      return invalid();
    return Object.freeze({ actorReference: actor, brandReference: brand, href: String(r.href) });
  });
}
