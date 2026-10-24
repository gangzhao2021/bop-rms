// Synthetic transport exercises real public browser parsing; not native IAM evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  parseStoreSetupReferenceContent as owningContent,
  parseStoreSetupReferenceVersion as owningVersion,
} from "../../../packages/rms/store/src/contracts/store-setup-reference.js";
import {
  createStoreSetupReferenceClient,
  parseStoreSetupReferenceContent,
  parseStoreSetupReferenceSnapshot,
  parseStoreSetupReferencesCurrent,
  validateStoreSetupReferenceReceipt,
  type PreparedStoreSetupReference,
} from "./store-setup-reference-client.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  csrf = "A".repeat(43);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const address = () => ({
  countryCode: "CA",
  regionCode: "ON",
  locality: "Toronto",
  postalCode: "M5V 1A1",
  addressLines: ["100 Synthetic Street"],
});
const contact = () => ({
  contactName: "Synthetic Contact",
  businessPhone: "+14165550100",
  website: "https://example.test/",
});
function snapshot() {
  return {
    profile: "StoreSetupReferenceVersionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    kind: "Address",
    reference: id(6),
    revision: 1,
    authoredByReference: id(4),
    previousReference: null,
    content: address(),
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  };
}
function current() {
  return {
    profile: "StoreSetupReferencesCurrentV1",
    ...scope,
    address: null,
    contact: null,
    observedAt: at,
    validUntil: until,
    businessReferenceValidation: "NotEvaluated",
  };
}
const prepare = () => ({
  expectedScope: scope,
  kind: "Address" as const,
  operationReference: id(5),
  expectedReference: null,
  expectedRevision: 0,
  content: address(),
});
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function receipt(p: PreparedStoreSetupReference) {
  return {
    profile: "StoreSetupReferenceReceiptV1",
    ...scope,
    kind: p.cursor.kind,
    operationReference: p.cursor.operationReference,
    intentDigest: p.intentDigest,
    expectedReference: null,
    expectedRevision: 0,
    outcome: "Committed",
    snapshot: snapshot(),
    auditReference: id(7),
    occurredAt: at,
  };
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it("browser content and snapshots agree with owning closed public constructors", () => {
  expect(parseStoreSetupReferenceContent("Address", address())).toEqual(
    owningContent("Address", address()),
  );
  expect(parseStoreSetupReferenceContent("Contact", contact())).toEqual(
    owningContent("Contact", contact()),
  );
  expect(parseStoreSetupReferenceSnapshot(snapshot())).toEqual(owningVersion(snapshot()));
});
it("initial GET obtains actual scope without invented Actor IDs and checks fullscope when known", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(current()));
  const client = createStoreSetupReferenceClient(fetcher);
  expect((await client.load({ storeReference: id(3) })).actorReference).toBe(id(4));
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `/merchant/store-setup/references?storeReference=${id(3)}`,
  );
  await expect(
    createStoreSetupReferenceClient(
      vi.fn<typeof fetch>().mockResolvedValue(response({ ...current(), actorReference: id(9) })),
    ).load({ storeReference: id(3), expectedScope: scope }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("Save sends exactly five body fields and the dedicated scope4 header, preserving immutable original digest", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = createStoreSetupReferenceClient(fetcher),
    p = await client.prepare(prepare());
  fetcher.mockResolvedValue(response(receipt(p)));
  expect(await client.execute(p, { csrf })).toMatchObject({ outcome: "Committed" });
  const init = fetcher.mock.calls[0]?.[1];
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/store-setup/references/address");
  expect(JSON.parse(String(init?.body))).toEqual({
    command: "SaveReference",
    operationReference: id(5),
    expectedReference: null,
    expectedRevision: 0,
    content: address(),
  });
  const headers = init?.headers as Record<string, string>;
  const encodedScope = headers["X-BOP-Store-Setup-Scope"];
  if (typeof encodedScope !== "string") throw new Error("Expected dedicated scope header");
  expect(atob(encodedScope.replace(/-/gu, "+").replace(/_/gu, "/"))).toBe(canonical(scope));
  expect(headers["X-BOP-CSRF"]).toBe(csrf);
  expect(Object.isFrozen(p.command.content)).toBe(true);
});
it("Resolve sends no contact/address content and reconstructs exact original terminal hash", async () => {
  const f = vi.fn<typeof fetch>(),
    c = createStoreSetupReferenceClient(f),
    p = await c.prepare(prepare());
  f.mockResolvedValue(response(receipt(p)));
  await c.resolve(p.cursor, { csrf });
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
    command: "ResolveOriginal",
    operationReference: id(5),
    expectedReference: null,
    expectedRevision: 0,
    intentDigest: p.intentDigest,
  });
  await expect(
    validateStoreSetupReferenceReceipt(
      {
        ...receipt(p),
        snapshot: { ...snapshot(), content: { ...address(), locality: "Changed" } },
      },
      p.cursor,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it.each([
  [403, "Denied"],
  [409, "Conflict"],
  [400, "Invalid"],
  [503, "OutcomeUnknown"],
])("retains explicit finite POST status %s", async (status, code) => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(response({}, Number(status))),
    c = createStoreSetupReferenceClient(f),
    p = await c.prepare(prepare());
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code });
});
it("aborted sent save is unknown and never silently retries", async () => {
  const f = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic network")),
    c = createStoreSetupReferenceClient(f),
    p = await c.prepare(prepare());
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(f).toHaveBeenCalledTimes(1);
});
it("invalid source/lease/extra fields and content accessors are refused", () => {
  expect(() =>
    parseStoreSetupReferencesCurrent(
      { ...current(), validUntil: "2026-10-05T10:00:05.001Z" },
      id(3),
    ),
  ).toThrow();
  expect(() =>
    parseStoreSetupReferencesCurrent(
      {
        ...current(),
        address: { ...snapshot(), authoredByReference: id(9), storeReference: id(10) },
      },
      id(3),
    ),
  ).toThrow();
  let called = false;
  const v = { ...contact() };
  Object.defineProperty(v, "website", {
    enumerable: true,
    get: () => {
      called = true;
      return null;
    },
  });
  expect(() => parseStoreSetupReferenceContent("Contact", v)).toThrow();
  expect(called).toBe(false);
  expect(() =>
    parseStoreSetupReferenceContent("Contact", {
      ...contact(),
      email: "not-retained@example.test",
    }),
  ).toThrow();
});
it("returns stale instead of permitting an expired current packet", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(
    createStoreSetupReferenceClient(
      vi.fn<typeof fetch>().mockResolvedValue(response(current())),
    ).load({ storeReference: id(3) }),
  ).rejects.toMatchObject({ code: "Stale" });
});
it("changed scope rejects a late GET result", async () => {
  let finish: (v: Response) => void = () => undefined;
  const f = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      )
      .mockResolvedValueOnce(response({ ...current(), storeReference: id(9) })),
    c = createStoreSetupReferenceClient(f);
  const old = c.load({ storeReference: id(3) });
  await c.load({ storeReference: id(9) });
  finish(response(current()));
  await expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("rejects over-budget streamed response without trusting success status", async () => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(response({ payload: "x".repeat(65537) }));
  await expect(
    createStoreSetupReferenceClient(f).load({ storeReference: id(3) }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
