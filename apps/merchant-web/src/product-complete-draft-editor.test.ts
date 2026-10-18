import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createCompleteProductDraftEditor } from "./product-complete-draft-editor.js";
import { createProductCommandClient } from "./catalog-product-command-client.js";
import { createProductEditorClient } from "./product-editor-client.js";
import { createStoreCapabilityClient } from "./store-capability-client.js";
const id = (n: number) => "01902443-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T22:00:00.000Z",
  until = "2026-09-30T22:00:05.000Z",
  hash = "sha256:" + "1".repeat(64),
  request = {
    brandReference: id(2),
    storeReference: id(3),
    productReference: id(4),
    expectedAggregateVersion: 7,
  },
  input = { request, csrf: "c".repeat(43) };
function required<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw Error("Synthetic fixture missing");
  return v;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
function seal(v: Record<string, unknown>) {
  const { digest, ...body } = v;
  void digest;
  return {
    ...body,
    digest: "sha256:" + createHash("sha256").update(canonical(body)).digest("hex"),
  };
}
function fixture() {
  return {
    profile: "CatalogProductEditorSnapshotV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    aggregateVersion: 7,
    contentDigest: hash,
    configurationDigest: hash,
    contentStatus: "Present",
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
    aggregate: {
      productReference: id(4),
      brandReference: id(2),
      internalCode: "SYNTHETIC_FULL",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 7,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(5),
      draft: {
        versionReference: id(6),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic full Product" },
        taxClassificationReference: null,
        skus: [
          {
            skuReference: id(30),
            productReference: id(4),
            brandReference: id(2),
            skuCode: "SYNTHETIC_SKU",
            lifecycle: "Draft",
            localizedNames: { "en-CA": "Synthetic SKU" },
            variantSelections: [],
            unitOfSale: "EACH",
            unitQuantity: "1",
            createdAt: at,
            createdByActorReference: id(5),
          },
        ],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: { "en-CA": "Synthetic short" },
          localizedDescriptions: { "en-CA": "Synthetic description\nSecond line" },
          preparationNotes: {},
          tagReferences: [id(10)],
          attributeValues: [
            { attributeReference: id(11), type: "Decimal", value: "1.25", unitCode: "KG" },
          ],
          media: [
            {
              mediaReference: id(12),
              assetReference: id(13),
              assetVersionReference: id(14),
              role: "Primary",
              altText: { "en-CA": "Synthetic image description" },
              sortOrder: 0,
              cropReference: null,
              focusReference: null,
            },
          ],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [id(15)],
          nutritionProfile: { reference: id(16), versionReference: id(17) },
        },
      },
    },
  };
}

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
function setup(
  classification?: {
    categoryReferences: string[];
    primaryCategoryReference: string | null;
  },
  emptySkus = false,
) {
  let time = Date.parse(at),
    context = 0;
  let denied = false,
    changed = false,
    missing = false,
    unknown = false,
    serverDenied = false;
  let releaseRead: (() => void) | undefined, enteredRead: (() => void) | undefined;
  let revision = 7,
    reads = 0;
  const bodies: string[] = [];
  let recordedDraft: ReturnType<typeof fixture>["aggregate"]["draft"] | null = null;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === "/merchant/store-capability") {
      if (denied) return response({ error: "request_denied" }, 403);
      return response({
        brandReference: id(2),
        storeReference: id(3),
        capabilityKey: "catalog.cat_product_edit",
        controlKey: "catalog.product.edit",
        backendExecution: "Allow",
        frontendVisibility: "Show",
        reason: "Enabled",
        source: "StoreOverride",
        controlReference: id(20),
        controlVersion: 1,
        observedAt: new Date(time).toISOString(),
      });
    }
    if (url === "/merchant/catalog/products/editor") {
      reads++;
      if (enteredRead) {
        enteredRead();
        enteredRead = undefined;
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      }
      const raw = fixture();
      if (recordedDraft) raw.aggregate.draft = recordedDraft;
      else if (emptySkus) raw.aggregate.draft.skus = [];
      if (classification)
        Object.assign(raw.aggregate.draft, { categoryClassification: classification });
      raw.observedAt = new Date(time).toISOString();
      raw.validUntil = new Date(time + 5000).toISOString();
      raw.aggregateVersion = revision;
      raw.aggregate.aggregateVersion = revision;
      if (changed) raw.aggregate.draft.localizedNames["en-CA"] = "Changed owner content";
      if (missing) {
        delete (raw.aggregate.draft as Partial<typeof raw.aggregate.draft>).editorContent;
        raw.contentStatus = "Unavailable";
      }
      return response(seal(raw));
    }
    if (url !== "/merchant/catalog/products/draft") throw Error("Unexpected synthetic route");
    const body = String(init?.body);
    bodies.push(body);
    if (unknown) {
      unknown = false;
      throw new TypeError("Synthetic connection lost");
    }
    if (serverDenied) return response({ error: "request_denied" }, 403);
    const command = JSON.parse(body);
    revision = command.expectedAggregateVersion + 1;
    recordedDraft = command.draft;
    return response({
      status: bodies.length > 1 ? "AlreadyApplied" : "Applied",
      scope: { brandReference: id(2), storeReference: id(3) },
      productReference: id(4),
      operationReference: command.operationReference,
      aggregateVersion: revision,
      draft: command.draft,
    });
  });
  const editor = createCompleteProductDraftEditor({
    request,
    currentScope: () => ({ brandReference: id(2), storeReference: id(3), productReference: id(4) }),
    currentContext: () => context,
    now: () => time,
    reads: createProductEditorClient(fetcher, () => time),
    capabilities: createStoreCapabilityClient(fetcher, () => time),
    commands: createProductCommandClient(fetcher),
  });
  const signal = new AbortController().signal,
    csrf = input.csrf;
  const load = () => editor.refresh(csrf, signal);
  const edit = () => {
    const draft = {
      ...required(editor.view().draft),
      localizedNames: { "en-CA": "Intentional local edit" },
    };
    editor.edit(draft);
    return draft;
  };
  return {
    editor,
    signal,
    csrf,
    bodies,
    fetcher,
    load,
    edit,
    reads: () => reads,
    pauseRead: () =>
      new Promise<void>((resolve) => {
        enteredRead = resolve;
      }),
    releaseRead: () => {
      releaseRead?.();
    },
    rewind: () => {
      time--;
    },
    advance: () => {
      time += 5000;
    },
    changeContext: () => {
      context++;
    },
    deny: (v: boolean) => {
      denied = v;
    },
    drift: () => {
      changed = true;
    },
    legacy: () => {
      missing = true;
    },
    lose: () => {
      unknown = true;
    },
    serverDeny: (v: boolean) => {
      serverDenied = v;
    },
  };
}
it("rereads whole current baseline and capability before save then requires actual post-save read", async () => {
  const s = setup();
  await s.load();
  const edited = s.edit();
  await expect(s.editor.save(id(90), s.csrf, s.signal)).resolves.toMatchObject({
    status: "Applied",
  });
  expect(s.reads()).toBe(2);
  expect(s.editor.view()).toMatchObject({
    status: "NeedsRefresh",
    revision: 8,
    draft: null,
    pendingSave: false,
    dirty: false,
  });
  expect(JSON.parse(required(s.bodies[0])).draft.editorContent).toEqual(edited.editorContent);
  await s.load();
  expect(s.editor.view()).toMatchObject({ status: "Ready", revision: 8 });
});
it("appends an explicitly proposed first Draft SKU and reads its persisted receipt on refresh", async () => {
  const s = setup(undefined, true);
  await s.load();
  const baseline = required(s.editor.view().draft),
    sku = {
      skuReference: id(60),
      productReference: id(4),
      brandReference: id(2),
      skuCode: "EXPLICIT_NEW",
      lifecycle: "Draft",
      localizedNames: { "en-CA": "Synthetic explicitly proposed SKU" },
      variantSelections: [],
      unitOfSale: "REGISTERED_PACK",
      unitQuantity: "0.25",
      createdAt: at,
      createdByActorReference: id(5),
    };
  s.editor.edit({ ...baseline, skus: [sku] });
  await expect(s.editor.save(id(90), s.csrf, s.signal)).resolves.toMatchObject({
    aggregateVersion: 8,
  });
  expect(JSON.parse(required(s.bodies[0])).draft.skus).toEqual([sku]);
  await s.load();
  expect(s.editor.view().draft?.skus).toEqual([sku]);
});
it.each(["deleted", "unit", "quantity", "lifecycle", "createdActor", "createdAt"])(
  "refuses recorded SKU %s changes before any save",
  async (kind) => {
    const s = setup();
    await s.load();
    const baseline = required(s.editor.view().draft),
      old = required(baseline.skus[0]);
    const changes =
      kind === "unit"
        ? { unitOfSale: "CHANGED" }
        : kind === "quantity"
          ? { unitQuantity: "0.25" }
          : kind === "lifecycle"
            ? { lifecycle: "Active" }
            : kind === "createdActor"
              ? { createdByActorReference: id(99) }
              : { createdAt: "2026-09-30T22:00:01.000Z" };
    expect(() =>
      s.editor.edit({ ...baseline, skus: kind === "deleted" ? [] : [{ ...old, ...changes }] }),
    ).toThrow();
    expect(s.bodies).toEqual([]);
    expect(s.editor.view().dirty).toBe(false);
  },
);
it("locks every alternative while uncertain and retries original bytes after exclusive expiry without a new baseline", async () => {
  const s = setup();
  await s.load();
  s.edit();
  s.lose();
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(() => s.editor.edit(fixture().aggregate.draft)).toThrow();
  await expect(s.editor.refresh(s.csrf, s.signal)).rejects.toMatchObject({ code: "PendingSave" });
  await expect(s.editor.discardAndReload(s.csrf, s.signal)).rejects.toMatchObject({
    code: "PendingSave",
  });
  await expect(s.editor.save(id(91), s.csrf, s.signal)).rejects.toMatchObject({
    code: "PendingSave",
  });
  s.advance();
  expect(s.editor.view().draft).toBeNull();
  await expect(s.editor.retry(s.csrf, s.signal)).resolves.toMatchObject({
    status: "AlreadyApplied",
  });
  expect(s.bodies[0]).toBe(s.bodies[1]);
  expect(s.reads()).toBe(2);
  expect(JSON.parse(required(s.bodies[1])).operationReference).toBe(id(90));
});
it("preserves uncertain identity across current capability denial and restores explicit original retry", async () => {
  const s = setup();
  await s.load();
  s.edit();
  s.lose();
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  s.deny(true);
  await expect(s.editor.retry(s.csrf, s.signal)).rejects.toMatchObject({ code: "Denied" });
  expect(s.editor.view()).toMatchObject({ pendingSave: true, draft: null });
  expect(s.bodies.length).toBe(1);
  s.deny(false);
  await s.editor.retry(s.csrf, s.signal);
  expect(s.bodies[0]).toBe(s.bodies[1]);
});
it("keeps a denied retry after prior unknown as uncertain rather than authorizing a new operation", async () => {
  const s = setup();
  await s.load();
  s.edit();
  s.lose();
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  s.serverDeny(true);
  await expect(s.editor.retry(s.csrf, s.signal)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(s.editor.view()).toMatchObject({ pendingSave: true, draft: null });
  s.serverDeny(false);
  await s.editor.retry(s.csrf, s.signal);
  expect(new Set(s.bodies).size).toBe(1);
});
it("refuses late owner drift before writing and requires explicit discard instead of an automatic merge", async () => {
  const s = setup();
  await s.load();
  s.edit();
  s.drift();
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({ code: "Conflict" });
  expect(s.bodies).toEqual([]);
  expect(s.editor.view()).toMatchObject({ draft: null, dirty: true });
  await s.editor.discardAndReload(s.csrf, s.signal);
  expect(s.editor.view().draft?.localizedNames["en-CA"]).toBe("Changed owner content");
});
it("same current baseline refresh preserves detached local edits, expiry prohibits a new write", async () => {
  const s = setup();
  await s.load();
  const edited = s.edit();
  edited.localizedNames["en-CA"] = "Mutated after edit";
  s.advance();
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({ code: "Stale" });
  expect(s.bodies).toEqual([]);
  await s.load();
  expect(s.editor.view().draft?.localizedNames["en-CA"]).toBe("Intentional local edit");
});
it("missing legacy extension cannot manufacture a complete editable baseline", async () => {
  const s = setup();
  s.legacy();
  await expect(s.load()).rejects.toMatchObject({ code: "Unavailable" });
  expect(s.editor.view().draft).toBeNull();
  expect(s.bodies).toEqual([]);
});
it.each(["version", "base", "clock", "content", "classification"])(
  "rejects a rebound local %s edit",
  async (kind) => {
    const s = setup();
    await s.load();
    const draft: Record<string, unknown> = { ...required(s.editor.view().draft) };
    if (kind === "version") draft.versionReference = id(99);
    if (kind === "base") draft.baseVersionReference = id(99);
    if (kind === "clock") draft.updatedAt = "2026-09-30T22:00:01.000Z";
    if (kind === "content") delete draft.editorContent;
    if (kind === "classification")
      draft.categoryClassification = { categoryReferences: [], primaryCategoryReference: null };
    expect(() => s.editor.edit(draft)).toThrow();
    expect(s.editor.view().dirty).toBe(false);
  },
);
it("scope context change permanently hides old content and prevents all future writes", async () => {
  const s = setup();
  await s.load();
  s.edit();
  s.changeContext();
  expect(s.editor.view()).toMatchObject({ status: "ScopeChanged", draft: null });
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({
    code: "ScopeChanged",
  });
  await expect(s.load()).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(s.bodies).toEqual([]);
});

it("late current read after context replacement never restores old editable content", async () => {
  const s = setup();
  await s.load();
  const entered = s.pauseRead(),
    running = s.load();
  await entered;
  s.changeContext();
  s.releaseRead();
  await expect(running).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(s.editor.view()).toMatchObject({ status: "ScopeChanged", draft: null });
  expect(s.bodies).toEqual([]);
});
it("clock rollback hides editable content and rejects new save before any transport", async () => {
  const s = setup();
  await s.load();
  s.edit();
  s.rewind();
  expect(s.editor.view().draft).toBeNull();
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({ code: "Stale" });
  expect(s.bodies).toEqual([]);
});

// Current choices are synthetic; native permission/atomic persistence is separately evidenced104.
function editCategories() {
  return {
    scope: { brandReference: id(2), storeReference: id(3) },
    lookup: {
      projection: {
        name: "catalog_product_category_lookup_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      },
      parentScreenId: "CAT-PRODUCT-EDIT",
      brandReference: id(2),
      locale: "en-CA",
      configuration: "Draft",
      source: { revision: "3", digest: hash, asOfUtc: at },
      policy: { allowedLifecycles: ["Draft", "Active"] },
      items: [50, 51].map((n) => ({
        categoryReference: id(n),
        internalCode: "CAT_" + n,
        name: "Synthetic Category " + n,
        nameLocale: "en-CA",
        localeFallback: false,
        lifecycle: "Draft",
      })),
    },
  };
}
it.each([[], [id(50)], [id(50), id(51)]].map((refs) => ({ refs })))(
  "saves detached current Edit classifications including explicit empty %j",
  async ({ refs }) => {
    const s = setup();
    await s.load();
    const source = editCategories();
    const classification = { categoryReferences: refs, primaryCategoryReference: refs[0] ?? null };
    s.editor.edit(
      { ...required(s.editor.view().draft), categoryClassification: classification },
      source,
    );
    source.lookup.items = [];
    classification.categoryReferences = [];
    await expect(s.editor.save(id(90), s.csrf, s.signal)).resolves.toMatchObject({
      status: "Applied",
    });
    expect(
      JSON.parse(required(s.bodies[0])).draft.categoryClassification.categoryReferences,
    ).toEqual(refs);
  },
);
it.each(["Absent", "Parent", "Brand", "Store", "Locale", "Member", "Accessor", "Expired"])(
  "refuses invalid changed classification source %s without mutation",
  async (kind) => {
    const s = setup();
    await s.load();
    const source = editCategories();
    if (kind === "Parent") source.lookup.parentScreenId = "CAT-PRODUCT-CREATE";
    if (kind === "Brand") source.scope.brandReference = id(99);
    if (kind === "Store") source.scope.storeReference = id(99);
    if (kind === "Locale") source.lookup.locale = "fr-CA";
    if (kind === "Member") source.lookup.items = [];
    if (kind === "Accessor")
      Object.defineProperty(source.lookup, "items", {
        get: () => {
          throw Error("Must not execute");
        },
      });
    if (kind === "Expired")
      source.lookup.source.asOfUtc = new Date(Date.parse(at) - 5000).toISOString();
    expect(() =>
      s.editor.edit(
        {
          ...required(s.editor.view().draft),
          categoryClassification: {
            categoryReferences: [id(50)],
            primaryCategoryReference: id(50),
          },
        },
        kind === "Absent" ? undefined : source,
      ),
    ).toThrow();
    expect(s.editor.view().dirty).toBe(false);
    expect(s.bodies).toHaveLength(0);
  },
);
it("rechecks original Category source after awaited current baseline at exclusive expiry", async () => {
  const s = setup();
  await s.load();
  s.editor.edit(
    {
      ...required(s.editor.view().draft),
      categoryClassification: { categoryReferences: [id(50)], primaryCategoryReference: null },
    },
    editCategories(),
  );
  const entered = s.pauseRead(),
    saving = s.editor.save(id(90), s.csrf, s.signal);
  await entered;
  s.advance();
  s.releaseRead();
  await expect(saving).rejects.toMatchObject({ code: "Stale" });
  expect(s.bodies).toHaveLength(0);
});
it("retries original classified bytes after source expiry and current native denial without selection requalification", async () => {
  const s = setup();
  await s.load();
  s.editor.edit(
    {
      ...required(s.editor.view().draft),
      categoryClassification: { categoryReferences: [id(50)], primaryCategoryReference: null },
    },
    editCategories(),
  );
  s.lose();
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  s.advance();
  s.serverDeny(true);
  await expect(s.editor.retry(s.csrf, s.signal)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(s.editor.view().pendingSave).toBe(true);
  s.serverDeny(false);
  await expect(s.editor.retry(s.csrf, s.signal)).resolves.toMatchObject({
    status: "AlreadyApplied",
  });
  expect(new Set(s.bodies).size).toBe(1);
  expect(s.reads()).toBe(2);
});

it("retains recorded unknown Category assignments during text-only Save without a lookup", async () => {
  const classification = { categoryReferences: [id(99)], primaryCategoryReference: id(99) };
  const s = setup(classification);
  await s.load();
  s.edit();
  await s.editor.save(id(90), s.csrf, s.signal);
  expect(JSON.parse(required(s.bodies[0])).draft.categoryClassification).toEqual(classification);
  expect(
    s.fetcher.mock.calls.some(([url]) => url === "/merchant/catalog/products/category-lookup"),
  ).toBe(false);
});
it("cannot silently omit recorded classification and explicit empty still needs a current source", async () => {
  const s = setup({ categoryReferences: [id(99)], primaryCategoryReference: id(99) });
  await s.load();
  const original = required(s.editor.view().draft);
  const { categoryClassification, ...omitted } = original;
  void categoryClassification;
  expect(() => s.editor.edit(omitted, editCategories())).toThrow();
  expect(() =>
    s.editor.edit({
      ...original,
      categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
    }),
  ).toThrow();
  s.editor.edit(
    {
      ...original,
      categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
    },
    editCategories(),
  );
  await s.editor.save(id(90), s.csrf, s.signal);
  expect(JSON.parse(required(s.bodies[0])).draft.categoryClassification).toEqual({
    categoryReferences: [],
    primaryCategoryReference: null,
  });
});
it("last current capability await cannot renew original Category source or manufacture Unknown before transport", async () => {
  const s = setup();
  await s.load();
  s.editor.edit(
    {
      ...required(s.editor.view().draft),
      categoryClassification: { categoryReferences: [id(50)], primaryCategoryReference: null },
    },
    editCategories(),
  );
  const original = required(s.fetcher.getMockImplementation());
  let admissions = 0;
  s.fetcher.mockImplementation(async (url, init) => {
    if (url === "/merchant/store-capability" && ++admissions === 2) s.advance();
    return original(url, init);
  });
  await expect(s.editor.save(id(90), s.csrf, s.signal)).rejects.toMatchObject({ code: "Stale" });
  expect(s.bodies).toHaveLength(0);
  expect(s.editor.view().pendingSave).toBe(false);
});
