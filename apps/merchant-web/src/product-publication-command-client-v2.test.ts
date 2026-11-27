import { expect, it, vi } from "vitest";
import {
  createProductPublicationCommandClientV2,
  parseProductPublicationUserCommandV2,
} from "./product-publication-command-client-v2.js";
import {
  parseProductPublicationUserCommand,
  productPublicationUserActions,
} from "./product-publication-command-client.js";
import {
  command,
  csrf,
  exact,
  id,
  receipt,
  response,
  scope,
  seal,
} from "./product-publication-v2-test-fixtures.js";
const selected = { brandReference: scope.brandReference, storeReference: scope.storeReference };
it.each(productPublicationUserActions)(
  "binds full None %s to explicit V2 result and transport",
  async (action) => {
    const c = command(action),
      fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(receipt(c)));
    const prepared = await createProductPublicationCommandClientV2(fetcher).prepare(c, selected);
    expect(await prepared.execute(csrf)).toEqual(receipt(c));
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/catalog/products/publication/v2");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(prepared.command),
    });
    expect(() => parseProductPublicationUserCommand(c)).toThrow();
  },
);
it("detaches Exact target before hashing and replays identical bytes through lost and denied responses", async () => {
  const c = command("Publish"),
    replacementIntent = exact();
  Object.assign(c, { replacementIntent, replacementIntentDigest: replacementIntent.digest });
  const original = structuredClone(c),
    fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("synthetic loss"))
      .mockResolvedValueOnce(response({ error: "request_denied" }, 403))
      .mockResolvedValueOnce(response(receipt(original, "Replayed")));
  const pending = createProductPublicationCommandClientV2(fetcher).prepare(c, selected);
  replacementIntent.previousVersionReference = id(99);
  c.occurredAt = "2027-10-01T12:00:00.000Z";
  const prepared = await pending;
  expect(Object.isFrozen(prepared.command.replacementIntent)).toBe(true);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(prepared.execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  expect((await prepared.execute(csrf)).status).toBe("Replayed");
  expect(new Set(fetcher.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
  expect(prepared.command.replacementIntent).toEqual(original.replacementIntent);
});
it.each([
  "profile",
  "digest",
  "target",
  "index",
  "selector",
  "self",
  "originalOp",
  "successor",
  "authority",
  "getter",
])("rejects invalid V2 %s before sending", async (mode) => {
  const c = command("Publish"),
    intent = exact();
  Object.assign(c, { replacementIntent: intent, replacementIntentDigest: intent.digest });
  const getter = vi.fn();
  if (mode === "profile") c.profile = "CatalogProductPublicationCommandV1";
  if (mode === "digest") c.replacementIntentDigest = "sha256:" + "0".repeat(64);
  if (mode === "target") intent.previousPublicationOperationReference = id(99);
  if (mode === "index") {
    Object.assign(intent, seal({ ...intent, previousSelectorIndex: 1000 }));
    c.replacementIntentDigest = intent.digest;
  }
  if (mode === "selector") {
    const first = c.scopeSet[0];
    if (!first) throw new Error("Missing synthetic selector");
    first.channelCodes = [];
  }
  if (mode === "self") c.versionReference = intent.previousVersionReference;
  if (mode === "originalOp") c.operationReference = intent.previousPublicationOperationReference;
  if (mode === "successor") c.successorDraftVersionReference = intent.previousVersionReference;
  if (mode === "authority") Object.assign(c, { validationDecision: "Pass" });
  if (mode === "getter") Object.defineProperty(intent, "mode", { enumerable: true, get: getter });
  await expect(parseProductPublicationUserCommandV2(c)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each(["profile", "replacementIntentDigest", "state", "aggregateVersion"])(
  "refuses rebound V2 receipt %s as unknown",
  async (key) => {
    const c = command(),
      result = receipt(c);
    Object.assign(result, { [key]: key === "aggregateVersion" ? 99 : "invalid" });
    const prepared = await createProductPublicationCommandClientV2(
      vi.fn<typeof fetch>().mockResolvedValue(response(result)),
    ).prepare(c, selected);
    await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  },
);
