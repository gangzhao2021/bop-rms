import { expect, it, vi } from "vitest";
import { createOrdinaryRefundRoleResolver } from "@rms/payment";
import { refundReadAccess } from "./merchant-refund-read-authority.js";

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const base = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  observedAt: "2026-11-06T12:00:00.000Z",
};
const role = createOrdinaryRefundRoleResolver({
  Manager: ["manager"],
  Owner: ["owner"],
  Finance: ["finance"],
});
const workforce = (roles: string[]) =>
  vi.fn(async () => ({ decision: { effect: "Allow" }, activeRoleCodes: roles })) as never;

// WP-2423 M13 (DEC-OWNER-DEFAULTS-2026-11-06 item 1): two people stay the default, and the page
// is told why an Owner may not record, so it names the way forward.
it("names sole operator off for an owner, nothing for a manager or finance", async () => {
  const off = async () => false;
  const on = async () => true;
  expect(
    await refundReadAccess(workforce(["owner"]), {} as never, base, role, () => true, off),
  ).toEqual({
    canRead: true,
    canRequest: false,
    requestBlocked: "SoleOperatorOff",
    canSend: false,
  });
  expect(
    await refundReadAccess(workforce(["owner"]), {} as never, base, role, () => true, on),
  ).toEqual({ canRead: true, canRequest: true, requestBlocked: null, canSend: true });
  expect(
    await refundReadAccess(workforce(["manager"]), {} as never, base, role, () => true),
  ).toEqual({ canRead: true, canRequest: true, requestBlocked: null, canSend: true });
  expect(
    await refundReadAccess(workforce(["finance"]), {} as never, base, role, () => true),
  ).toEqual({ canRead: true, canRequest: false, requestBlocked: null, canSend: false });
});

// WP-2423 M14 (DEC-OWNER-DEFAULTS-2026-11-06 item 2): a cashier records a refund request; a
// manager or the owner sends it.
it("lets a cashier (Staff) request, never send", async () => {
  const withStaff = createOrdinaryRefundRoleResolver({
    Manager: ["manager"],
    Owner: ["owner"],
    Finance: ["finance"],
    Staff: ["front_of_house"],
  });
  expect(
    await refundReadAccess(workforce(["front_of_house"]), {} as never, base, withStaff, () => true),
  ).toEqual({ canRead: true, canRequest: true, requestBlocked: null, canSend: false });
  // Before the mapping names Staff, a cashier reads nothing.
  expect(
    (await refundReadAccess(workforce(["front_of_house"]), {} as never, base, role, () => true))
      .canRead,
  ).toBe(false);
});
