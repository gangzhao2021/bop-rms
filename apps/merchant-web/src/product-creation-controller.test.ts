import { expect, it, vi } from "vitest";
import { createProductCreationController } from "./product-creation-controller.js";
import {
  createProductCommandClient,
  type CreateProductCommand,
} from "./catalog-product-command-client.js";
import { createStoreCapabilityClient } from "./store-capability-client.js";
const id = (n: number) => `01902500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const csrf = "c".repeat(43);
function command(): CreateProductCommand {
  return {
    internalCode: "SYNTH_NEW",
    productType: "PreparedFood",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic new product" },
    taxClassificationReference: null,
    operationReference: id(4),
    skus: [],
    editorContent: {
      profile: "CatalogProductEditorContentV1",
      localizedShortDescriptions: {},
      localizedDescriptions: { "en-CA": "Proposed description" },
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
}
function fixture() {
  const control = {
    at: Date.parse("2026-10-01T17:00:00.000Z"),
    context: 0,
    disabled: false,
    brand: id(2),
    offset: 0,
    mode: "Applied",
    bodies: [] as string[],
    release: null as (() => void) | null,
  };
  const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  const capabilities = createStoreCapabilityClient(
    async (_url, init) => {
      if (control.mode === "SlowGate")
        await new Promise<void>((resolve) => {
          control.release = resolve;
        });
      const body = JSON.parse(String(init?.body)) as { capabilityKey: string };
      return response({
        brandReference: control.brand,
        storeReference: id(3),
        capabilityKey: body.capabilityKey,
        controlKey: "catalog.product.create",
        backendExecution: control.disabled ? "Deny" : "Allow",
        frontendVisibility: control.disabled ? "Hide" : "Show",
        reason: control.disabled ? "Disabled" : "Enabled",
        source: "StoreOverride",
        controlReference: id(8),
        controlVersion: 1,
        observedAt: new Date(control.at + control.offset).toISOString(),
      });
    },
    () => control.at,
  );
  const commands = createProductCommandClient(async (_url, init) => {
    control.bodies.push(String(init?.body));
    if (control.mode === "Lost") throw new Error("Synthetic reply loss");
    if (control.mode === "Denied") return response({ error: "request_denied" }, 403);
    if (control.mode === "SlowCommand")
      await new Promise<void>((resolve) => {
        control.release = resolve;
      });
    return response({
      status: control.bodies.length > 1 ? "AlreadyApplied" : "Applied",
      scope: { brandReference: id(2), storeReference: id(3) },
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      aggregateVersion: 1,
      lifecycle: "Draft",
      skus: [],
      ...(JSON.parse(String(init?.body)).categoryClassification === undefined
        ? {}
        : {
            categoryClassification: JSON.parse(String(init?.body)).categoryClassification,
          }),
    });
  });
  const controller = createProductCreationController({
    storeReference: id(3),
    currentContext: () => control.context,
    now: () => control.at,
    capabilities,
    commands,
  });
  return { control, controller };
}
it("uses current scoped Create capability, explicit full proposal and native root1 receipt", async () => {
  const { control, controller } = fixture();
  await controller.refresh(csrf);
  expect(controller.view().state).toBe("Ready");
  await controller.create(command(), csrf);
  expect(controller.view()).toMatchObject({
    state: "Confirmed",
    pending: false,
    receipt: { aggregateVersion: 1, productReference: id(5) },
  });
  expect(JSON.parse(control.bodies[0] ?? "null")).toMatchObject({
    skus: [],
    editorContent: command().editorContent,
  });
});
it("locks new intents after lost reply and preserves original through current source and native refusals", async () => {
  const { control, controller } = fixture();
  control.mode = "Lost";
  await expect(controller.create(command(), csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  await expect(
    controller.create({ ...command(), internalCode: "OTHER" }, csrf),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  control.disabled = true;
  await expect(controller.retry(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(control.bodies).toHaveLength(1);
  control.disabled = false;
  control.mode = "Denied";
  await expect(controller.retry(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  control.mode = "Applied";
  control.at += 60000;
  await controller.retry(csrf);
  expect(new Set(control.bodies).size).toBe(1);
  expect(controller.view()).toMatchObject({
    state: "Confirmed",
    pending: false,
    receipt: { status: "AlreadyApplied" },
  });
});
it.each([-5000, 1])(
  "refuses exclusive expired or future source before any dispatch (%i)",
  async (offset) => {
    const { control, controller } = fixture();
    control.offset = offset;
    await expect(controller.create(command(), csrf)).rejects.toMatchObject({ code: "Stale" });
    expect(control.bodies).toHaveLength(0);
  },
);
it("expires ready access without advancing an original intent", async () => {
  const { control, controller } = fixture();
  await controller.refresh(csrf);
  control.at += 5000;
  expect(controller.view().state).toBe("Stale");
  expect(control.bodies).toHaveLength(0);
});
it("refuses late context departure after capability await and before identity preparation", async () => {
  const { control, controller } = fixture();
  control.mode = "SlowGate";
  const work = controller.create(command(), csrf);
  await Promise.resolve();
  control.context++;
  control.release?.();
  await expect(work).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(control.bodies).toHaveLength(0);
});
it("refuses changed Brand on subsequent gate without dispatch", async () => {
  const { control, controller } = fixture();
  await controller.refresh(csrf);
  control.brand = id(99);
  await expect(controller.create(command(), csrf)).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(control.bodies).toHaveLength(0);
});
it("keeps late command success uncertain after departure", async () => {
  const { control, controller } = fixture();
  control.mode = "SlowCommand";
  const work = controller.create(command(), csrf);
  await vi.waitFor(() => expect(control.release).not.toBeNull());
  control.context++;
  control.release?.();
  await expect(work).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(controller.view()).toMatchObject({ pending: true, receipt: null });
});
it("allows correction only after definitive original refusal, and rejects invalid proposal before dispatch", async () => {
  const { control, controller } = fixture();
  await expect(
    controller.create({ ...command(), defaultLocale: "bad_locale" }, csrf),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(control.bodies).toHaveLength(0);
  control.mode = "Denied";
  await expect(controller.create(command(), csrf)).rejects.toMatchObject({ code: "Denied" });
  expect(controller.view().pending).toBe(false);
  control.mode = "Applied";
  await controller.create(command(), csrf);
  expect(controller.view().state).toBe("Confirmed");
});
it("detaches the explicit proposal before a slow capability observation", async () => {
  const { control, controller } = fixture();
  control.mode = "SlowGate";
  const candidate = command(),
    work = controller.create(candidate, csrf);
  await vi.waitFor(() => expect(control.release).not.toBeNull());
  Object.assign(candidate, {
    internalCode: "LATE_OTHER",
    localizedNames: { "en-CA": "Late mutation" },
  });
  if (candidate.editorContent)
    Object.assign(candidate.editorContent.localizedDescriptions, { "en-CA": "Late description" });
  control.mode = "Applied";
  control.release?.();
  await work;
  expect(JSON.parse(control.bodies[0] ?? "null")).toMatchObject({
    internalCode: "SYNTH_NEW",
    localizedNames: { "en-CA": "Synthetic new product" },
    editorContent: { localizedDescriptions: { "en-CA": "Proposed description" } },
  });
});
it("refuses getter proposals before any capability await without evaluating them", async () => {
  const { control, controller } = fixture();
  control.mode = "SlowGate";
  const candidate = command(),
    getter = vi.fn();
  Object.defineProperty(candidate, "localizedNames", { enumerable: true, get: getter });
  await expect(controller.create(candidate, csrf)).rejects.toMatchObject({ code: "Invalid" });
  expect(getter).not.toHaveBeenCalled();
  expect(control.release).toBeNull();
  expect(control.bodies).toHaveLength(0);
});
it.each([-1, Number.NaN])(
  "refuses reversed or nonfinite clocks before dispatch (%s)",
  async (delta) => {
    const { control, controller } = fixture();
    await controller.refresh(csrf);
    control.at += delta;
    expect(controller.view().state).toBe("Stale");
    await expect(controller.create(command(), csrf)).rejects.toMatchObject({ code: "Stale" });
    expect(control.bodies).toHaveLength(0);
  },
);

function categorySource(at: number) {
  return {
    scope: { brandReference: id(2), storeReference: id(3) },
    lookup: {
      projection: {
        name: "catalog_product_category_lookup_v1" as const,
        version: 1 as const,
        asOfUtc: new Date(at).toISOString(),
        stale: false as const,
        partial: true as const,
      },
      parentScreenId: "CAT-PRODUCT-CREATE" as const,
      brandReference: id(2),
      locale: "en-CA",
      configuration: "Draft" as const,
      source: {
        revision: "2",
        digest: "sha256:" + "a".repeat(64),
        asOfUtc: new Date(at).toISOString(),
      },
      policy: { allowedLifecycles: ["Draft" as const] },
      items: [
        {
          categoryReference: id(7),
          internalCode: "CAT_7",
          name: "Synthetic Category",
          nameLocale: "en-CA",
          localeFallback: false,
          lifecycle: "Draft" as const,
        },
      ],
    },
  };
}
const classified = () => ({
  ...command(),
  categoryClassification: {
    categoryReferences: [id(7)],
    primaryCategoryReference: id(7),
  },
});
it("requires a closed current scoped Category source for explicit assignment and known empty", async () => {
  const { control, controller } = fixture();
  await controller.refresh(csrf);
  for (const value of [
    classified(),
    {
      ...command(),
      categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
    },
  ]) {
    await expect(controller.create(value, csrf)).rejects.toMatchObject({ code: "Unavailable" });
  }
  expect(control.bodies).toHaveLength(0);
  await controller.create(classified(), csrf, undefined, categorySource(control.at));
  expect(JSON.parse(control.bodies[0] ?? "null").categoryClassification).toEqual(
    classified().categoryClassification,
  );
});
it.each(["scope", "locale", "parent", "member", "future", "expired"])(
  "refuses mismatched or noncurrent initial Category source (%s)",
  async (kind) => {
    const { control, controller } = fixture();
    await controller.refresh(csrf);
    const source = categorySource(control.at),
      proposal = classified();
    if (kind === "scope") source.scope.storeReference = id(99);
    if (kind === "locale") source.lookup.locale = "fr-CA";
    if (kind === "parent") Object.assign(source.lookup, { parentScreenId: "CAT-PRODUCT-EDIT" });
    if (kind === "member") proposal.categoryClassification.categoryReferences = [id(99)];
    if (kind === "future" || kind === "expired") {
      const at = new Date(control.at + (kind === "future" ? 1 : -5000)).toISOString();
      source.lookup.source.asOfUtc = at;
      source.lookup.projection.asOfUtc = at;
    }
    await expect(controller.create(proposal, csrf, undefined, source)).rejects.toBeDefined();
    expect(control.bodies).toHaveLength(0);
    expect(controller.view().pending).toBe(false);
  },
);
it("expires Category source during renewed current Create access before preparing an operation", async () => {
  const { control, controller } = fixture();
  await controller.refresh(csrf);
  const source = categorySource(control.at);
  control.mode = "SlowGate";
  const work = controller.create(classified(), csrf, undefined, source);
  await vi.waitFor(() => expect(control.release).not.toBeNull());
  control.at += 5000;
  control.mode = "Applied";
  control.release?.();
  await expect(work).rejects.toMatchObject({ code: "Stale" });
  expect(control.bodies).toHaveLength(0);
  expect(controller.view().pending).toBe(false);
});
it("detaches Category choices before access await and retains original classification through Unknown recovery", async () => {
  const { control, controller } = fixture();
  await controller.refresh(csrf);
  const source = categorySource(control.at);
  control.mode = "SlowGate";
  const work = controller.create(classified(), csrf, undefined, source);
  await vi.waitFor(() => expect(control.release).not.toBeNull());
  source.lookup.items.length = 0;
  control.mode = "Lost";
  control.release?.();
  await expect(work).rejects.toMatchObject({ code: "OutcomeUnknown" });
  control.at += 60000;
  control.mode = "Applied";
  await controller.retry(csrf);
  expect(new Set(control.bodies).size).toBe(1);
  expect(JSON.parse(control.bodies[0] ?? "null").categoryClassification).toEqual(
    classified().categoryClassification,
  );
});

it("refuses accessor Category choices before capability await without evaluating them", async () => {
  const { control, controller } = fixture();
  await controller.refresh(csrf);
  const source = categorySource(control.at),
    getter = vi.fn();
  Object.defineProperty(source.lookup, "items", { enumerable: true, get: getter });
  control.mode = "SlowGate";
  await expect(controller.create(classified(), csrf, undefined, source)).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(getter).not.toHaveBeenCalled();
  expect(control.release).toBeNull();
  expect(control.bodies).toHaveLength(0);
});
