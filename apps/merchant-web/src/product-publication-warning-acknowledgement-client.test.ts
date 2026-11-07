import { expect, it, vi } from "vitest";
import {
  createProductPublicationWarningAcknowledgementClient,
  parseProductPublicationWarningAcknowledgementCommand,
} from "./product-publication-warning-acknowledgement-client.js";
import { at, csrf, digest, id, response, scope } from "./product-publication-v2-test-fixtures.js";
// Controlled transport only; no owning warning, approval or permission evidence.
const selected = { brandReference: scope.brandReference, storeReference: scope.storeReference };
function command() {
  return {
    profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
    action: "AcknowledgeProductPublicationWarnings",
    operationReference: id(301),
    productReference: scope.productReference,
    versionReference: id(6),
    expectedProductAggregateVersion: 7,
    reportOperationReference: id(302),
    reportDigest: digest("synthetic report"),
    warningBindingDigest: digest("synthetic warnings"),
    warningCodes: ["ChangeImpact"],
    reasonCode: "EXPLICIT_REVIEW",
    occurredAt: at,
  };
}
function receipt(c = command(), status = "Applied") {
  const { profile, action, expectedProductAggregateVersion, ...binding } = c;
  void profile;
  void action;
  return {
    profile: "CatalogProductPublicationWarningAcknowledgementResultV1",
    status,
    ...binding,
    aggregateVersion: expectedProductAggregateVersion,
    recordedAt: at,
    receiptDigest: digest("synthetic receipt"),
  };
}
it("sends the exact independent body and binds an unchanged root result", async () => {
  const c = command(),
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(receipt(c))),
    prepared = await createProductPublicationWarningAcknowledgementClient(fetcher).prepare(
      c,
      selected,
    );
  expect(await prepared.execute(csrf)).toEqual(receipt(c));
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "/merchant/catalog/products/publication/warning-acknowledgements/v1",
  );
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify(prepared.command),
  });
  expect(Object.keys(prepared.command)).toHaveLength(12);
  expect(prepared.command).not.toHaveProperty("actorReference");
});
it("captures detached intent and scope, then replays exact bytes after loss and denial", async () => {
  const c = command(),
    original = structuredClone(c),
    selection = { ...selected },
    fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Error("synthetic loss"))
      .mockResolvedValueOnce(response({ error: "request_denied" }, 403))
      .mockResolvedValueOnce(response(receipt(original, "Replayed"))),
    promise = createProductPublicationWarningAcknowledgementClient(fetcher).prepare(c, selection);
  c.reasonCode = "CHANGED";
  c.warningCodes.push("MediaReady");
  selection.storeReference = id(99);
  const prepared = await promise;
  expect(Object.isFrozen(prepared.command.warningCodes)).toBe(true);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(prepared.execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  expect((await prepared.execute(csrf)).status).toBe("Replayed");
  expect(new Set(fetcher.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
  expect(prepared.command).toEqual(original);
  expect(prepared.scope).toEqual(selected);
});
it.each(["identity", "profile", "empty", "duplicate", "unknown", "derived", "reason", "getter"])(
  "rejects %s in closed intent without invoking transport or a getter",
  async (mode) => {
    const c = command(),
      getter = vi.fn(),
      fetcher = vi.fn<typeof fetch>();
    if (mode === "identity") Object.assign(c, { actorReference: id(8) });
    if (mode === "profile") c.profile = "CatalogProductPublicationCommandV2";
    if (mode === "empty") c.warningCodes = [];
    if (mode === "duplicate") c.warningCodes.push("ChangeImpact");
    if (mode === "unknown") c.warningCodes = ["Unknown"];
    if (mode === "derived") c.warningCodes = ["HardErrorsCleared"];
    if (mode === "reason") c.reasonCode = " free text ";
    if (mode === "getter")
      Object.defineProperty(c, "reportDigest", { enumerable: true, get: getter });
    await expect(
      createProductPublicationWarningAcknowledgementClient(fetcher).prepare(c, selected),
    ).rejects.toMatchObject({ code: "Invalid" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  },
);
it.each([
  "aggregateVersion",
  "reportDigest",
  "warningBindingDigest",
  "warningCodes",
  "reasonCode",
  "operationReference",
  "receiptDigest",
  "fullReceipt",
])("treats rebound %s response as Unknown", async (key) => {
  const result = receipt();
  Object.assign(
    result,
    key === "fullReceipt"
      ? { receipt: {} }
      : {
          [key]:
            key === "aggregateVersion" ? 8 : key === "warningCodes" ? ["MediaReady"] : "invalid",
        },
  );
  const prepared = await createProductPublicationWarningAcknowledgementClient(
    vi.fn<typeof fetch>().mockResolvedValue(response(result)),
  ).prepare(command(), selected);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it.each([
  [400, "product_publication_warning_acknowledgement_invalid", "Invalid"],
  [403, "request_denied", "Denied"],
  [409, "product_publication_warning_acknowledgement_conflict", "Conflict"],
] as const)(
  "fresh %s rejection is definitive but recovered original stays Unknown",
  async (status, error, code) => {
    const factory = createProductPublicationWarningAcknowledgementClient(
      vi.fn<typeof fetch>().mockImplementation(async () => response({ error }, status)),
    );
    await expect((await factory.prepare(command(), selected)).execute(csrf)).rejects.toMatchObject({
      code,
    });
    await expect((await factory.recover(command(), selected)).execute(csrf)).rejects.toMatchObject({
      code: "OutcomeUnknown",
      attemptCode: code,
    });
  },
);
it("never sends a locally aborted request, and preserves uncertain recovery on unavailable source", async () => {
  const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ error: "product_publication_warning_acknowledgement_unavailable" }, 503),
      ),
    factory = createProductPublicationWarningAcknowledgementClient(fetcher),
    abort = new AbortController();
  abort.abort();
  await expect(
    (await factory.prepare(command(), selected)).execute(csrf, abort.signal),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
  await expect((await factory.recover(command(), selected)).execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(
    parseProductPublicationWarningAcknowledgementCommand(command()).expectedProductAggregateVersion,
  ).toBe(7);
});
