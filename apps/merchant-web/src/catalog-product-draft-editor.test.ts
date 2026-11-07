import { expect, it, vi } from "vitest";
import { createProductDraftEditor } from "./catalog-product-draft-editor.js";
import { createProductDraftBaselineTransportClient } from "./catalog-product-draft-baseline-client.js";
import { createProductCommandClient } from "./catalog-product-command-client.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z",
  csrf = "A".repeat(43);
const selected = { brandReference: id(2), storeReference: id(5), productReference: id(1) };
function fixture() {
  return {
    scope: { brandReference: id(2), storeReference: id(5) },
    baseline: {
      projection: {
        name: "catalog_product_draft_baseline_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      },
      productReference: id(1),
      brandReference: id(2),
      internalCode: "DRAFT_1",
      productType: "PreparedFood",
      lifecycle: "Active",
      aggregateVersion: 4,
      updatedAt: at,
      classificationCoverage: "Known",
      draft: {
        versionReference: id(4),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic draft" } as Record<string, string>,
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        categoryClassification: { categoryReferences: [id(6)], primaryCategoryReference: id(6) },
        skus: [0, 1].map((n) => ({
          skuReference: id(10 + n),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "SKU_" + n,
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic SKU " + n },
          variantSelections: [{ dimensionReference: id(20), valueReference: id(21 + n) }],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        })),
        optionBindings: [
          {
            bindingReference: id(40),
            optionSetReference: id(41),
            optionSetVersionReference: id(42),
            purpose: "SELECT",
            sortOrder: 0,
            enabledOptionReferences: [id(43)],
            defaultSelections: [{ optionReference: id(43), quantity: 2 }],
            minimumSelectionOverride: 0,
            maximumSelectionOverride: 2,
            includedSkuReferences: [id(10)],
            excludedSkuReferences: [],
            channelCodes: ["QR", "WEB"],
            storeOverrideAllowed: false,
          },
        ],
      },
    },
  };
}
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise is not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let view = fixture(),
    current = { ...selected },
    context = 1;
  const reader = vi.fn<typeof fetch>(async () => response(view)),
    writer = vi.fn<typeof fetch>(async (_path, init) => {
      const command = JSON.parse(String(init?.body));
      const draft = { ...command.draft, updatedAt: at };
      const result = {
        status: "Applied",
        scope: view.scope,
        operationReference: command.operationReference,
        productReference: command.productReference,
        aggregateVersion: command.expectedAggregateVersion + 1,
        draft,
      };
      view = {
        ...view,
        baseline: { ...view.baseline, aggregateVersion: result.aggregateVersion, draft },
      };
      return response(result);
    });
  const editor = createProductDraftEditor({
    expectedScope: selected,
    currentScope: () => current,
    currentContext: () => context,
    baseline: createProductDraftBaselineTransportClient(reader, () => Date.parse(at)),
    commands: createProductCommandClient(writer),
    now: () => Date.parse(at),
  });
  const load = () => editor.load(new AbortController().signal);
  const edit = (name = "Edited") => {
    const draft = editor.view().draft;
    if (!draft) throw new Error("Missing synthetic Draft");
    editor.edit({ ...draft, localizedNames: { "en-CA": name } });
  };
  return {
    editor,
    reader,
    writer,
    load,
    edit,
    setScope: (value: typeof selected) => {
      current = value;
    },
    setContext: (value: number) => {
      context = value;
    },
    setView: (value: ReturnType<typeof fixture>) => {
      view = value;
    },
    getView: () => view,
  };
}
it("keeps full graph and fresh version after each actual client save", async () => {
  const f = setup();
  await f.load();
  f.edit();
  await f.editor.save(id(90), csrf);
  expect(f.editor.view()).toMatchObject({
    status: "Ready",
    dirty: false,
    pendingSave: false,
    appliedNeedsRefresh: false,
    baseline: { aggregateVersion: 5 },
    draft: { localizedNames: { "en-CA": "Edited" } },
  });
  expect(f.reader).toHaveBeenCalledTimes(2);
  f.edit("Second edit");
  await f.editor.save(id(91), csrf);
  expect(f.editor.view().baseline?.aggregateVersion).toBe(6);
  const commands = f.writer.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
  expect(commands.map((c) => c.expectedAggregateVersion)).toEqual([4, 5]);
  expect(commands[0].draft.optionBindings).toEqual(fixture().baseline.draft.optionBindings);
  expect(commands[0].draft.skus).toEqual(fixture().baseline.draft.skus);
});
it("never silently reloads dirty edits; local discard is explicit", async () => {
  const f = setup();
  await f.load();
  f.edit();
  await expect(f.load()).rejects.toMatchObject({ code: "UnsavedChanges" });
  expect(f.reader).toHaveBeenCalledTimes(1);
  await f.editor.discardAndReload(new AbortController().signal);
  expect(f.editor.view()).toMatchObject({ status: "Ready", dirty: false });
  expect(f.writer).not.toHaveBeenCalled();
});
it("unchanged valid graph does not claim unsaved edits", async () => {
  const f = setup();
  await f.load();
  f.editor.edit(f.editor.view().draft);
  expect(f.editor.view().dirty).toBe(false);
  await expect(f.editor.save(id(90), csrf)).rejects.toMatchObject({ code: "Invalid" });
  expect(f.writer).not.toHaveBeenCalled();
});
it("retains one exact pending intent, blocks edits/discard/new save, explicitly retries", async () => {
  const f = setup();
  await f.load();
  f.edit();
  const real = f.writer.getMockImplementation();
  if (!real) throw new Error("Missing writer");
  let receipt: unknown;
  f.writer
    .mockImplementationOnce(async (path, init) => {
      const applied = await real(path, init);
      receipt = await applied.json();
      throw new Error("Synthetic lost reply after save");
    })
    .mockImplementationOnce(async () => response({ error: "request_denied" }, 403))
    .mockImplementationOnce(async () =>
      response({ ...(receipt as object), status: "AlreadyApplied" }),
    );
  await expect(f.editor.save(id(90), csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(f.editor.view()).toMatchObject({ status: "OutcomeUnknown", pendingSave: true });
  expect(() => f.edit("Replacement")).toThrow(expect.objectContaining({ code: "PendingSave" }));
  await expect(f.editor.discardAndReload(new AbortController().signal)).rejects.toMatchObject({
    code: "PendingSave",
  });
  await expect(f.editor.save(id(91), csrf)).rejects.toMatchObject({ code: "PendingSave" });
  await expect(f.editor.retrySave(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  expect(f.editor.view()).toMatchObject({
    pendingSave: true,
    draft: null,
    baseline: null,
    error: { attemptCode: "Denied" },
  });
  await f.editor.retrySave(csrf);
  expect(f.editor.view()).toMatchObject({
    status: "Ready",
    pendingSave: false,
    baseline: { aggregateVersion: 5 },
  });
  expect(new Set(f.writer.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
});
it("Applied with failed fresh read blocks another save until explicit read succeeds", async () => {
  const f = setup();
  await f.load();
  f.edit();
  f.reader.mockImplementationOnce(async () =>
    response({ error: "product_draft_baseline_denied" }, 403),
  );
  await expect(f.editor.save(id(90), csrf)).rejects.toMatchObject({ code: "Denied" });
  expect(f.editor.view()).toMatchObject({
    status: "NeedsRefresh",
    pendingSave: false,
    appliedNeedsRefresh: true,
    draft: null,
    baseline: null,
  });
  await expect(f.editor.save(id(91), csrf)).rejects.toMatchObject({ code: "Invalid" });
  await f.load();
  expect(f.editor.view()).toMatchObject({
    status: "Ready",
    appliedNeedsRefresh: false,
    baseline: { aggregateVersion: 5 },
  });
  expect(f.writer).toHaveBeenCalledTimes(1);
});
it("refuses a fresh-looking baseline older than the acknowledged receipt", async () => {
  const f = setup();
  await f.load();
  f.edit();
  f.reader.mockImplementationOnce(async () => response(fixture()));
  await expect(f.editor.save(id(90), csrf)).rejects.toMatchObject({ code: "Stale" });
  expect(f.editor.view()).toMatchObject({
    status: "NeedsRefresh",
    appliedNeedsRefresh: true,
    draft: null,
  });
  await f.load();
  expect(f.editor.view().baseline?.aggregateVersion).toBe(5);
});
it.each(["brandReference", "storeReference", "productReference"] as const)(
  "clears visible data after %s switch and requires explicit same-scope read",
  async (key) => {
    const f = setup();
    await f.load();
    f.edit();
    f.setScope({ ...selected, [key]: id(99) });
    expect(f.editor.view()).toMatchObject({
      status: "ScopeChanged",
      draft: null,
      baseline: null,
      dirty: false,
    });
    await expect(f.load()).rejects.toMatchObject({ code: "ScopeChanged" });
    f.setScope(selected);
    expect(f.editor.view().draft).toBeNull();
    await f.load();
    expect(f.editor.view().status).toBe("Ready");
  },
);
it("rejects deferred read even if scope changes away and back before completion", async () => {
  const f = setup(),
    gate = deferred<Response>();
  f.reader.mockReturnValueOnce(gate.promise);
  const pending = f.load(),
    assertion = expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
  f.setScope({ ...selected, storeReference: id(99) });
  f.editor.view();
  f.setScope(selected);
  gate.resolve(response(fixture()));
  await assertion;
  expect(f.editor.view().draft).toBeNull();
});
it("busy network operation cannot prepare a second intent", async () => {
  const f = setup();
  await f.load();
  f.edit();
  const gate = deferred<Response>();
  f.writer.mockReturnValueOnce(gate.promise);
  const pending = f.editor.save(id(90), csrf),
    assertion = expect(pending).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(f.editor.save(id(91), csrf)).rejects.toMatchObject({ code: "Busy" });
  gate.resolve(response({ error: "product_draft_unavailable" }, 503));
  await assertion;
  expect(f.writer).toHaveBeenCalledTimes(1);
});
it("scope switch during unknown write retains private operation for same-scope recovery", async () => {
  const f = setup();
  await f.load();
  f.edit();
  const gate = deferred<Response>();
  f.writer.mockReturnValueOnce(gate.promise);
  const pending = f.editor.save(id(90), csrf),
    assertion = expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
  f.setScope({ ...selected, storeReference: id(99) });
  expect(f.editor.view()).toMatchObject({ draft: null, pendingSave: true });
  gate.resolve(response({ error: "product_draft_unavailable" }, 503));
  await assertion;
  await expect(f.editor.retrySave(csrf)).rejects.toMatchObject({ code: "ScopeChanged" });
  f.setScope(selected);
  await f.editor.retrySave(csrf);
  expect(f.editor.view()).toMatchObject({
    status: "Ready",
    pendingSave: false,
    baseline: { aggregateVersion: 5 },
  });
});
it("changed auth context cannot disclose or recover prior editor data even with same refs", async () => {
  const f = setup();
  await f.load();
  f.edit();
  f.writer.mockRejectedValueOnce(new Error("Synthetic lost reply"));
  await expect(f.editor.save(id(90), csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  f.setContext(2);
  expect(f.editor.view()).toMatchObject({
    status: "ScopeChanged",
    draft: null,
    baseline: null,
    pendingSave: false,
    dirty: false,
  });
  await expect(f.editor.retrySave(csrf)).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.writer).toHaveBeenCalledTimes(1);
});
it.each([
  [409, "product_draft_conflict", "Conflict"],
  [409, "product_draft_feature_disabled", "FeatureDisabled"],
  [403, "request_denied", "Denied"],
] as const)("preserves definite %s %s outcome", async (status, serverError, code) => {
  const f = setup();
  await f.load();
  f.edit();
  f.writer.mockResolvedValueOnce(response({ error: serverError }, status));
  await expect(f.editor.save(id(90), csrf)).rejects.toMatchObject({ code });
  expect(f.editor.view()).toMatchObject({ status: "SaveFailed", pendingSave: false, dirty: true });
  if (code !== "Conflict") expect(f.editor.view().draft).toBeNull();
});
