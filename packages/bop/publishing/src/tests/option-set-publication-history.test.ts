import { describe, it, expect } from "vitest";
import { parseOptionSetPublicationHistoryRequest } from "../contracts/option-set-publication-history.js";
const id = "018f9f35-0000-7000-8000-000000000001";
const request = () => ({ familyReference: id, before: null, limit: 25 });
describe("closed Option publication history request", () => {
  it("parses bounded first and anchored pages without caller qualification", () => {
    expect(Object.isFrozen(parseOptionSetPublicationHistoryRequest(request()))).toBe(true);
    expect(
      parseOptionSetPublicationHistoryRequest({
        ...request(),
        before: { occurredAt: "2026-10-05T00:00:00.000Z", operationReference: id },
        limit: 50,
      }).before?.operationReference,
    ).toBe(id);
  });
  it.each([0, 51, 1.5, NaN, "25", null])("rejects invalid limit %s", (limit) => {
    expect(() => parseOptionSetPublicationHistoryRequest({ ...request(), limit })).toThrow();
  });
  it.each([
    { ...request(), proof: true },
    { ...request(), familyReference: "bad" },
    { ...request(), before: { occurredAt: "2026-10-05", operationReference: id } },
    {
      ...request(),
      before: { occurredAt: "2026-10-05T00:00:00.000Z", operationReference: id, scope: id },
    },
  ])("rejects malformed closed request", (value) => {
    expect(() => parseOptionSetPublicationHistoryRequest(value)).toThrow();
  });
  it("refuses accessors without invoking them", () => {
    const value = request();
    let reads = 0;
    Object.defineProperty(value, "limit", {
      enumerable: true,
      get() {
        reads++;
        return 25;
      },
    });
    expect(() => parseOptionSetPublicationHistoryRequest(value)).toThrow();
    expect(reads).toBe(0);
  });
});
