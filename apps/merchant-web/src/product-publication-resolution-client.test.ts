import { expect, it, vi } from "vitest";
import {
  createProductPublicationResolutionClient,
  type ProductPublicationOriginalKind,
} from "./product-publication-resolution-client.js";
import {
  at,
  command,
  csrf,
  digest,
  id,
  response,
  scope,
} from "./product-publication-v2-test-fixtures.js";
import { parseProductPublicationUserCommand } from "./product-publication-command-client.js";
import { parseProductPublicationUserCommandV2 } from "./product-publication-command-client-v2.js";
import { parseProductPublicationWarningAcknowledgementCommand } from "./product-publication-warning-acknowledgement-client.js";

async function fixture(kind: ProductPublicationOriginalKind = "PublicationV2") {
  const v2 = await parseProductPublicationUserCommandV2(command());
  const { profile, replacementIntent, replacementIntentDigest, ...legacy } = v2;
  void profile;
  void replacementIntent;
  void replacementIntentDigest;
  const originalCommand =
    kind === "PublicationV1"
      ? parseProductPublicationUserCommand(legacy)
      : kind === "PublicationV2"
        ? v2
        : parseProductPublicationWarningAcknowledgementCommand({
            profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
            action: "AcknowledgeProductPublicationWarnings",
            operationReference: id(80),
            productReference: scope.productReference,
            versionReference: v2.versionReference,
            expectedProductAggregateVersion: 7,
            reportOperationReference: id(81),
            reportDigest: digest("report"),
            warningBindingDigest: digest("warnings"),
            warningCodes: ["ChangeImpact"],
            reasonCode: "REVIEWED_REFERENCES",
            occurredAt: at,
          });
  const input = { originalKind: kind, originalCommand, scope, csrf };
  const body = {
    profile: "CatalogProductPublicationResolutionResultV1",
    outcome: "Abandoned",
    originalKind: kind,
    ...scope,
    operationReference: originalCommand.operationReference,
    versionReference: originalCommand.versionReference,
    originalCommandDigest: digest(originalCommand),
    originalIntentDigest: digest("server original"),
    recordedAt: at,
    resolutionDigest: digest("server resolution"),
    currentAggregateVersion: 12,
  };
  return { input, body };
}
it.each(["PublicationV1", "PublicationV2", "WarningAcknowledgementV1"] as const)(
  "resolves exact original %s independently of the obsolete expected root",
  async (kind) => {
    const { input, body } = await fixture(kind),
      fetcher = vi.fn<typeof fetch>(async () => response(body));
    const result = await createProductPublicationResolutionClient(fetcher).resolve(input);
    expect(result).toEqual(body);
    const call = fetcher.mock.calls[0];
    if (!call) throw Error("Missing controlled resolution request");
    const [url, init] = call;
    expect(url).toBe("/merchant/catalog/products/publication/resolve/v1");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      profile: "CatalogProductPublicationResolutionCommandV1",
      originalKind: kind,
      originalCommand: input.originalCommand,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("x-bop-csrf")).toBe(csrf);
    expect(JSON.parse(atob(headers.get("x-bop-catalog-scope") ?? ""))).toEqual({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    });
  },
);
it("accepts Committed without executing or reconstructing the original command result", async () => {
  const { input, body } = await fixture(),
    fetcher = vi.fn<typeof fetch>(async () => response({ ...body, outcome: "Committed" }));
  expect((await createProductPublicationResolutionClient(fetcher).resolve(input)).outcome).toBe(
    "Committed",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { outcome: "Absent" },
  { originalKind: "PublicationV1" },
  { originalCommandDigest: digest("different") },
  { tenantReference: id(98) },
  { brandReference: id(98) },
  { storeReference: id(98) },
  { productReference: id(98) },
  { versionReference: id(98) },
  { operationReference: id(98) },
  { currentAggregateVersion: 0 },
  { currentAggregateVersion: 2147483648 },
  { extra: true },
])("does not deliver terminal evidence for a mismatched result %j", async (patch) => {
  const { input, body } = await fixture();
  await expect(
    createProductPublicationResolutionClient(async () => response({ ...body, ...patch })).resolve(
      input,
    ),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it.each([400, 401, 403, 404, 409, 503])("keeps HTTP %s uncertain", async (status) => {
  const { input } = await fixture();
  await expect(
    createProductPublicationResolutionClient(async () =>
      response({ error: "request_denied" }, status),
    ).resolve(input),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("repeats the identical resolution request after a lost terminal reply", async () => {
  const { input, body } = await fixture(),
    bodies: string[] = [];
  const client = createProductPublicationResolutionClient(async (_, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw Error("lost terminal response");
    return response(body);
  });
  await expect(client.resolve(input)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(client.resolve(input)).resolves.toEqual(body);
  expect(bodies[0]).toBe(bodies[1]);
});
it("aborts even when the transport ignores cancellation", async () => {
  const { input } = await fixture(),
    controller = new AbortController();
  let sent!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const client = createProductPublicationResolutionClient(async () => {
    sent();
    return new Promise(() => undefined);
  });
  const attempt = client.resolve(input, controller.signal);
  await dispatched;
  controller.abort();
  await expect(attempt).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("rejects unsupported kind and client-supplied authority before dispatch", async () => {
  const { input } = await fixture(),
    fetcher = vi.fn<typeof fetch>();
  await expect(
    createProductPublicationResolutionClient(fetcher).resolve({
      ...input,
      originalCommand: { ...input.originalCommand, actorReference: id(98) },
    }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});
