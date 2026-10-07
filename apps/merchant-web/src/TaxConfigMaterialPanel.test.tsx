// Controlled HTTP and journal boundary. Rendered production browser/native
// acceptance separately proves IndexedDB, Session/IAM and persistence.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaxConfigMaterialPanel,
  saveTaxConfigRegistrationMaterial,
  finishTaxConfigMaterialOriginal,
  type TaxConfigMaterialFields,
} from "./TaxConfigMaterialPanel.js";
import {
  createTaxConfigMaterialClient,
  parseTaxConfigMaterialCurrent,
  type TaxConfigMaterialCursor,
} from "./tax-config-material-client.js";
import { type TaxConfigMaterialPendingJournal } from "./tax-config-material-pending-journal.js";
import {
  publicationValueDigest as digest,
  canonicalPublicationValue as canonical,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902601-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  csrf = "A".repeat(43);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const fields: TaxConfigMaterialFields = {
  applicability: "NotApplicable",
  sourceIssuedAt: at,
  effectiveFrom: at,
  effectiveUntil: "",
  declaredSourceDigest: "",
};
const source = () => ({
  profile: "TaxRegistrantCurrentSourceV1" as const,
  ...scope,
  businessFunction: "TaxRegistrant" as const,
  effectiveAt: at,
  assignmentReference: id(101),
  assignmentVersion: 1,
  effectiveFrom: at,
  effectiveUntil: null,
  operatingEntityReference: id(102),
  entityVersion: 3,
  operatingEntityProfileVersionReference: id(103),
  profileVersion: 2,
  legalName: "Synthetic TaxRegistrant",
  jurisdictionCode: "CA-ON" as const,
  registrationReference: id(104),
  taxRegistrationReference: null,
  observedAt: at,
  validUntil: until,
  qualification: "NotEvaluated" as const,
});
const empty = () => ({
  profile: "TaxConfigMaterialCurrentV1",
  ...scope,
  materialReference: null,
  materialKind: "RegistrationApplicability",
  version: null,
  observedAt: at,
  validUntil: until,
  qualification: "NotEvaluated",
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
async function fixture(lost = false) {
  let cursor: TaxConfigMaterialCursor | null = null,
    receipt: unknown = null,
    current: unknown = empty(),
    changedSource = false,
    denied = false,
    cleanupFailure = false,
    failRefresh = false,
    absentSource = false,
    previousVersion: string | null = null;
  const events: string[] = [],
    versions = new Map<string, unknown>();
  const journal: TaxConfigMaterialPendingJournal = {
    async load() {
      return cursor;
    },
    async reserve(value) {
      events.push("reserve");
      if (cursor && canonical(cursor) !== canonical(value)) throw Error("different original");
      cursor = value;
    },
    async complete(value, actual, fresh) {
      events.push("complete");
      if (cleanupFailure) throw Error("durable cleanup failed");
      expect(cursor).toEqual(value);
      expect(actual.operationReference).toBe(value.operationReference);
      expect(fresh).not.toHaveProperty("scopeKind");
      cursor = null;
    },
  };
  const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const url = String(path);
    if (url.includes("registrant")) {
      events.push("source");
      if (denied) return response({ error: "tax_config_authoring_denied" }, 403);
      return response(
        absentSource
          ? null
          : {
              ...source(),
              ...(changedSource ? { operatingEntityProfileVersionReference: id(199) } : {}),
            },
      );
    }
    if (url.includes("/version")) {
      const wanted = new URL(url, "http://localhost").searchParams.get("versionReference");
      const version = wanted ? versions.get(wanted) : undefined;
      if (!version) throw Error("missing historical version");
      return response({ ...empty(), materialReference: id(110), version });
    }
    if (url.includes("/current")) {
      events.push("current");
      if (failRefresh) throw Error("network unavailable");
      return response(current);
    }
    if (url.endsWith("/commands")) {
      events.push("dispatch");
      expect(cursor).not.toBeNull();
      const c = JSON.parse(String(init?.body));
      const revision = c.expectedRevision === null ? 1 : c.expectedRevision + 1;
      const version = {
        profile: "TaxConfigMaterialVersionV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        materialReference: c.materialReference ?? id(110),
        versionReference: id(110 + revision),
        revision,
        previousVersionReference: previousVersion,
        materialKind: c.materialKind,
        content: c.content,
        contentDigest: await digest(c.content),
        recordedByActorReference: scope.actorReference,
        createdAt: at,
        recordedAt: at,
        dataClassification: "Confidential",
        status: "Recorded",
        qualification: "NotEvaluated",
      };
      receipt = {
        profile: "TaxConfigMaterialOperationV1",
        ...scope,
        action: c.action,
        operationReference: c.operationReference,
        materialReference: c.materialReference,
        expectedRevision: c.expectedRevision,
        materialKind: c.materialKind,
        command: c,
        intentDigest: await digest({ scope, command: c }),
        outcome: "Committed",
        version,
        auditReference: id(112),
        eventReference: id(113),
        occurredAt: at,
      };
      versions.set(version.versionReference, version);
      previousVersion = version.versionReference;
      current = { ...empty(), materialReference: version.materialReference, version };
      if (lost) throw Error("reply lost after commit");
      return response(receipt);
    }
    if (url.endsWith("/resolve-original")) {
      events.push("resolve");
      if (denied) return response({ error: "tax_config_authoring_denied" }, 403);
      return response(receipt);
    }
    throw Error("unexpected controlled route");
  });
  const client = createTaxConfigMaterialClient(fetcher);
  return {
    client,
    journal,
    events,
    fetcher,
    load: () => cursor,
    changedSource: () => {
      changedSource = true;
    },
    deny: () => {
      denied = true;
    },
    cleanupFails: () => {
      cleanupFailure = true;
    },
    refreshFails: () => {
      failRefresh = true;
    },
    absent: () => {
      absentSource = true;
    },
  };
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
const operation = (
  f: Awaited<ReturnType<typeof fixture>>,
  signal = new AbortController().signal,
) => ({ client: f.client, journal: f.journal, csrf, signal, isCurrent: () => true });
it("reserves original identity before dispatch and refreshes actual committed material before clear", async () => {
  const f = await fixture();
  const result = await saveTaxConfigRegistrationMaterial({
    ...operation(f),
    scope,
    baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
      materialKind: "RegistrationApplicability",
      materialReference: null,
    }),
    expectedSource: source(),
    fields,
    onReserved: vi.fn(),
  });
  expect(result.receipt.outcome).toBe("Committed");
  expect(result.current.version?.content).toMatchObject({
    operatingEntityTaxReference: null,
    applicability: "NotApplicable",
  });
  expect(f.events.indexOf("reserve")).toBeLessThan(f.events.indexOf("dispatch"));
  expect(f.events.at(-2)).toBe("current");
  expect(f.events.at(-1)).toBe("complete");
  expect(f.load()).toBeNull();
});
it("recovers a lost reply without today's registration source and retains a payload-free cursor", async () => {
  const f = await fixture(true);
  await expect(
    saveTaxConfigRegistrationMaterial({
      ...operation(f),
      scope,
      baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
        materialKind: "RegistrationApplicability",
        materialReference: null,
      }),
      expectedSource: source(),
      fields,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const original = f.load();
  if (!original) throw Error("missing original");
  const encoded = JSON.stringify(original);
  expect(encoded).not.toContain("Synthetic TaxRegistrant");
  expect(encoded).not.toContain("sourceIssuedAt");
  expect(encoded).not.toContain("content");
  const reads = f.events.filter((e) => e === "source").length;
  const result = await finishTaxConfigMaterialOriginal({ ...operation(f), cursor: original });
  expect(result.receipt.outcome).toBe("Committed");
  expect(f.events.filter((e) => e === "source")).toHaveLength(reads);
  expect(f.load()).toBeNull();
});
it("denied recovery, failed current refresh and durable cleanup failures keep the exact original", async () => {
  for (const failure of ["deny", "refresh", "cleanup"] as const) {
    const f = await fixture(true);
    await expect(
      saveTaxConfigRegistrationMaterial({
        ...operation(f),
        scope,
        baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
          materialKind: "RegistrationApplicability",
          materialReference: null,
        }),
        expectedSource: source(),
        fields,
        onReserved: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
    const original = f.load();
    if (!original) throw Error("missing original");
    if (failure === "deny") f.deny();
    if (failure === "refresh") f.refreshFails();
    if (failure === "cleanup") f.cleanupFails();
    await expect(
      finishTaxConfigMaterialOriginal({ ...operation(f), cursor: original }),
    ).rejects.toBeDefined();
    expect(f.load()).toEqual(original);
  }
});
it("refuses source drift and absent applicability before reserving a new original", async () => {
  const drift = await fixture();
  drift.changedSource();
  await expect(
    saveTaxConfigRegistrationMaterial({
      ...operation(drift),
      scope,
      baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
        materialKind: "RegistrationApplicability",
        materialReference: null,
      }),
      expectedSource: source(),
      fields,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(drift.load()).toBeNull();
  expect(drift.events).not.toContain("dispatch");
  const missing = await fixture();
  await expect(
    saveTaxConfigRegistrationMaterial({
      ...operation(missing),
      scope,
      baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
        materialKind: "RegistrationApplicability",
        materialReference: null,
      }),
      expectedSource: source(),
      fields: { ...fields, applicability: "" },
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(missing.load()).toBeNull();
});
it("rejects aborted and changed-scope callbacks without dispatching or clearing", async () => {
  const f = await fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(
    saveTaxConfigRegistrationMaterial({
      ...operation(f, controller.signal),
      scope,
      baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
        materialKind: "RegistrationApplicability",
        materialReference: null,
      }),
      expectedSource: source(),
      fields,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.fetcher).not.toHaveBeenCalled();
  await expect(
    saveTaxConfigRegistrationMaterial({
      ...operation(f),
      isCurrent: () => false,
      scope,
      baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
        materialKind: "RegistrationApplicability",
        materialReference: null,
      }),
      expectedSource: source(),
      fields,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.load()).toBeNull();
});
it("renders explicit declaration controls with no source UUID inputs or approval claims", () => {
  const html = renderToStaticMarkup(<TaxConfigMaterialPanel scope={scope} csrf={csrf} />);
  expect(html).toContain("Tax registration materials");
  expect(html).toContain("Declared applicability");
  expect(html).toContain("Source issued at (UTC)");
  expect(html).toContain("Effective from (UTC)");
  expect(html).toContain("Declared source SHA-256 checksum");
  expect(html).toContain("not registration verification or professional approval");
  expect(html).toContain("Save registration material");
  expect(html).toContain("Previous saved version");
  expect(html).not.toContain('aria-label="Profile reference"');
  expect(html).not.toContain('aria-label="Jurisdiction profile reference"');
  expect(html).toContain("exact publication candidate source");
});

it("replaces the selected actual material with explicit revision CAS and a fresh immutable version", async () => {
  const f = await fixture();
  const original = await saveTaxConfigRegistrationMaterial({
    ...operation(f),
    scope,
    baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
      materialKind: "RegistrationApplicability",
      materialReference: null,
    }),
    expectedSource: source(),
    fields,
    onReserved: vi.fn(),
  });
  const replacement = await saveTaxConfigRegistrationMaterial({
    ...operation(f),
    scope,
    baseline: original.current,
    expectedSource: source(),
    fields: { ...fields, applicability: "Applicable" },
    onReserved: vi.fn(),
  });
  expect(replacement.receipt.action).toBe("ReplaceMaterial");
  expect(replacement.receipt.expectedRevision).toBe(1);
  expect(replacement.current.version?.revision).toBe(2);
  expect(replacement.current.version?.previousVersionReference).toBe(
    original.current.version?.versionReference,
  );
  expect(replacement.current.materialReference).toBe(original.current.materialReference);
  expect(f.load()).toBeNull();
  const oldReference = original.current.version?.versionReference;
  if (!oldReference) throw Error("missing previous version");
  const historical = await f.client.version(scope, {
    materialKind: "RegistrationApplicability",
    versionReference: oldReference,
  });
  expect(historical.version).toEqual(original.current.version);
  expect(historical.version?.content).toMatchObject({ applicability: "NotApplicable" });
  expect(replacement.current.version?.content).toMatchObject({ applicability: "Applicable" });
});
it("does not invent registration source pins when the actual source is absent", async () => {
  const f = await fixture();
  f.absent();
  await expect(
    saveTaxConfigRegistrationMaterial({
      ...operation(f),
      scope,
      baseline: parseTaxConfigMaterialCurrent(empty(), scope, {
        materialKind: "RegistrationApplicability",
        materialReference: null,
      }),
      expectedSource: source(),
      fields,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.load()).toBeNull();
  expect(f.events).not.toContain("dispatch");
});
