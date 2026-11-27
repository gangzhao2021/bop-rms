import { describe, expect, it } from "vitest";
import {
  parsePrivacyNoticeUrl,
  parseStoreReceiptProfileDetails,
  storeReceiptProfileSetupGaps,
  storeReceiptTaxRegistrations,
} from "../contracts/store-receipt-profile.js";

// TEST-ONLY values: shaped like CRA / Revenu Québec numbers, not real registrations.
const entered = {
  gstHstNumber: " 000000000 rt 0001 ",
  qstNumber: "0000000000TQ0001",
  pstNumber: null,
  privacyNoticeUrl: "https://example.test/privacy",
};

describe("Store receipt and privacy details (WP-2423 Q15/Q16)", () => {
  it("normalizes what the Owner typed and prints registrations in a fixed order", () => {
    const details = parseStoreReceiptProfileDetails(entered);
    expect(details).toEqual({
      gstHstNumber: "000000000RT0001",
      qstNumber: "0000000000TQ0001",
      pstNumber: null,
      privacyNoticeUrl: "https://example.test/privacy",
    });
    expect(storeReceiptTaxRegistrations(details)).toEqual([
      { label: "GST/HST", number: "000000000RT0001" },
      { label: "QST", number: "0000000000TQ0001" },
    ]);
    expect(storeReceiptProfileSetupGaps(details)).toEqual({
      taxRegistrationMissing: false,
      privacyNoticeMissing: false,
    });
  });

  it("treats blank fields as not entered and reports what staff still need to add", () => {
    const blank = parseStoreReceiptProfileDetails({
      gstHstNumber: "",
      qstNumber: "  ",
      pstNumber: null,
      privacyNoticeUrl: "",
    });
    expect(storeReceiptTaxRegistrations(blank)).toEqual([]);
    expect(storeReceiptProfileSetupGaps(blank)).toEqual({
      taxRegistrationMissing: true,
      privacyNoticeMissing: true,
    });
    expect(storeReceiptProfileSetupGaps(null)).toEqual({
      taxRegistrationMissing: true,
      privacyNoticeMissing: true,
    });
  });

  it.each([
    { gstHstNumber: "12345678RT0001" },
    { gstHstNumber: "123456789RC0001" },
    { qstNumber: "123456789RT0001" },
    { pstNumber: "<b>" },
  ])("rejects a number in the wrong shape %#", (bad) => {
    expect(() => parseStoreReceiptProfileDetails({ ...entered, ...bad })).toThrow(
      "STORE_RECEIPT_PROFILE_INVALID",
    );
  });

  it.each([
    "http://example.test/privacy",
    "https://user:secret@example.test/privacy",
    "javascript:alert(1)",
    "https://localhost/privacy",
    "https://example.test/pri vacy",
    "https://example.test/" + "a".repeat(500),
  ])("rejects an unsafe privacy link %s", (url) => {
    expect(() => parsePrivacyNoticeUrl(url)).toThrow("STORE_RECEIPT_PROFILE_INVALID");
  });

  it("rejects unknown fields", () => {
    expect(() => parseStoreReceiptProfileDetails({ ...entered, legalName: "x" })).toThrow(
      "STORE_RECEIPT_PROFILE_INVALID",
    );
  });
});
