import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublishedReceiptTemplateSource } from "./published-receipt-template-source.js";
const id = (n: number) => "0190ed16-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T00:00:00.000Z";

// Owner stand-ins: the Store's published binding, the template versions, the authored content
// owner and the two publication proofs (installed release / authored content). The real owners
// are covered by the receipt-template-issuance DB acceptance.
interface Version {
  templateReference: string;
  versionReference: string;
  versionCode: string;
}
const state = vi.hoisted(() => ({
  binding: null as null | Record<string, string>,
  versions: [] as Version[],
  authored: new Map<string, { familyReference: string }>(),
  installed: new Set<string>(),
  content: new Set<string>(),
  calls: [] as unknown[][],
}));
vi.mock("@rms/store", () => ({
  createPostgresStoreReceiptConfigurationSource: () => async () => {
    if (!state.binding) throw new Error("STORE_RECEIPT_CONFIGURATION_UNAVAILABLE");
    return state.binding;
  },
}));
vi.mock("@rms/printing-device", async (original) => {
  const actual = await original<typeof import("@rms/printing-device")>();
  return {
    ...actual,
    createPostgresDigitalReceiptTemplateStore: (o: {
      isCurrentPublication(tx: unknown, v: Version, at: string): Promise<boolean>;
    }) => ({
      resolve: async (tx: unknown, input: { templateReference: string; observedAt: string }) => {
        state.calls.push(["resolve", input.templateReference]);
        const current = [];
        for (const v of state.versions.filter(
          (x) => x.templateReference === input.templateReference,
        ))
          if (await o.isCurrentPublication(tx, v, input.observedAt)) current.push(v);
        if (current.length !== 1)
          throw new actual.DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
        return current[0];
      },
    }),
    createPostgresDigitalReceiptTemplateSubmissionStore: (o: {
      transaction: unknown;
      originalValidUntil: string;
      registerBeforeCommit(tx: unknown, guard: () => Promise<void>, final: () => void): void;
    }) => ({
      readAuthoredContent: async (input: { versionReference: string }) => {
        o.registerBeforeCommit(
          o.transaction,
          async () => {
            state.calls.push(["guard", input.versionReference]);
          },
          () => undefined,
        );
        return state.authored.get(input.versionReference) ?? null;
      },
      assertFinalized: () => o.originalValidUntil,
    }),
    createPostgresInstalledReceiptTemplatePublicationProof:
      () => async (_tx: unknown, v: Version) => {
        state.calls.push(["installed", v.versionReference]);
        return state.installed.has(v.versionReference) ? { version: v } : null;
      },
    createPostgresReceiptTemplateContentPublicationProof:
      (o: {
        familyReference: string;
        readAuthoredContent(tx: unknown, input: Record<string, string>): Promise<unknown>;
      }) =>
      async (tx: unknown, v: Version) => {
        state.calls.push(["content", v.versionReference, o.familyReference]);
        await o.readAuthoredContent(tx, {
          templateReference: v.templateReference,
          versionReference: v.versionReference,
        });
        return state.content.has(v.versionReference) ? { version: v } : null;
      },
  };
});
beforeEach(() => {
  state.binding = null;
  state.versions = [];
  state.authored.clear();
  state.installed.clear();
  state.content.clear();
  state.calls = [];
});
describe("published receipt template source admission", () => {
  it.each([false, true])(
    "rejects denied or foreign-scope input before owner reads (%s)",
    async (allowed) => {
      const source = createPublishedReceiptTemplateSource({
        store: {
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          timeZone: "America/Toronto",
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["STORE_READY"],
          authorize: async () => true,
          hashContent: () => "sha256:" + "a".repeat(64),
        },
        templatePublication: {
          tenantReference: id(1),
          configurationType: "RECEIPT_TEMPLATE",
          purposeCode: "RECEIPT_ISSUANCE",
          authorize: async () => true,
        },
        authorize: async () => allowed,
      });
      const query = vi.fn();
      await expect(
        source(
          { query },
          {
            brandReference: id(2),
            storeReference: allowed ? id(9) : id(3),
            orderReference: id(6),
            receiptReference: id(7),
            observedAt: at,
            freshAfter: at,
            currencyCode: "CAD",
          },
        ),
      ).rejects.toMatchObject({ code: "DIGITAL_RECEIPT_PERMISSION_DENIED" });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("rejects a template publication bound to another Tenant", () => {
    expect(() =>
      createPublishedReceiptTemplateSource({
        store: {
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          timeZone: "America/Toronto",
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["STORE_READY"],
          authorize: async () => true,
          hashContent: () => "sha256:" + "a".repeat(64),
        },
        templatePublication: {
          tenantReference: id(99),
          configurationType: "RECEIPT_TEMPLATE",
          purposeCode: "RECEIPT_ISSUANCE",
          authorize: async () => true,
        },
        authorize: async () => true,
      }),
    ).toThrow("DIGITAL_RECEIPT_INPUT_INVALID");
  });
});

describe("WP-2423: the template the Store's published configuration names", () => {
  const options = () => ({
    store: {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      timeZone: "America/Toronto",
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: ["STORE_READY"],
      authorize: async () => true,
      hashContent: () => "sha256:" + "a".repeat(64),
    },
    templatePublication: {
      tenantReference: id(1),
      configurationType: "RECEIPT_TEMPLATE",
      purposeCode: "RECEIPT_ISSUANCE",
      authorize: async () => true,
    },
    authorize: async () => true,
  });
  const queries: unknown[][] = [];
  const tx = {
    query: async <Row>(sql: string, values: readonly unknown[]) => {
      queries.push([sql, values]);
      return { rowCount: 1, rows: [{ lock: "0", statement: "0" }] as unknown as Row[] };
    },
  };
  const request = {
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(6),
    receiptReference: id(7),
    observedAt: at,
    freshAfter: at,
    currencyCode: "CAD",
  };
  const bind = (templateReference: string) => {
    state.binding = {
      templateReference,
      locale: "en-CA",
      currencyCode: "CAD",
      configurationReference: id(30),
    };
  };
  const installed = {
    templateReference: id(10),
    versionReference: id(11),
    versionCode: "RECEIPT_V1",
  };
  const oldAuthored = {
    templateReference: id(20),
    versionReference: id(21),
    versionCode: "RECEIPT_1",
  };
  const authored = {
    templateReference: id(20),
    versionReference: id(22),
    versionCode: "RECEIPT_2",
  };
  beforeEach(() => {
    queries.length = 0;
    state.versions = [installed, oldAuthored, authored];
    state.installed.add(installed.versionReference);
    state.authored.set(oldAuthored.versionReference, { familyReference: id(40) });
    state.authored.set(authored.versionReference, { familyReference: id(40) });
    state.content.add(authored.versionReference);
  });

  it("issues with the installed template by its release when the Store names it", async () => {
    bind(installed.templateReference);
    const result = await createPublishedReceiptTemplateSource(options())(tx, request);
    expect(result.template).toEqual({
      brandReference: id(2),
      storeReference: id(3),
      locale: "en-CA",
      version: "RECEIPT_V1",
      versionReference: installed.versionReference,
    });
    expect(result.evidenceReference).toBe(installed.versionReference);
    expect(state.calls).toEqual([
      ["resolve", installed.templateReference],
      ["installed", installed.versionReference],
      ["guard", installed.versionReference],
    ]);
    // The owner reads' statement limits are put back for the rest of the caller transaction.
    expect(queries.at(-1)).toEqual([
      expect.stringContaining("set_config('lock_timeout'"),
      ["0", "0"],
    ]);
  });

  it("issues with a template written in the product by its authored content proof, current version only", async () => {
    bind(authored.templateReference);
    const result = await createPublishedReceiptTemplateSource(options())(tx, request);
    expect(result.template.version).toBe("RECEIPT_2");
    expect(result.template.versionReference).toBe(authored.versionReference);
    expect(state.calls).toEqual([
      ["resolve", authored.templateReference],
      ["content", oldAuthored.versionReference, id(40)],
      ["content", authored.versionReference, id(40)],
      ["guard", oldAuthored.versionReference],
      ["guard", authored.versionReference],
    ]);
  });

  it("refuses with a plain reason (and reports it) when the named template cannot be proven", async () => {
    bind(authored.templateReference);
    state.content.clear();
    const source = createPublishedReceiptTemplateSource(options());
    await expect(source(tx, request)).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE",
    });
    await expect(source.readiness(tx, at)).resolves.toEqual({
      ready: false,
      reason: "TemplateNotProven",
    });
    // Never falls back to another (e.g. the installed) template.
    expect(state.calls.some((c) => c[0] === "installed")).toBe(false);
  });

  it("refuses when the Store's published configuration cannot be read, and reports it", async () => {
    const source = createPublishedReceiptTemplateSource(options());
    await expect(source(tx, request)).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE",
    });
    await expect(source.readiness(tx, at)).resolves.toEqual({
      ready: false,
      reason: "StoreConfigurationUnavailable",
    });
  });

  it("reports ready with the template version it would use", async () => {
    bind(installed.templateReference);
    await expect(
      createPublishedReceiptTemplateSource(options()).readiness(tx, at),
    ).resolves.toEqual({
      ready: true,
      templateReference: installed.templateReference,
      versionReference: installed.versionReference,
      versionCode: "RECEIPT_V1",
    });
  });
});
