import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backgroundReadAllowed,
  setStaffSessionEnded,
  staffSessionEnded,
  subscribeStaffSessionEnded,
} from "./staff-session-reads.js";

afterEach(() => setStaffSessionEnded(false));

describe("v15 cbff9d6f: no reads with a sign-in that has ended", () => {
  it("stops background reads while the sign-in has ended and allows them again after", () => {
    expect(backgroundReadAllowed(true)).toBe(true);
    expect(backgroundReadAllowed(false)).toBe(false);
    setStaffSessionEnded(true);
    expect(staffSessionEnded()).toBe(true);
    expect(backgroundReadAllowed(true)).toBe(false);
    setStaffSessionEnded(false);
    expect(backgroundReadAllowed(true)).toBe(true);
  });

  it("tells every subscribed screen once per change, and stops telling unsubscribed ones", () => {
    const first = vi.fn(),
      second = vi.fn();
    const stopFirst = subscribeStaffSessionEnded(first);
    const stopSecond = subscribeStaffSessionEnded(second);
    setStaffSessionEnded(true);
    setStaffSessionEnded(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    setStaffSessionEnded(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
  });

  it("treats a page without a document (server render) as visible", () => {
    expect(backgroundReadAllowed()).toBe(true);
    setStaffSessionEnded(true);
    expect(backgroundReadAllowed()).toBe(false);
  });
});
