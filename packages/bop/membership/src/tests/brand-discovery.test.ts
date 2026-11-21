import { expect, it } from "vitest";
import {
  parseMembershipBrandDiscoveryPage,
  parseMembershipBrandDiscoveryRequest,
  parseBrandDiscoveryInstant,
} from "../contracts/brand-discovery.js";
const id = (n: number) => `01903100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
const page = () => ({
  profile: "MembershipBrandDiscoveryPageV1",
  actorReference: id(1),
  purposeCode: "BRAND_DISCOVERY",
  afterBrandReference: null,
  limit: 2,
  brandReferences: [id(2), id(3)],
  hasMore: true,
  nextAfterBrandReference: id(3),
  observedAt: at,
  validUntil: until,
});
it("parses detached bounded candidate pages without permission or Membership facts", () => {
  const input = page(),
    output = parseMembershipBrandDiscoveryPage(input);
  input.brandReferences[0] = id(9);
  expect(output.brandReferences).toEqual([id(2), id(3)]);
  expect(Object.isFrozen(output.brandReferences)).toBe(true);
  expect(output).not.toHaveProperty("permission");
  expect(output).not.toHaveProperty("memberships");
  expect(
    parseMembershipBrandDiscoveryPage({
      ...page(),
      brandReferences: [],
      hasMore: false,
      nextAfterBrandReference: null,
    }).brandReferences,
  ).toEqual([]);
});
it.each([0, 21, 1.5, "2", NaN])("rejects an unbounded/noninteger page size %s", (limit) => {
  expect(() =>
    parseMembershipBrandDiscoveryRequest({ afterBrandReference: null, limit }),
  ).toThrow();
});
it.each([
  { purposeCode: "BRAND_ADMINISTRATION" },
  { actorReference: id(9), permission: "Allow" },
  { brandReferences: [id(3), id(2)] },
  { brandReferences: [id(2), id(2)] },
  { afterBrandReference: id(2) },
  { nextAfterBrandReference: id(4) },
  { hasMore: false },
  { brandReferences: [id(2)] },
  { validUntil: "2026-10-06T12:00:05.001Z" },
  { validUntil: at },
  { observedAt: "0000-01-01T00:00:00.000Z" },
])("rejects malformed or inconsistent candidate packet %j", (patch) => {
  expect(() => parseMembershipBrandDiscoveryPage({ ...page(), ...patch })).toThrow();
});
it("refuses getters, sparse arrays and extra metadata without executing accessor code", () => {
  let reads = 0;
  const input = page();
  Object.defineProperty(input.brandReferences, "0", {
    enumerable: true,
    get() {
      reads++;
      return id(2);
    },
  });
  expect(() => parseMembershipBrandDiscoveryPage(input)).toThrow();
  expect(reads).toBe(0);
  expect(() =>
    parseMembershipBrandDiscoveryPage({ ...page(), brandReferences: new Array(2) }),
  ).toThrow();
  expect(() =>
    parseMembershipBrandDiscoveryRequest({
      afterBrandReference: null,
      limit: 2,
      actorReference: id(1),
    }),
  ).toThrow();
  expect(parseBrandDiscoveryInstant("9999-12-31T23:59:59.999Z")).toBe("9999-12-31T23:59:59.999Z");
});
