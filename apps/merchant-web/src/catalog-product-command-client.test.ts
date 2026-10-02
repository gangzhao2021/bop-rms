import { expect, it, vi } from "vitest";
import {
  createProductCommandClient,
  ProductCommandClientError,
  productCommandMaximumRequestBytes,
  productCompleteDraftMaximumRequestBytes,
  productCommandMaximumResponseBytes,
} from "./catalog-product-command-client.js";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Synthetic fixture missing");
  return value;
}
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) },
  csrf = "A".repeat(43),
  at = "2026-09-28T12:00:00.000Z";
const classified: { categoryReferences: string[]; primaryCategoryReference: string | null } = {
  categoryReferences: [id(9)],
  primaryCategoryReference: id(9),
};
function create() {
  return {
    internalCode: "PRODUCT",
    productType: "PreparedFood",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic product" },
    taxClassificationReference: null,
    operationReference: id(3),
    categoryClassification: {
      ...classified,
      categoryReferences: [...classified.categoryReferences],
    },
    skus: [
      {
        skuCode: "SKU",
        localizedNames: { "en-CA": "Synthetic SKU" },
        variantSelections: [],
        unitOfSale: "EACH",
        unitQuantity: "1",
      },
    ],
  };
}
function created() {
  return {
    status: "Applied",
    scope: { ...scope },
    operationReference: id(3),
    productReference: id(4),
    versionReference: id(5),
    aggregateVersion: 1,
    lifecycle: "Draft",
    categoryClassification: classified,
    skus: [{ skuReference: id(6), skuCode: "SKU", lifecycle: "Draft" }],
  };
}
function save() {
  return {
    productReference: id(4),
    expectedAggregateVersion: 1,
    operationReference: id(30),
    draft: {
      versionReference: id(5),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic changed" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      categoryClassification: {
        ...classified,
        categoryReferences: [...classified.categoryReferences],
      },
      skus: [
        {
          skuReference: id(6),
          productReference: id(4),
          brandReference: id(1),
          skuCode: "SKU",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic SKU" },
          variantSelections: [{ dimensionReference: id(11), valueReference: id(12) }],
          unitOfSale: "EACH",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(7),
        },
      ],
      optionBindings: [
        {
          bindingReference: id(13),
          optionSetReference: id(14),
          optionSetVersionReference: id(15),
          purpose: "CUSTOMIZATION",
          sortOrder: 0,
          enabledOptionReferences: [id(16)],
          defaultSelections: [{ optionReference: id(16), quantity: 1 }],
          minimumSelectionOverride: 0,
          maximumSelectionOverride: 1,
          includedSkuReferences: [id(6)],
          excludedSkuReferences: [],
          channelCodes: ["CUSTOMER_PWA"],
          storeOverrideAllowed: false,
        },
      ],
    },
  };
}
function saved() {
  return {
    status: "Applied",
    scope: { ...scope },
    operationReference: id(30),
    productReference: id(4),
    aggregateVersion: 2,
    draft: { ...save().draft, updatedAt: "2026-09-28T12:00:01.000Z" },
  };
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
  });
it("prepares explicit complete initial Product without a SKU and retains original Create bytes", async () => {
  const command = {
    ...create(),
    skus: [],
    editorContent: {
      profile: "CatalogProductEditorContentV1",
      localizedShortDescriptions: {},
      localizedDescriptions: { "en-CA": "Initial complete content" },
      preparationNotes: {},
      tagReferences: [],
      attributeValues: [],
      media: [],
      variantDimensions: [],
      variantCombinations: [],
      optionRules: [],
      allergenReferences: [],
      nutritionProfile: null,
    },
  };
  const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("SYNTHETIC_LOST_REPLY"))
      .mockResolvedValueOnce(response({ ...created(), status: "AlreadyApplied", skus: [] })),
    prepared = createProductCommandClient(fetcher).prepareCreate(command, scope);
  command.editorContent.localizedDescriptions["en-CA"] = "Changed after preparation";
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect((await prepared.execute(csrf)).skus).toEqual([]);
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  expect(
    JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).editorContent.localizedDescriptions,
  ).toEqual({
    "en-CA": "Initial complete content",
  });
});
it("freezes Create content, scope and original operation across explicit retry", async () => {
  const command = create(),
    selection = { ...scope },
    fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("SYNTHETIC_PRIVATE_FAILURE"))
      .mockResolvedValueOnce(response({ ...created(), status: "AlreadyApplied" }));
  const prepared = createProductCommandClient(fetcher).prepareCreate(command, selection);
  command.localizedNames["en-CA"] = "Changed";
  command.categoryClassification.categoryReferences.length = 0;
  selection.storeReference = id(90);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const result = await prepared.execute(csrf);
  expect(result.status).toBe("AlreadyApplied");
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  const options = fetcher.mock.calls[1]?.[1];
  expect(options).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(
    JSON.parse(
      Buffer.from(
        new Headers(options?.headers).get("x-bop-catalog-scope") ?? "",
        "base64url",
      ).toString(),
    ),
  ).toEqual(scope);
  expect(Object.isFrozen(result.categoryClassification?.categoryReferences)).toBe(true);
});
it("preserves complete Draft variants and Options while binding only server-owned clock metadata separately", async () => {
  const command = save(),
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(saved()));
  const prepared = createProductCommandClient(fetcher).prepareDraft(command, scope);
  command.draft.optionBindings[0]?.enabledOptionReferences.push(id(80));
  const result = await prepared.execute(csrf);
  expect(result.draft.optionBindings[0]?.enabledOptionReferences).toEqual([id(16)]);
  expect(result.draft.skus[0]?.variantSelections).toEqual([
    { dimensionReference: id(11), valueReference: id(12) },
  ]);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/catalog/products/draft");
});
it("saves an initial empty-SKU Draft and retries its exact original without manufacturing a SKU", async () => {
  const command = save();
  command.draft.skus = [];
  command.draft.optionBindings = [];
  const receipt = { ...saved(), draft: { ...command.draft, updatedAt: at } },
    fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("SYNTHETIC_LOST_REPLY"))
      .mockResolvedValueOnce(response({ ...receipt, status: "AlreadyApplied" })),
    prepared = createProductCommandClient(fetcher).prepareDraft(command, scope);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const result = await prepared.execute(csrf);
  expect(result.draft.skus).toEqual([]);
  expect(result.draft.optionBindings).toEqual([]);
  expect(result.status).toBe("AlreadyApplied");
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
});
it.each([
  "scope",
  "operation",
  "classification",
  "missing-classification",
  "extra",
  "sku",
  "version",
  "status",
])("treats malformed Create receipt %s as unknown", async (kind) => {
  const data = created() as unknown as Record<string, unknown>;
  if (kind === "scope") data.scope = { ...scope, storeReference: id(90) };
  if (kind === "operation") data.operationReference = id(90);
  if (kind === "classification")
    data.categoryClassification = { categoryReferences: [], primaryCategoryReference: null };
  if (kind === "missing-classification") delete data.categoryClassification;
  if (kind === "extra") data.actorReference = id(7);
  if (kind === "sku") data.skus = [];
  if (kind === "version") data.aggregateVersion = 2;
  if (kind === "status") data.status = "Created";
  await expect(
    createProductCommandClient(vi.fn<typeof fetch>().mockResolvedValue(response(data)))
      .prepareCreate(create(), scope)
      .execute(csrf),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it.each(["classification", "content", "option", "brand", "version", "product"])(
  "rejects rebound Draft receipt %s",
  async (kind) => {
    const data = saved();
    if (kind === "classification")
      data.draft.categoryClassification = {
        categoryReferences: [],
        primaryCategoryReference: null,
      };
    if (kind === "content") data.draft.localizedNames["en-CA"] = "Changed";
    if (kind === "option")
      data.draft.optionBindings[0]?.defaultSelections.push({
        optionReference: id(17),
        quantity: 1,
      });
    if (kind === "brand" && data.draft.skus[0]) data.draft.skus[0].brandReference = id(90);
    if (kind === "version") data.aggregateVersion = 3;
    if (kind === "product") data.productReference = id(90);
    await expect(
      createProductCommandClient(vi.fn<typeof fetch>().mockResolvedValue(response(data)))
        .prepareDraft(save(), scope)
        .execute(csrf),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  },
);
it("preserves omitted legacy classifications rather than inventing empty", async () => {
  const command: Record<string, unknown> = create(),
    data: Record<string, unknown> = created();
  delete command.categoryClassification;
  delete data.categoryClassification;
  const result = await createProductCommandClient(
    vi.fn<typeof fetch>().mockResolvedValue(response(data)),
  )
    .prepareCreate(command, scope)
    .execute(csrf);
  expect(Object.hasOwn(result, "categoryClassification")).toBe(false);
});
it.each([
  "getters",
  "sparse",
  "cycle",
  "scope",
  "primary",
  "duplicate",
  "extra",
  "decimal",
  "budget",
])("rejects unsafe request %s before fetch", (kind) => {
  const command = create() as unknown as Record<string, unknown>,
    fetcher = vi.fn<typeof fetch>(),
    getter = vi.fn(() => id(3));
  let selection: unknown = scope;
  if (kind === "getters")
    Object.defineProperty(command, "operationReference", { get: getter, enumerable: true });
  if (kind === "sparse") command.skus = new Array(2);
  if (kind === "cycle") command.skus = command;
  if (kind === "scope") selection = { ...scope, permission: "Allow" };
  if (kind === "primary")
    command.categoryClassification = { categoryReferences: [], primaryCategoryReference: id(9) };
  if (kind === "duplicate")
    command.categoryClassification = {
      categoryReferences: [id(9), id(9)],
      primaryCategoryReference: null,
    };
  if (kind === "extra") command.actorReference = id(7);
  if (kind === "decimal") command.skus = [{ ...create().skus[0], unitQuantity: "100000000000000" }];
  if (kind === "budget")
    command.localizedNames = { "en-CA": "X".repeat(productCommandMaximumRequestBytes + 1) };
  expect(() => createProductCommandClient(fetcher).prepareCreate(command, selection)).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  [400, "product_creation_invalid", "Invalid"],
  [403, "request_denied", "Denied"],
  [409, "product_creation_conflict", "Conflict"],
  [503, "product_creation_unavailable", "OutcomeUnknown"],
] as const)("handles definite %s and uncertain503", async (status, error, code) => {
  await expect(
    createProductCommandClient(vi.fn<typeof fetch>().mockResolvedValue(response({ error }, status)))
      .prepareCreate(create(), scope)
      .execute(csrf),
  ).rejects.toMatchObject({ code });
});
it("cannot trust a client-shaped fetcher exception as a definite server denial", async () => {
  await expect(
    createProductCommandClient(
      vi.fn<typeof fetch>().mockRejectedValue(new ProductCommandClientError("Denied")),
    )
      .prepareCreate(create(), scope)
      .execute(csrf),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("bounds a non-cooperative fetcher and cancels slow response streams", async () => {
  vi.useFakeTimers();
  try {
    const pending = createProductCommandClient(
      vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined)),
    )
      .prepareCreate(create(), scope)
      .execute(csrf);
    const checked = expect(pending).rejects.toMatchObject({ code: "OutcomeUnknown" });
    await vi.advanceTimersByTimeAsync(15000);
    await checked;
    const cancel = vi.fn();
    const slow = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":'));
        },
        cancel,
      }),
      { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } },
    );
    const second = createProductCommandClient(vi.fn<typeof fetch>().mockResolvedValue(slow))
      .prepareCreate(create(), scope)
      .execute(csrf);
    const secondChecked = expect(second).rejects.toMatchObject({ code: "OutcomeUnknown" });
    await vi.advanceTimersByTimeAsync(15000);
    await secondChecked;
    expect(cancel).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("rejects oversized streams and invalid JSON/media without false success", async () => {
  for (const result of [
    new Response("x".repeat(productCommandMaximumResponseBytes + 1), {
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    }),
    new Response("{}", { headers: { "Content-Type": "application/json" } }),
    response({}),
  ]) {
    await expect(
      createProductCommandClient(vi.fn<typeof fetch>().mockResolvedValue(result))
        .prepareCreate(create(), scope)
        .execute(csrf),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  }
});

it("measures UTF8 request bytes after valid field normalization", () => {
  const command = create(),
    fetcher = vi.fn<typeof fetch>();
  const names: Record<string, string> = command.localizedNames;
  for (let n = 0; n < 50; n++)
    names[String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26))] = "茶".repeat(60);
  expect(JSON.stringify(command).length).toBeLessThan(productCommandMaximumRequestBytes);
  expect(() => createProductCommandClient(fetcher).prepareCreate(command, scope)).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects invalid CSRF and pre-aborted requests without sending", async () => {
  const fetcher = vi.fn<typeof fetch>(),
    prepared = createProductCommandClient(fetcher).prepareCreate(create(), scope),
    controller = new AbortController();
  controller.abort();
  await expect(prepared.execute("invalid")).rejects.toMatchObject({ code: "Invalid" });
  await expect(prepared.execute(csrf, controller.signal)).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps the operation unknown when a retry is denied until an exact receipt resolves it", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ error: "product_creation_unavailable" }, 503))
    .mockResolvedValueOnce(response({ error: "request_denied" }, 403))
    .mockResolvedValueOnce(response({ ...created(), status: "AlreadyApplied" }));
  const prepared = createProductCommandClient(fetcher).prepareCreate(create(), scope);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(prepared.execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  await expect(prepared.execute("invalid")).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Invalid",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await prepared.execute(csrf)).status).toBe("AlreadyApplied");
  expect(new Set(fetcher.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
});

it("preserves feature-disabled outcome and sticky unknown retry", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ error: "product_creation_feature_disabled" }, 409));
  await expect(
    createProductCommandClient(fetcher).prepareCreate(create(), scope).execute(csrf),
  ).rejects.toMatchObject({ code: "FeatureDisabled" });
  const retry = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("synthetic lost reply"))
    .mockResolvedValueOnce(response({ error: "product_creation_feature_disabled" }, 409));
  const prepared = createProductCommandClient(retry).prepareCreate(create(), scope);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(prepared.execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "FeatureDisabled",
  });
});

function fullSave() {
  const localizedDescriptions: Record<string, string> = {
    "en-CA": "Synthetic complete description",
  };
  return {
    ...save(),
    draft: {
      ...save().draft,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: { "en-CA": "Synthetic short" },
        localizedDescriptions,
        preparationNotes: {},
        tagReferences: [id(100)],
        attributeValues: [
          { attributeReference: id(101), type: "Decimal", value: "0.25", unitCode: "KG" },
        ],
        media: [
          {
            mediaReference: id(102),
            assetReference: id(103),
            assetVersionReference: id(104),
            role: "Primary",
            altText: { "en-CA": "Synthetic image" },
            sortOrder: 0,
            cropReference: id(105),
            focusReference: null,
          },
        ],
        variantDimensions: [
          {
            dimensionReference: id(11),
            code: "SIZE",
            localizedNames: { "en-CA": "Size" },
            sortOrder: 0,
            selectionRequirement: "Required",
            values: [
              {
                valueReference: id(12),
                code: "LARGE",
                localizedNames: { "en-CA": "Large" },
                sortOrder: 0,
                attributeReference: null,
                mediaReference: id(102),
              },
            ],
          },
        ],
        variantCombinations: [
          {
            selections: [{ dimensionReference: id(11), valueReference: id(12) }],
            disposition: "Valid",
            skuReference: id(6),
          },
        ],
        optionRules: [
          {
            bindingReference: id(13),
            versionResolution: "Pinned",
            pricingRule: { reference: id(106), versionReference: id(107) },
            conditionalRule: { reference: id(108), versionReference: id(109) },
            conflictRule: { reference: id(110), versionReference: id(111) },
            variantCondition: [],
          },
        ],
        allergenReferences: [id(112)],
        nutritionProfile: { reference: id(113), versionReference: id(114) },
      },
    },
  };
}
it("retries exact complete content after unknown outcome and binds AlreadyApplied recovery to original intent", async () => {
  const command = fullSave(),
    receipt = {
      ...saved(),
      status: "AlreadyApplied",
      draft: { ...fullSave().draft, updatedAt: saved().draft.updatedAt },
    };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("Synthetic offline"))
    .mockResolvedValueOnce(response(receipt));
  const prepared = createProductCommandClient(fetcher).prepareDraft(command, scope);
  command.draft.editorContent.tagReferences.push(id(199));
  required(command.draft.editorContent.optionRules[0]).pricingRule.reference = id(199);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const recovered = await prepared.execute(csrf);
  expect(recovered.status).toBe("AlreadyApplied");
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).draft.editorContent).toEqual(
    fullSave().draft.editorContent,
  );
  expect(recovered.draft.editorContent?.optionRules[0]?.pricingRule).toEqual({
    reference: id(106),
    versionReference: id(107),
  });
  expect(Object.isFrozen(recovered.draft.editorContent?.nutritionProfile)).toBe(true);
});
it.each(["dropped", "media", "pricing", "nutrition", "tags", "description", "extra"])(
  "refuses a rebound complete Draft receipt %s as OutcomeUnknown",
  async (mode) => {
    const draft = fullSave().draft;
    if (mode === "dropped") delete (draft as Partial<typeof draft>).editorContent;
    if (mode === "media") required(draft.editorContent.media[0]).assetVersionReference = id(199);
    if (mode === "pricing")
      required(draft.editorContent.optionRules[0]).pricingRule.versionReference = id(199);
    if (mode === "nutrition") draft.editorContent.nutritionProfile.reference = id(199);
    if (mode === "tags") draft.editorContent.tagReferences = [];
    if (mode === "description") draft.editorContent.localizedDescriptions["en-CA"] = "Changed";
    if (mode === "extra") Object.assign(draft.editorContent, { eligibility: "Eligible" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...saved(), draft }));
    await expect(
      createProductCommandClient(fetcher).prepareDraft(fullSave(), scope).execute(csrf),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  },
);

it("complete Draft uses existing native HTTP UTF8 ceiling while keeping legacy command bound", async () => {
  const command = fullSave();
  command.draft.editorContent.localizedDescriptions = {
    "en-CA": "a".repeat(4096),
    "fr-CA": "b".repeat(4096),
    "zh-CN": "茶".repeat(3000),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
  expect(bytes).toBeGreaterThan(productCommandMaximumRequestBytes);
  expect(bytes).toBeLessThan(productCompleteDraftMaximumRequestBytes);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ ...saved(), draft: command.draft }));
  const result = await createProductCommandClient(fetcher)
    .prepareDraft(command, scope)
    .execute(csrf);
  expect(result.draft.editorContent?.localizedDescriptions).toEqual(
    command.draft.editorContent.localizedDescriptions,
  );
});
it("refuses a structurally valid complete multilingual payload beyond UTF8 ceiling before transport", () => {
  const command = fullSave();
  for (const locale of ["fr-CA", "zh-CN", "ja-JP", "de-DE", "ko-KR", "es-ES"])
    command.draft.editorContent.localizedDescriptions[locale] = "茶".repeat(4096);
  expect(JSON.stringify(command).length).toBeLessThan(productCompleteDraftMaximumRequestBytes);
  expect(new TextEncoder().encode(JSON.stringify(command)).byteLength).toBeGreaterThan(
    productCompleteDraftMaximumRequestBytes,
  );
  const fetcher = vi.fn<typeof fetch>();
  expect(() => createProductCommandClient(fetcher).prepareDraft(command, scope)).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
