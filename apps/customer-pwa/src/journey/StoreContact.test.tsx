import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatStorePhone, parseStoreContact, StoreContactCard } from "./StoreContact.js";

const contact = {
  phone: "+14165550123",
  addressLines: ["DEMO 100 Test Street", "Unit 2"],
  locality: "Toronto",
  regionCode: "ON",
  postalCode: "M5V 1A1",
};

describe("WP-2423 Q10 store contact", () => {
  it("parses exactly the published fields", () => {
    expect(parseStoreContact(contact)).toEqual(contact);
    expect(parseStoreContact({ ...contact, phone: null }).phone).toBeNull();
  });
  it.each([
    { ...contact, staffPhone: "+14165550199" },
    { ...contact, phone: "416-555-0123" },
    { ...contact, addressLines: [] },
    { ...contact, addressLines: ["a", "b", "c", "d"] },
    { ...contact, locality: "<script>" },
    { ...contact, postalCode: "" },
    null,
  ])("refuses malformed or extra contact %#", (value) => {
    expect(() => parseStoreContact(value)).toThrow(TypeError);
  });
  it("formats a North American number and keeps other numbers international", () => {
    expect(formatStorePhone("+14165550123")).toBe("(416) 555-0123");
    expect(formatStorePhone("+442071234567")).toBe("+442071234567");
  });
  it("renders a call link only when a phone is published", () => {
    const withPhone = renderToStaticMarkup(<StoreContactCard contact={contact} storeName="DEMO" />);
    expect(withPhone).toContain('href="tel:+14165550123"');
    expect(withPhone).toContain("<address");
    const withoutPhone = renderToStaticMarkup(
      <StoreContactCard contact={{ ...contact, phone: null }} />,
    );
    expect(withoutPhone).not.toContain("tel:");
    expect(withoutPhone).toContain("Toronto, ON M5V 1A1");
  });
});
