import { describe, expect, it, vi } from "vitest";
import { parseBrandReference } from "@bop/tenant";
import { createPostgresPublishingMutationStore, createPublishingScope } from "../index.js";

const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const query = {
  publicationReference: id(22),
  configurationType: "BRAND_CONFIGURATION",
  purposeCode: "BRAND_CONFIGURATION",
  observedAt: "2026-09-11T10:00:00.000Z",
};
const scope = createPublishingScope({
  kind: "Brand",
  brandReference: parseBrandReference(id(2)),
  storeReference: null,
});

describe("referenced current release input", () => {
  it.each([
    null,
    [],
    {},
    { ...query, familyReference: id(4) },
    { ...query, publicationReference: "unrestricted" },
    { ...query, configurationType: "brand_configuration" },
    { ...query, purposeCode: "" },
    { ...query, observedAt: "2026-09-11T10:00:00Z" },
    Object.create(query),
  ])("denies malformed input before opening a transaction (%#)", async (input) => {
    const run = vi.fn();
    const store = createPostgresPublishingMutationStore({ run }, id(1), scope);
    await expect(
      store.resolveCurrentReleaseForReference(input as typeof query),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses accessors without evaluating them", async () => {
    const getter = vi.fn(() => id(22));
    const input = { ...query };
    Object.defineProperty(input, "publicationReference", { get: getter, enumerable: true });
    const run = vi.fn();
    const store = createPostgresPublishingMutationStore({ run }, id(1), scope);
    await expect(store.resolveCurrentReleaseForReference(input)).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Option-only discriminated current source admission", () => {
  it.each([
    null,
    {},
    { familyReference: id(4), observedAt: query.observedAt, approvalPolicy: "NotRequired" },
    { familyReference: "unrestricted", observedAt: query.observedAt },
  ])("rejects caller policy flags and malformed identity before SQL (%#)", async (input) => {
    const run = vi.fn(),
      store = createPostgresPublishingMutationStore({ run }, id(1), scope);
    await expect(
      store.resolveCurrentOptionSetRelease(
        input as { familyReference: string; observedAt: string },
      ),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    expect(run).not.toHaveBeenCalled();
  });
  it("denies Store scope and original-reference policy selectors without touching SQL", async () => {
    const run = vi.fn(),
      store = createPostgresPublishingMutationStore(
        { run },
        id(1),
        createPublishingScope({ kind: "Store", brandReference: id(2), storeReference: id(3) }),
      );
    await expect(
      store.resolveCurrentOptionSetRelease({
        familyReference: id(4),
        observedAt: query.observedAt,
      }),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    await expect(
      store.resolveCurrentOptionSetReleaseForReference({
        publicationReference: id(22),
        observedAt: query.observedAt,
      }),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    expect(run).not.toHaveBeenCalled();
  });
});
