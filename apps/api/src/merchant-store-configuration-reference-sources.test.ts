import {
  tenantBrandConfigurationRequiredFields,
  type TenantStoreBrandConfigurationContentSourceOptions,
} from "@bop/tenant";
import { beforeEach, expect, it, vi } from "vitest";
import { parseStoreSetupReferenceVersion, type StoreSetupReferenceStoreOptions } from "@rms/store";
import {
  parseStorePaymentConfigurationVersion,
  type StorePaymentConfigurationStoreOptions,
} from "@rms/payment";
import {
  createDigitalReceiptTemplateDraftContent,
  materializeDigitalReceiptTemplateContent,
  type DigitalReceiptTemplateSubmissionStoreOptions,
} from "@rms/printing-device";
import {
  createMerchantStoreConfigurationReferenceSources,
  type MerchantStoreConfigurationReferenceSourcesOptions,
} from "./merchant-store-configuration-reference-sources.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  reference: vi.fn(),
  payment: vi.fn(),
  submission: vi.fn(),
  receipt: vi.fn(),
  proof: vi.fn(),
  publishing: vi.fn(),
  brand: vi.fn(),
  brandScope: vi.fn(),
  currentBrand: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPostgresStoreSetupReferenceStore: mocks.reference,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresStorePaymentConfigurationStore: mocks.payment,
}));
vi.mock("@rms/printing-device", async (original) => ({
  ...(await original<typeof import("@rms/printing-device")>()),
  createPostgresDigitalReceiptTemplateSubmissionStore: mocks.submission,
  createPostgresDigitalReceiptTemplateStore: mocks.receipt,
  createPostgresReceiptTemplateContentPublicationProof: mocks.proof,
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: mocks.publishing,
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.brandScope }));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresTenantStoreBrandConfigurationContentSource: mocks.brand,
}));
vi.mock("./current-brand-configuration-content.js", () => ({
  createCurrentStoreBrandConfigurationContentSource: mocks.currentBrand,
}));
const id = (n: number) => `01902421-2001-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T15:00:00.000Z",
  until = "2026-10-06T15:00:05.000Z";
const fixed = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
beforeEach(() => vi.resetAllMocks());
/** Controlled public-owner boundaries and Session/IAM boundary. Public content
 * constructors are real; these tests do not claim native SQL or legal readiness. */
function fixture() {
  const state = {
    clock: at,
    until,
    allow: true,
    actor: id(4),
    release: id(18),
    missing: false,
    childDrift: false,
    brandAllow: true,
    brandRelease: true,
  };
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [],
    after: (() => unknown)[] = [],
    events: string[] = [];
  const scope = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3), locale: "fr-CA", currencyCode: "CAD" },
    actorReference: id(4),
    sessionReference: id(5),
    allowed: async () => state.allow,
    authorizationValidUntil: () => state.until,
    authorizeAction: async () =>
      Object.freeze({
        effect: state.allow ? "Allow" : "Deny",
        action: "organization.manage",
        scopeKind: "Store",
      }),
  };
  mocks.scope.mockImplementation(async (_tx, _cookie, action, session) => {
    expect(action).toBe("organization.manage");
    expect(session).toBe(id(5));
    return { ...scope, actorReference: state.actor };
  });
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const host = {
    registerBeforeCommit: vi.fn(async (actual, guard, final) => {
      expect(actual).toBe(tx);
      hooks.push({ guard, final });
      events.push("register");
    }),
    registerAfterCommit: vi.fn((actual, pure) => {
      expect(actual).toBe(tx);
      after.push(pure);
    }),
  };
  const addresses = new Map<string, ReturnType<typeof parseStoreSetupReferenceVersion>>();
  for (const kind of ["Address", "Contact"] as const) {
    const reference = kind === "Address" ? id(10) : id(11);
    addresses.set(
      reference,
      parseStoreSetupReferenceVersion({
        profile: "StoreSetupReferenceVersionV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        kind,
        reference,
        revision: 1,
        authoredByReference: id(9),
        previousReference: null,
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
        content:
          kind === "Address"
            ? {
                countryCode: "CA",
                regionCode: "ON",
                locality: "Synthetic locality",
                postalCode: "A1A 1A1",
                addressLines: ["1 Synthetic Way"],
              }
            : { contactName: "Synthetic contact", businessPhone: "+14165550100", website: null },
      }),
    );
  }
  const payment = parseStorePaymentConfigurationVersion({
    profile: "StorePaymentConfigurationV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationReference: id(12),
    revision: 1,
    authoredByReference: id(9),
    previousConfigurationReference: null,
    currencyCode: "CAD",
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
    content: {
      customerOnlineCardEnabled: false,
      staffTerminalCardPresentEnabled: false,
      staffTerminalInteracEnabled: false,
    },
  });
  const readOnlyOwner = <
    O extends StoreSetupReferenceStoreOptions | StorePaymentConfigurationStoreOptions,
  >(
    o: O,
    hold: () => Promise<unknown>,
  ) => {
    let registered = false,
      final = false;
    return {
      enter: async () => {
        if (!registered) {
          registered = true;
          await o.registerBeforeCommit(
            tx,
            async () => {
              events.push("child guard");
              await hold();
              if (state.childDrift) throw new Error("Controlled immutable source drift");
            },
            () => {
              o.clock.now();
              final = true;
            },
          );
        }
        await hold();
      },
      assertFinalized: (actual: unknown) => {
        expect(actual).toBe(tx);
        if (!final) throw new Error("Missing final");
        return state.until;
      },
    };
  };
  mocks.reference.mockImplementation((o: StoreSetupReferenceStoreOptions) => {
    let kind: "Address" | "Contact" = "Address";
    const child = readOnlyOwner(o, () =>
      o.authority.holdUntilTransactionCompletes(tx, {
        ...fixed,
        permission: "organization.manage",
        purposeCode: "STORE_SETUP_REFERENCE",
        mode: "ReadVersion",
        kind,
        requiredFields: requireFieldsReference,
        command: null,
        observedAt: o.clock.now(),
        validUntil: o.originalValidUntil,
      }),
    );
    return {
      readVersion: async (p: { kind: "Address" | "Contact"; reference: string }) => {
        kind = p.kind;
        await child.enter();
        events.push("reference " + p.reference);
        return state.missing ? null : (addresses.get(p.reference) ?? null);
      },
      assertFinalized: child.assertFinalized,
    };
  });
  mocks.payment.mockImplementation((o: StorePaymentConfigurationStoreOptions) => {
    const child = readOnlyOwner(o, () =>
      o.authority.holdUntilTransactionCompletes(tx, {
        ...fixed,
        currencyCode: "CAD",
        permission: "organization.manage",
        purposeCode: "STORE_PAYMENT_CONFIGURATION",
        mode: "ReadVersion",
        requiredFields: requireFieldsPayment,
        command: null,
        configurationReference: id(12),
        observedAt: o.clock.now(),
        validUntil: o.originalValidUntil,
      }),
    );
    return {
      readVersion: async (ref: string) => {
        expect(ref).toBe(id(12));
        await child.enter();
        return state.missing ? null : payment;
      },
      assertFinalized: child.assertFinalized,
    };
  });
  const content = createDigitalReceiptTemplateDraftContent({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(15),
    versionReference: id(16),
    versionNumber: 1,
    fields: {
      locale: "fr-CA",
      layoutDefinitionReference: id(20),
      complianceRuleReference: id(21),
      activation: { mode: "Immediate" },
      effectiveUntil: null,
    },
  });
  const version = materializeDigitalReceiptTemplateContent({
    content,
    publicationReference: id(18),
    publishedAt: at,
  });
  const authored = {
    profile: "DigitalReceiptTemplateAuthoredContentV2" as const,
    content,
    authoredByReference: id(9),
    submittedByReference: id(9),
    familyReference: id(22),
    reviewLifecycleReference: id(23),
    reviewVersion: 2,
  };
  mocks.submission.mockImplementation((o: DigitalReceiptTemplateSubmissionStoreOptions) => {
    let finalized = false;
    const hold = () =>
      o.authority.holdUntilTransactionCompletes(tx, {
        ...fixed,
        permission: "organization.manage",
        purposeCode: "RECEIPT_TEMPLATE_SUBMISSION",
        mode: "ReadAuthoredContent",
        requiredFields: requireFieldsSubmission,
        command: null,
        templateReference: id(15),
        versionReference: id(16),
        observedAt: o.clock.now(),
        validUntil: o.originalValidUntil,
      });
    return {
      readAuthoredContent: async () => {
        await o.registerBeforeCommit(
          tx,
          async () => {
            await hold();
          },
          () => {
            finalized = true;
          },
        );
        await hold();
        return state.missing ? null : authored;
      },
      assertFinalized: () => {
        if (!finalized) throw new Error("Missing final");
        return state.until;
      },
    };
  });
  mocks.publishing.mockReturnValue({
    resolveCurrentRelease: async () => ({ release: { releaseId: state.release } }),
  });
  mocks.proof.mockImplementation(
    () => async () => Object.freeze({ recordedIndependence: "Verified" }),
  );
  mocks.receipt.mockImplementation(
    (
      o: Parameters<
        typeof import("@rms/printing-device").createPostgresDigitalReceiptTemplateStore
      >[0],
    ) => ({
      resolve: async (
        actual: Parameters<typeof o.authorize>[0],
        p: { templateReference: string; locale: string; observedAt: string },
      ) => {
        await actual.query("SELECT controlled_device_transport", []);
        await o.authorize(actual, {
          brandReference: id(2),
          storeReference: id(3),
          templateReference: p.templateReference,
          action: "Read",
        });
        expect(p.locale).toBe("fr-CA");
        if (
          p.templateReference !== id(15) ||
          !(await o.isCurrentPublication(actual, version, p.observedAt))
        )
          throw new Error("Controlled published source unavailable");
        return version;
      },
    }),
  );
  mocks.brandScope.mockImplementation(async () => ({
    tenantReference: id(1),
    selectedStoreReference: id(3),
    context: { brand: { brandReference: id(2) } },
    actorReference: id(4),
    authorizeActionsWithValidity: async () => ({
      validUntil: state.until,
      decisions: [
        Object.freeze({
          effect: state.brandAllow ? "Allow" : "Deny",
          action: "organization.manage",
          scopeKind: "Brand",
        }),
      ],
    }),
  }));
  mocks.brand.mockImplementation((o: TenantStoreBrandConfigurationContentSourceOptions) => ({
    withRecordedConfiguration: async (
      r: Parameters<TenantStoreBrandConfigurationContentSourceOptions["authority"]["isCurrent"]>[1],
      work: (
        value: unknown,
        actual: MerchantStoreConfigurationReferenceSourcesOptions["transaction"],
      ) => Promise<unknown>,
    ) =>
      o.authority.withCurrentContentRead(r, tenantBrandConfigurationRequiredFields, () =>
        o.transactions.run(async (actual) => {
          await o.authority.isCurrent(actual, r, tenantBrandConfigurationRequiredFields);
          return work({ request: r }, tx);
        }),
      ),
  }));
  mocks.currentBrand.mockImplementation(
    (
      recorded: ReturnType<
        typeof import("@bop/tenant").createPostgresTenantStoreBrandConfigurationContentSource
      >,
    ) => ({
      withCurrentContent: async (
        r: Parameters<typeof recorded.withRecordedConfiguration>[0],
        work: (
          value: unknown,
          actual: MerchantStoreConfigurationReferenceSourcesOptions["transaction"],
        ) => Promise<unknown>,
      ) =>
        recorded.withRecordedConfiguration(r, async (_value, actual) => {
          if (!state.brandRelease) throw new Error("Controlled actual Brand release unavailable");
          return work(
            Object.freeze({
              profile: "CurrentBrandConfigurationContentV1",
              tenantReference: id(1),
              brandReference: id(2),
              brandVersion: 1,
              configurationVersionReference: r.configurationVersionReference,
              configurationVersion: 1,
              contentDigest: "sha256:" + "b".repeat(64),
              originalPublicationReference: id(31),
              currentPublicationReference: id(31),
              defaultLocale: "fr-CA",
              supportedLocales: ["fr-CA"],
              overrideAllowedFieldCodes: [],
              hardRequirementFieldCodes: [],
              catalogSourceReference: id(32),
              platformTemplateReference: id(33),
              effectiveFrom: at,
              effectiveUntil: null,
              originalIntentDigest: r.originalIntentDigest,
              observedAt: r.observedAt,
              validUntil: r.validUntil,
              eligibility: "NotEvaluated",
            }),
            actual,
          );
        }),
    }),
  );
  const options = {
    persistence: {
      now: () => state.clock,
      identity: { hasher: {} },
      currentActor: () => {
        throw new Error("UNEXPECTED_CONTROLLED_SESSION_SOURCE");
      },
      validateAssociation: () => {
        throw new Error("UNEXPECTED_CONTROLLED_ASSOCIATION_SOURCE");
      },
    },
    sessionCookie: "synthetic",
    transaction: tx,
    scope,
    sourceHost: host,
    originalObservedAt: at,
    originalValidUntil: until,
  } as unknown as MerchantStoreConfigurationReferenceSourcesOptions;
  const source = createMerchantStoreConfigurationReferenceSources(options);
  const finish = async () => {
    for (const h of hooks) await h.guard();
    for (const h of hooks) expect(h.final()).toBeUndefined();
    for (const fn of after) expect(fn()).toBeUndefined();
  };
  return {
    state,
    scope,
    tx,
    host,
    hooks,
    after,
    events,
    addresses,
    payment,
    version,
    source,
    options,
    finish,
  };
}
import { storeSetupReferenceOperationRequiredFields as requireFieldsReference } from "@rms/store";
import { storePaymentConfigurationRequiredFields as requireFieldsPayment } from "@rms/payment";
import { digitalReceiptTemplateSubmissionRequiredFields as requireFieldsSubmission } from "@rms/printing-device";
it("reads exact historical Address/Contact pins under the current reader and never allocates or writes", async () => {
  const f = fixture();
  expect((await f.source.address(id(10))).authoredByReference).toBe(id(9));
  expect((await f.source.contact(id(11))).reference).toBe(id(11));
  await f.finish();
  expect(f.source.assertFinalized()).toBe(until);
  expect(f.tx.query).not.toHaveBeenCalled();
  expect(f.events[0]).toBe("register");
  expect(f.events.filter((e) => e === "register")).toHaveLength(3);
});
it("keeps all-false saved payment separate from Provider readiness", async () => {
  const f = fixture();
  expect(await f.source.payment(id(12))).toEqual(f.payment);
  await f.finish();
});
it("uses Store locale and actual current receipt release plus immutable authored proof", async () => {
  const f = fixture();
  expect(await f.source.receipt(id(15))).toEqual(f.version);
  await f.finish();
  expect(mocks.proof).toHaveBeenCalledTimes(1);
  expect(mocks.submission).toHaveBeenCalledTimes(1);
});
it("refuses a missing exact reference rather than substituting latest", async () => {
  const f = fixture();
  await expect(f.source.address(id(99))).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT",
  });
});
it("refuses receipt history without immutable authored provenance", async () => {
  const f = fixture();
  f.state.missing = true;
  await expect(f.source.receipt(id(15))).rejects.toBeInstanceOf(Error);
});
it("refuses a changed current publication during final source recheck", async () => {
  const f = fixture();
  await f.source.receipt(id(15));
  f.state.release = id(99);
  await expect(f.finish()).rejects.toBeInstanceOf(Error);
});
it("retains a shorter real current IAM deadline through pure after-COMMIT assertions", async () => {
  const f = fixture();
  f.state.until = "2026-10-06T15:00:02.000Z";
  await f.source.address(id(10));
  await f.finish();
  expect(f.source.assertFinalized()).toBe(f.state.until);
});
it("refuses late authority withdrawal before child source finals", async () => {
  const f = fixture();
  await f.source.payment(id(12));
  f.state.allow = false;
  await expect(f.finish()).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
  });
});
it("refuses changed Actor or Store locale after source observation", async () => {
  const f = fixture();
  await f.source.address(id(10));
  f.state.actor = id(99);
  await expect(f.finish()).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
  });
});
it("refuses lease expiry and missing mandatory finalization", async () => {
  const f = fixture();
  await f.source.contact(id(11));
  expect(() => f.source.assertFinalized()).toThrow();
  const g = fixture();
  await g.source.contact(id(11));
  g.state.clock = until;
  await expect(g.finish()).rejects.toBeInstanceOf(Error);
});
it("preserves genuine child source refusal and does not clear its failure", async () => {
  const f = fixture();
  await f.source.address(id(10));
  f.state.childDrift = true;
  await expect(f.finish()).rejects.toThrow("Controlled immutable source drift");
});
it("refuses captured source-host port replacement", async () => {
  const f = fixture();
  await f.source.address(id(10));
  f.host.registerAfterCommit = vi.fn();
  await expect(f.finish()).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
});

const brandPins = {
  configurationVersionReference: id(30),
  expectedBrandVersion: 1,
  originalIntentDigest: "sha256:" + "c".repeat(64),
};
it("reads exact Store-purpose Brand content only through both owning publication and Brand IAM admission", async () => {
  const f = fixture();
  const value = await f.source.brand(brandPins);
  expect(value.configurationVersionReference).toBe(id(30));
  expect(value.eligibility).toBe("NotEvaluated");
  await f.finish();
  expect(mocks.brandScope).toHaveBeenCalled();
  expect(mocks.currentBrand).toHaveBeenCalledTimes(1);
});
it("does not replace denied Brand authority with an allowed Store grant", async () => {
  const f = fixture();
  f.state.brandAllow = false;
  await expect(f.source.brand(brandPins)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
  });
});
it("refuses recorded Brand content with unavailable actual release proof", async () => {
  const f = fixture();
  f.state.brandRelease = false;
  await expect(f.source.brand(brandPins)).rejects.toThrow(
    "Controlled actual Brand release unavailable",
  );
});
it("rechecks exact Brand publication and authority at the real parent final boundary", async () => {
  const f = fixture();
  await f.source.brand(brandPins);
  f.state.brandRelease = false;
  await expect(f.finish()).rejects.toBeInstanceOf(Error);
});

it("refuses a null actual receipt content publication proof", async () => {
  const f = fixture();
  mocks.proof.mockImplementation(() => async () => null);
  await expect(f.source.receipt(id(15))).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
});

it("refuses malformed actual Device transport counts without fabricating a result", async () => {
  const f = fixture();
  f.tx.query.mockImplementationOnce(async () => ({ rows: [], rowCount: -1 }));
  await expect(f.source.receipt(id(15))).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
});
it("rejects a late options accessor without invoking it", async () => {
  const f = fixture();
  await f.source.address(id(10));
  const getter = vi.fn(() => f.host);
  Object.defineProperty(f.options, "sourceHost", { get: getter, enumerable: true });
  await expect(f.finish()).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
  expect(getter).not.toHaveBeenCalled();
});
