import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantBrandCatalogSourceClient,
  type PreparedBrandCatalogSource,
} from "./merchant-brand-catalog-source-client.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  csrf = "c".repeat(43);
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const prepare = (operationReference = id(4)) =>
  createMerchantBrandCatalogSourceClient().prepare(scope, {
    operationReference,
    code: " menu ",
    label: " Catalogue ",
  });
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function source(p: PreparedBrandCatalogSource) {
  return {
    profile: "BrandCatalogSourceRegisteredIdentityV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    sourceReference: id(5),
    code: p.command.code,
    label: p.command.label,
    registeredByReference: scope.actorReference,
    operationReference: p.command.operationReference,
    auditReference: id(6),
    registeredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
}
function packet(value: unknown = null, reader = scope) {
  return {
    profile: "BrandCatalogSourceCurrentV1",
    ...reader,
    source: value,
    observedAt: at,
    validUntil: until,
    publicationStatus: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
  };
}
function terminal(p: PreparedBrandCatalogSource, abandoned = false) {
  return {
    profile: "BrandCatalogSourceReceiptV1",
    ...scope,
    operationReference: p.cursor.operationReference,
    intentDigest: p.cursor.intentDigest,
    outcome: abandoned ? "Abandoned" : "Committed",
    originalCommand: abandoned ? null : p.command,
    source: abandoned ? null : source(p),
    auditReference: id(6),
    occurredAt: at,
  };
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrandCatalogSourcePanel,
  executeBrandCatalogSourceOriginal,
  finishBrandCatalogSourceOriginal,
} from "./BrandCatalogSourcePanel.js";
import { canonicalPublicationValue as canonical } from "./product-publication-command-client-v2.js";
import type { BrandCatalogSourceResolve } from "./merchant-brand-catalog-source-client.js";
function journal() {
  let cursor: BrandCatalogSourceResolve | null = null;
  const events: string[] = [];
  return {
    events,
    get cursor() {
      return cursor;
    },
    port: {
      load: vi.fn(async () => cursor),
      reserve: vi.fn(async (value: BrandCatalogSourceResolve) => {
        events.push("reserve");
        if (cursor && canonical(cursor) !== canonical(value)) throw new Error("competing original");
        cursor = value;
      }),
      complete: vi.fn(async () => {
        events.push("complete");
        cursor = null;
      }),
    },
  };
}
async function ledger() {
  const p = await prepare(),
    paths: string[] = [],
    j = journal();
  let lose = false,
    registered = false;
  const client = createMerchantBrandCatalogSourceClient(async (url, init) => {
    const path = String(url).split("/").pop();
    if (!path) throw new Error("missing route");
    paths.push(path);
    const input = JSON.parse(String(init?.body));
    if (path === "register") {
      expect(input.command.operationReference).toBe(p.cursor.operationReference);
      registered = true;
      if (lose) throw new Error("controlled lost response");
      return response(terminal(p));
    }
    if (path === "resolve") return response(terminal(p, !registered));
    if (path === "exact")
      return response({
        ...packet(source(p)),
        profile: "BrandCatalogSourceExactV1",
        requestedSourceReference: id(5),
      });
    return response(packet(registered ? source(p) : null));
  });
  const base = {
    client,
    journal: j.port,
    scope,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  return {
    p,
    paths,
    j,
    client,
    base,
    lose: () => {
      lose = true;
    },
  };
}
it("reserves before execution and reobserves current plus exact before clearing", async () => {
  const f = await ledger();
  const result = await executeBrandCatalogSourceOriginal({
    ...f.base,
    prepared: f.p,
    canDispatch: () => true,
    onReserved: () => {
      expect(f.paths).toEqual([]);
    },
  });
  expect(result.receipt.outcome).toBe("Committed");
  expect(f.j.events).toEqual(["reserve", "complete"]);
  expect(f.paths).toEqual(["register", "current", "exact"]);
  expect(f.j.cursor).toBeNull();
});
it("recovers a lost response after reload using the same scalar original without resending", async () => {
  const f = await ledger();
  f.lose();
  await expect(
    executeBrandCatalogSourceOriginal({
      ...f.base,
      prepared: f.p,
      canDispatch: () => true,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(f.j.cursor).toEqual(f.p.cursor);
  const loaded = await f.j.port.load();
  if (!loaded) throw new Error("lost pending");
  await finishBrandCatalogSourceOriginal({ ...f.base, cursor: loaded });
  expect(f.paths).toEqual(["register", "resolve", "current", "exact"]);
  expect(f.j.cursor).toBeNull();
});
it("recovers Abandoned with fresh current and no invented exact source", async () => {
  const f = await ledger();
  await f.j.port.reserve(f.p.cursor);
  const result = await finishBrandCatalogSourceOriginal({ ...f.base, cursor: f.p.cursor });
  expect(result.receipt.outcome).toBe("Abandoned");
  expect(f.paths).toEqual(["resolve", "current"]);
  expect(f.j.cursor).toBeNull();
});
it("preserves an original when asynchronous reserve finishes after edits, permission withdrawal or scope change", async () => {
  for (const boundary of ["Edit", "Scope"]) {
    const f = await ledger();
    let current = true,
      allowed = true;
    const reserve = f.j.port.reserve;
    f.j.port.reserve = vi.fn(async (value: BrandCatalogSourceResolve) => {
      await reserve(value);
      if (boundary === "Scope") current = false;
      else allowed = false;
    });
    await expect(
      executeBrandCatalogSourceOriginal({
        ...f.base,
        prepared: f.p,
        isCurrent: () => current,
        canDispatch: () => allowed,
        onReserved: () => undefined,
      }),
    ).rejects.toThrow();
    expect(f.j.cursor).toEqual(f.p.cursor);
    expect(f.paths).toEqual([]);
    expect(f.j.port.complete).not.toHaveBeenCalled();
  }
});
it("detects a competing tab replacement after reserve and retains failed refresh originals", async () => {
  const f = await ledger();
  f.j.port.load.mockResolvedValue({ ...f.p.cursor, operationReference: id(9) });
  await expect(
    executeBrandCatalogSourceOriginal({
      ...f.base,
      prepared: f.p,
      canDispatch: () => true,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(f.paths).toEqual([]);
  expect(f.j.port.complete).not.toHaveBeenCalled();
  const failed = await ledger();
  await failed.j.port.reserve(failed.p.cursor);
  const current = vi.fn(async () => {
    throw new Error("offline current");
  });
  await expect(
    finishBrandCatalogSourceOriginal({
      ...failed.base,
      client: { ...failed.client, current },
      cursor: failed.p.cursor,
    }),
  ).rejects.toThrow();
  expect(failed.j.cursor).toEqual(failed.p.cursor);
  expect(failed.j.port.complete).not.toHaveBeenCalled();
});
it("renders registration and recovery without raw reference identifiers or positive qualification", () => {
  const html = renderToStaticMarkup(
    <BrandCatalogSourcePanel scope={scope} csrf={csrf} freshDisabled />,
  );
  expect(html).toContain("Catalogue source");
  expect(html).toContain("Recover registration");
  expect(html).toContain("have not been evaluated");
  expect(html).not.toContain(scope.brandReference);
  expect(html).not.toContain(scope.actorReference);
  expect(html).not.toContain(csrf);
  expect(html).toMatch(/disabled/);
});
