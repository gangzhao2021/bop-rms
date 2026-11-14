import { expect, it, vi } from "vitest";
import {
  createProductOptionPickerClient,
  parseProductOptionPickerView,
} from "./product-option-picker-client.js";
const id = (n: number) => "01902421-7a00-7000-8000-" + n.toString(16).padStart(12, "0"),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  csrf = "A".repeat(43),
  digest = "sha256:" + "a".repeat(64);
// Controlled closed minimal projection, not owner authorization/SQL evidence.
function fixture() {
  const at = new Date().toISOString();
  return {
    profile: "CatalogProductOptionBindingPickerV1",
    ...scope,
    optionSetReference: id(5),
    versionReference: id(6),
    bindingReference: id(7),
    internalCode: "CHOICES",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic choices" },
    rootSelectionRule: {
      minimumSelection: 0,
      maximumSelection: 2,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: 2,
      displayStyle: "MultiChoice",
    },
    options: [
      {
        optionReference: id(8),
        stableCode: "CHOICE",
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic option" },
        sortOrder: 0,
        defaultEligible: true,
        quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
        selectionDisabled: false,
        disabledReason: null,
      },
    ],
    selectionDisabled: false,
    disabledReason: null,
    originalRecordDigest: digest,
    sourceDigest: digest,
    contentDigest: digest,
    configurationDigest: digest,
    sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
    publicationReference: id(9),
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    observedAt: at,
    validUntil: new Date(Date.parse(at) + 5000).toISOString(),
  };
}
const command = { optionSetReference: id(5), versionReference: null };
it("parses actual closed scope, server-prepared reference and complete minimal selection metadata", () => {
  const r = parseProductOptionPickerView(fixture(), command, scope);
  expect(r.bindingReference).toBe(id(7));
  expect(r.options[0]?.quantityRule.maximumQuantity).toBe(2);
  expect(r.referenceEligibility).toBe("NotEvaluated");
});
it("Pinned reads retain explicit historical version and do not pretend it is a current release", () => {
  const f = { ...fixture(), sourceAuthority: "RecordedFrozen", publicationReference: null };
  expect(
    parseProductOptionPickerView(f, { ...command, versionReference: id(6) }, scope)
      .publicationReference,
  ).toBeNull();
  expect(() => parseProductOptionPickerView(f, command, scope)).toThrow();
});
it("retains an owning Inactive Option as available metadata without inventing an Archived reason", () => {
  const f = fixture();
  const view = parseProductOptionPickerView(
    { ...f, options: f.options.map((o) => ({ ...o, lifecycle: "Inactive" })) },
    command,
    scope,
  );
  expect(view.options[0]?.lifecycle).toBe("Inactive");
  expect(view.options[0]?.selectionDisabled).toBe(false);
  expect(view.options[0]?.disabledReason).toBeNull();
});
for (const key of [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
] as const)
  it(`rejects foreign ${key}`, () => {
    expect(() =>
      parseProductOptionPickerView({ ...fixture(), [key]: id(20) }, command, scope),
    ).toThrowError(expect.objectContaining({ code: "ScopeChanged" }));
  });
it("rejects stale leases, foreign version, incomplete digests and extra business payload", () => {
  const f = fixture();
  for (const bad of [
    { ...f, validUntil: f.observedAt },
    { ...f, sourceDigest: "a".repeat(64) },
    { ...f, editorContent: {} },
    { ...f, options: [{ ...f.options[0], quantityRule: null }] },
  ])
    expect(() => parseProductOptionPickerView(bad, command, scope)).toThrow();
  expect(() =>
    parseProductOptionPickerView(
      { ...f, sourceAuthority: "RecordedFrozen", publicationReference: null },
      { ...command, versionReference: id(20) },
      scope,
    ),
  ).toThrow();
});
it("current read uses closed same-origin transport without identity or credentials in URI/body", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(fixture()), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
  );
  const r = await createProductOptionPickerClient(fetcher).load({
    command,
    expectedScope: scope,
    csrf,
    signal: new AbortController().signal,
  });
  expect(r.bindingReference).toBe(id(7));
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/catalog/products/option-binding-picker");
  const init = fetcher.mock.calls[0]?.[1];
  expect(init).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify(command),
  });
});
for (const [status, error, code] of [
  [403, "request_denied", "Denied"],
  [409, "product_option_picker_feature_disabled", "FeatureDisabled"],
  [409, "product_option_picker_conflict", "Conflict"],
  [503, "product_option_picker_unavailable", "Unavailable"],
] as const)
  it(`preserves bounded ${code} without raw response echo`, async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error }), {
          status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    await expect(
      createProductOptionPickerClient(fetcher).load({
        command,
        expectedScope: scope,
        csrf,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code });
  });
it("aborted requests never dispatch or turn into automatic retries", async () => {
  const fetcher = vi.fn(),
    controller = new AbortController();
  controller.abort();
  await expect(
    createProductOptionPickerClient(fetcher).load({
      command,
      expectedScope: scope,
      csrf,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects a response without the no-store boundary", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(fixture()), { headers: { "content-type": "application/json" } }),
  );
  await expect(
    createProductOptionPickerClient(fetcher).load({
      command,
      expectedScope: scope,
      csrf,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("closed request refuses caller Actor, business content and clocks before dispatch", async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const extra of [
    { actorReference: scope.actorReference },
    { options: [] },
    { observedAt: new Date().toISOString() },
  ])
    await expect(
      createProductOptionPickerClient(fetcher).load({
        command: { ...command, ...extra },
        expectedScope: scope,
        csrf,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "Invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("late aborted replies cannot become a selected projection or trigger replacement requests", async () => {
  let complete: (r: Response) => void = () => undefined;
  const response = new Promise<Response>((resolve) => {
      complete = resolve;
    }),
    fetcher = vi.fn<typeof fetch>(async () => response),
    controller = new AbortController(),
    work = createProductOptionPickerClient(fetcher).load({
      command,
      expectedScope: scope,
      csrf,
      signal: controller.signal,
    });
  controller.abort();
  await expect(work).rejects.toMatchObject({ code: "Unavailable" });
  complete(
    new Response(JSON.stringify(fixture()), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("finite source transport refuses an oversized projection without echoing it", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response("x".repeat(2097153), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
  );
  await expect(
    createProductOptionPickerClient(fetcher).load({
      command,
      expectedScope: scope,
      csrf,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("unavailable/archived rows retain actual metadata rather than being silently omitted", () => {
  const f = fixture(),
    o = f.options[0];
  if (!o) throw Error("synthetic option absent");
  const parsed = parseProductOptionPickerView(
    {
      ...f,
      options: [
        { ...o, lifecycle: "Archived", selectionDisabled: true, disabledReason: "OptionArchived" },
      ],
    },
    command,
    scope,
  );
  expect(parsed.options).toHaveLength(1);
  expect(parsed.options[0]?.stableCode).toBe("CHOICE");
  expect(parsed.options[0]?.selectionDisabled).toBe(true);
  expect(() =>
    parseProductOptionPickerView({ ...f, disabledReason: "GUESS_READY" }, command, scope),
  ).toThrow();
});
