import { expect, it, vi } from "vitest";
import {
  createProductPublicationManagementClientV2,
  parseProductPublicationManagementViewV2,
} from "./product-publication-management-client-v2.js";
import {
  at,
  csrf,
  id,
  management,
  oldPublication,
  request,
  response,
  seal,
  validatedManagement,
} from "./product-publication-v2-test-fixtures.js";
const now = () => Date.parse(at);
it("reads closed V2 management with original nullable Draft review and ApprovalPending", async () => {
  const raw = validatedManagement(),
    view = await parseProductPublicationManagementViewV2(raw, request, now);
  expect(view.versions[0]).toMatchObject({
    state: "Draft",
    reviewVersion: null,
    validationDecision: "ApprovalPending",
    approvalPolicy: "Required",
  });
  expect(Object.isFrozen(view.versions[0]?.replacementIntent)).toBe(true);
  expect(view.eligibility).toBe("NotEvaluated");
});
it("preserves owner supplied selector filters and complete immutable exact tuple", async () => {
  const raw = management(at, oldPublication()),
    view = await parseProductPublicationManagementViewV2(raw, request, now);
  expect(view.replacementTargets).toEqual(raw.replacementTargets);
  expect(view.versions[0]?.original).toEqual(raw.versions[0]);
  const first = raw.replacementTargets[0]?.selector;
  if (!first) throw new Error("Missing synthetic target");
  first.channelCodes = [];
  expect(view.replacementTargets[0]?.selector.channelCodes).toEqual(["DELIVERY"]);
  expect(Object.isFrozen(view.replacementTargets[0]?.selector)).toBe(true);
});
it.each([
  "target",
  "omittedTarget",
  "profile",
  "scope",
  "root",
  "lease",
  "missingHeader",
  "extra",
  "getter",
])("refuses closed management %s despite rebuilt envelope integrity", async (mode) => {
  let raw: unknown = management(at, oldPublication());
  const value = raw as ReturnType<typeof management>;
  const getter = vi.fn();
  if (mode === "target") {
    const first = value.replacementTargets[0];
    if (!first) throw new Error("Missing synthetic target");
    first.replacementIntent.previousPublicationOperationReference = id(99);
  }
  if (mode === "omittedTarget") value.replacementTargets = [];
  if (mode === "profile") value.profile = "CatalogProductPublicationManagementV1";
  if (mode === "scope") value.storeReference = id(99);
  if (mode === "root") value.aggregateVersion++;
  if (mode === "lease") value.validUntil = "2026-10-01T12:00:06.000Z";
  if (mode === "missingHeader") {
    const v = validatedManagement();
    raw = seal({ ...v, scopeRetirementHeaders: [] });
  } else if (mode === "extra") raw = seal({ ...value, eligibilityDecision: "Eligible" });
  else if (mode === "getter")
    Object.defineProperty(value, "history", { enumerable: true, get: getter });
  else raw = seal(value);
  await expect(parseProductPublicationManagementViewV2(raw, request, now)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("uses explicit route, unchanged scope header and original earliest lease", async () => {
  const raw = management(),
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw));
  expect(
    (
      await createProductPublicationManagementClientV2(fetcher, now).load(
        { request, csrf },
        new AbortController().signal,
      )
    ).validUntil,
  ).toBe(raw.validUntil);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/catalog/products/publication/management/v2");
  await expect(
    parseProductPublicationManagementViewV2(raw, request, () => Date.parse(raw.validUntil)),
  ).rejects.toMatchObject({ code: "Stale" });
});
