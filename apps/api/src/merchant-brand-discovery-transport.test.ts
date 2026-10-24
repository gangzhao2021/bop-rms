import { expect, it } from "vitest";
import {
  parseMerchantBrandDiscoverySessionPacket,
  parseMerchantBrandDiscoveryPagePacket,
  parseMerchantBrandDiscoverySelectionPacket,
} from "./merchant-brand-discovery-transport.js";
const id = (n: number) => `01902421-1013-7000-8000-${n.toString(16).padStart(12, "0")}`,
  actor = id(1),
  brand = id(2),
  at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
const item = {
    brandReference: brand,
    code: "REAL-BRAND",
    displayName: "Synthetic Brand",
    lifecycle: "Draft",
    defaultLocale: "en-CA",
    version: 1,
  },
  packet = () => ({
    profile: "MerchantBrandDiscoveryV1",
    actorReference: actor,
    afterBrandReference: null,
    items: [item],
    hasMore: false,
    nextAfterBrandReference: null,
    observedAt: at,
    validUntil: until,
  });
it("projects immutable closed current Session without private proof or invented fields", () => {
  const value = parseMerchantBrandDiscoverySessionPacket({
    authenticated: true,
    csrf: "c".repeat(43),
    recentMfaRequired: true,
    actorReference: actor,
    selectedBrandReference: null,
  });
  expect(value.recentMfaRequired).toBe(true);
  expect(Object.isFrozen(value)).toBe(true);
  expect(() => parseMerchantBrandDiscoverySessionPacket({ ...value, recentMfa: {} })).toThrow();
});
it("supports all real Brand lifecycles and cursor-only scanned pages", () => {
  for (const lifecycle of ["Draft", "Active", "Suspended", "Archived"])
    expect(
      parseMerchantBrandDiscoveryPagePacket(
        { ...packet(), items: [{ ...item, lifecycle }] },
        actor,
        null,
        at,
        at,
      ).items[0]?.lifecycle,
    ).toBe(lifecycle);
  const empty = parseMerchantBrandDiscoveryPagePacket(
    { ...packet(), items: [], hasMore: true, nextAfterBrandReference: id(3) },
    actor,
    null,
    at,
    at,
  );
  expect(empty.items).toEqual([]);
  expect(empty.hasMore).toBe(true);
  expect(Object.isFrozen(empty.items)).toBe(true);
});
it("binds Actor, requested cursor, sorted dense rows and original finite window", () => {
  for (const value of [
    { ...packet(), actorReference: id(9) },
    { ...packet(), afterBrandReference: id(7) },
    { ...packet(), items: [item, item] },
    { ...packet(), items: new Array(1) },
    { ...packet(), validUntil: "2026-10-06T12:00:05.001Z" },
    { ...packet(), observedAt: "2026-10-06T11:59:59.999Z" },
    { ...packet(), items: [{ ...item, supportedLocales: ["en-CA"] }] },
  ])
    expect(() => parseMerchantBrandDiscoveryPagePacket(value, actor, null, at, at)).toThrow();
  expect(() => parseMerchantBrandDiscoveryPagePacket(packet(), actor, null, at, until)).toThrow();
  expect(() =>
    parseMerchantBrandDiscoveryPagePacket(
      {
        ...packet(),
        afterBrandReference: brand,
        items: [],
        hasMore: true,
        nextAfterBrandReference: brand,
      },
      actor,
      brand,
      at,
      at,
    ),
  ).toThrow();
});
it("refuses accessor rows without invoking untrusted getters", () => {
  let invoked = false;
  const rows = [item];
  Object.defineProperty(rows, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return item;
    },
  });
  expect(() =>
    parseMerchantBrandDiscoveryPagePacket({ ...packet(), items: rows }, actor, null, at, at),
  ).toThrow();
  expect(invoked).toBe(false);
});
it("confirms only exact selected Actor Brand and canonical detail href", () => {
  const selected = {
    actorReference: actor,
    brandReference: brand,
    href: `/app/organization/brands/${brand}`,
  };
  expect(parseMerchantBrandDiscoverySelectionPacket(selected, actor, brand)).toEqual(selected);
  for (const value of [
    { ...selected, actorReference: id(9) },
    { ...selected, brandReference: id(9) },
    { ...selected, href: "https://foreign.invalid/" },
    { ...selected, workspace: {} },
  ])
    expect(() => parseMerchantBrandDiscoverySelectionPacket(value, actor, brand)).toThrow();
});

it("does not shorten an honest source lease to an earlier HTTP preflight observation", () => {
  const value = parseMerchantBrandDiscoveryPagePacket(
    { ...packet(), observedAt: "2026-10-06T12:00:00.100Z", validUntil: "2026-10-06T12:00:05.100Z" },
    actor,
    null,
    at,
    "2026-10-06T12:00:00.200Z",
  );
  expect(value.validUntil).toBe("2026-10-06T12:00:05.100Z");
});
