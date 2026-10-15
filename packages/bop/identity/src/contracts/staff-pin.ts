/**
 * WP-2423 Q18 (DEC-STAFF-SESSION-CONTINUITY section 5, Owner 2026-10-14 option A): rules of the
 * device-bound six-digit staff PIN. A PIN only works on a registered, unrevoked tablet of the same
 * Store and only issues an ordinary WorkforceStandard session marked as PIN-issued; sensitive
 * actions still need a full sign-in or a recent MFA step-up in that session.
 */
export const staffPinPolicy = Object.freeze({
  digits: 6,
  /** Consecutive wrong PINs (each within the lock window of the previous) that lock the PIN. */
  failureLimit: 5,
  lockMinutes: 15,
  /** Rejected checks on one tablet within the window that pause the tablet. */
  deviceFailureLimit: 10,
  deviceWindowMinutes: 15,
  /** A verified check must turn into a session within this time, once. */
  sessionIssueSeconds: 120,
  /** A step-up in a PIN session allows sensitive actions for this long (Q5 recency). */
  elevationMinutes: 15,
});

export type StaffPinProblem = "Format" | "Mismatch" | "TooSimple";

const SIX_DIGITS = /^[0-9]{6}$/u;

/** True for a PIN anyone would try first: one digit repeated, a run up or down (123456,
 * 987654, 012345), or a repeated pair or triple (121212, 123123). */
export function isTrivialStaffPin(pin: string): boolean {
  if (!SIX_DIGITS.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((digit, index) => digit - (digits[index] ?? 0));
  if (steps.every((step) => step === 0)) return true;
  if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) return true;
  if (pin === pin.slice(0, 2).repeat(3) || pin === pin.slice(0, 3).repeat(2)) return true;
  return false;
}

/** The problem with a new PIN and its confirmation, or null when it may be set. */
export function assessNewStaffPin(pin: unknown, confirmation: unknown): StaffPinProblem | null {
  if (typeof pin !== "string" || !SIX_DIGITS.test(pin)) return "Format";
  if (typeof confirmation !== "string" || confirmation !== pin) return "Mismatch";
  if (isTrivialStaffPin(pin)) return "TooSimple";
  return null;
}

/** A submitted PIN is either six digits or an ordinary (counted) mismatch; never echoed. */
export function readSubmittedStaffPin(value: unknown): string | null {
  return typeof value === "string" && SIX_DIGITS.test(value) ? value : null;
}

/** Tablet name a manager gives a registered tablet ("Front counter"). */
export function parseStoreDeviceLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (label.length < 1 || [...label].length > 40 || /[\p{Cc}\p{Cf}]/u.test(label)) return null;
  return label;
}

export type StaffPinState = "NotSet" | "Set" | "Reset";
