import { expect, it, vi } from "vitest";
import { createProductPublicationControllerV2 } from "./product-publication-controller-v2.js";
import {
  createProductPublicationWarningAcknowledgementClient,
  parseProductPublicationWarningAcknowledgementCommand,
} from "./product-publication-warning-acknowledgement-client.js";
import { buildProductPublicationWarningAcknowledgementPendingRecord } from "./product-publication-warning-acknowledgement-pending-record.js";
import { parseProductPublicationValidationReportViewV2 } from "./product-publication-validation-report-client-v2.js";
import { createProductPublicationCommandClientV2 } from "./product-publication-command-client-v2.js";
import { createProductPublicationResolutionClient } from "./product-publication-resolution-client.js";
import { createProductPublicationCommandClient } from "./product-publication-command-client.js";
import { createProductPublicationManagementClientV2 } from "./product-publication-management-client-v2.js";
import { createStoreCapabilityClient } from "./store-capability-client.js";
import { buildPublicationPendingRecord } from "./product-publication-pending-record.js";
import { buildPublicationPendingRecordV2 } from "./product-publication-pending-record-v2.js";
import { type PublicationPendingJournalV2 } from "./product-publication-pending-journal-v2.js";
import {
  at,
  command,
  csrf,
  exact,
  digest,
  seal,
  validatedManagement,
  validationReportView,
  id,
  management,
  oldPublication,
  receipt,
  request,
  response,
  scope,
} from "./product-publication-v2-test-fixtures.js";
function warningManagement(observedAt = at, aggregateVersion = 7, changed = false) {
  const raw = validatedManagement(),
    publication = raw.versions[0];
  if (!publication) throw Error("Missing controlled publication");
  publication.validationDecision = "WarningAcknowledgementRequired";
  const headers = raw.scopeRetirementHeaders.map((header) =>
    seal({ ...header, publicationSnapshotDigest: digest(publication) }),
  );
  return seal({
    ...raw,
    aggregateVersion,
    observedAt,
    editorObservedAt: observedAt,
    sourceObservedAt: observedAt,
    validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
    scopeRetirementHeaders: headers,
    draft: {
      ...raw.draft,
      contentDigest: changed ? digest("changed saved content") : raw.draft.contentDigest,
    },
    sourceDigest: digest({
      profile: "CatalogProductRetirementCoverageV1",
      coverage: "CompleteRecordedPublicationRetirements",
      sourceAuthority: "NotEvaluated",
      eligibility: "NotEvaluated",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      productReference: scope.productReference,
      aggregateVersion,
      sourceRevision: raw.sourceRevision,
      observedAt,
      history: raw.history,
      headers,
      latest: raw.versions,
    }),
  });
}
async function warningReport(complete = true, decision = "WarningAcknowledgementRequired") {
  const publication = warningManagement().versions[0];
  if (!publication) throw Error("Missing controlled publication");
  publication.validationDecision = decision;
  return parseProductPublicationValidationReportViewV2(
    validationReportView(publication, { complete, aggregateVersion: 7 }),
    {
      ...scope,
      versionReference: publication.versionReference,
      expectedAggregateVersion: 7,
      expectedPublicationVersion: 1,
    },
    () => Date.parse(at),
  );
}
function setup(initial: unknown = null, target = false, warnings = false, root = 7) {
  let stored = initial,
    time = Date.parse(at),
    context = 0,
    lost = false,
    denied = false,
    removeTarget = false,
    expiryOnReserve = false,
    failComplete = false,
    committedResolution = false,
    changed = false;
  const bodies: string[] = [],
    routes: string[] = [],
    journal: PublicationPendingJournalV2 = {
      async load() {
        return stored;
      },
      async reserve(value) {
        if (stored !== null && JSON.stringify(stored) !== JSON.stringify(value))
          throw Error("synthetic CAS");
        stored = value;
        if (expiryOnReserve) time += 5000;
      },
      async complete(value) {
        if (failComplete || JSON.stringify(stored) !== JSON.stringify(value))
          throw Error("synthetic CAS");
        stored = null;
      },
    };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    routes.push(String(url));
    if (url === "/merchant/store-capability")
      return response({
        brandReference: id(2),
        storeReference: id(3),
        capabilityKey: "catalog.cat_product_edit",
        controlKey: "catalog.product.edit",
        backendExecution: "Allow",
        frontendVisibility: "Show",
        reason: "Enabled",
        source: "StoreOverride",
        controlReference: id(20),
        controlVersion: 1,
        observedAt: new Date(time).toISOString(),
      });
    if (url === "/merchant/catalog/products/publication/management/v2")
      return response(
        warnings
          ? warningManagement(new Date(time).toISOString(), root, changed)
          : management(
              new Date(time).toISOString(),
              target && !removeTarget ? oldPublication() : null,
            ),
      );
    bodies.push(String(init?.body));
    if (lost) throw Error("synthetic lost response");
    if (denied) return response({ error: "request_denied" }, 403);
    if (url === "/merchant/catalog/products/publication/resolve/v1") {
      const input = JSON.parse(String(init?.body)) as {
        originalKind: string;
        originalCommand: ReturnType<typeof command>;
      };
      return response({
        profile: "CatalogProductPublicationResolutionResultV1",
        outcome: committedResolution ? "Committed" : "Abandoned",
        originalKind: input.originalKind,
        ...scope,
        operationReference: input.originalCommand.operationReference,
        versionReference: input.originalCommand.versionReference,
        originalCommandDigest: digest(input.originalCommand),
        originalIntentDigest: digest("server original"),
        recordedAt: new Date(time).toISOString(),
        resolutionDigest: digest("server resolution"),
        currentAggregateVersion: 12,
      });
    }
    if (url === "/merchant/catalog/products/publication/warning-acknowledgements/v1") {
      const c = parseProductPublicationWarningAcknowledgementCommand(
          JSON.parse(String(init?.body)),
        ),
        { profile, action, expectedProductAggregateVersion, ...binding } = c;
      void profile;
      void action;
      return response({
        ...binding,
        profile: "CatalogProductPublicationWarningAcknowledgementResultV1",
        status: bodies.length > 1 ? "Replayed" : "Applied",
        aggregateVersion: expectedProductAggregateVersion,
        recordedAt: c.occurredAt,
        receiptDigest: digest("synthetic independent receipt"),
      });
    }
    const c = JSON.parse(String(init?.body)) as ReturnType<typeof command>,
      result = receipt(c, bodies.length > 1 ? "Replayed" : "Applied");
    if (url === "/merchant/catalog/products/publication") {
      const { profile, replacementIntentDigest, ...legacy } = result;
      void profile;
      void replacementIntentDigest;
      return response(legacy);
    }
    return response(result);
  });
  const options = {
    request: { ...request, expectedAggregateVersion: root },
    currentScope: () => scope,
    currentContext: () => context,
    now: () => time,
    reads: createProductPublicationManagementClientV2(fetcher, () => time),
    capabilities: createStoreCapabilityClient(fetcher, () => time),
    commands: createProductPublicationCommandClientV2(fetcher),
    acknowledgements: createProductPublicationWarningAcknowledgementClient(fetcher),
    legacyCommands: createProductPublicationCommandClient(fetcher),
    resolutions: createProductPublicationResolutionClient(fetcher),
    journal,
  };
  return {
    controller: createProductPublicationControllerV2(options),
    options,
    fetcher,
    bodies,
    routes,
    stored: () => stored,
    lose: () => {
      lost = true;
    },
    restore: () => {
      lost = false;
      denied = false;
    },
    deny: () => {
      lost = false;
      denied = true;
    },
    changeSavedContent: () => {
      changed = true;
    },
    retarget: () => {
      removeTarget = true;
    },
    expireOnReserve: () => {
      expiryOnReserve = true;
    },
    failCleanup: () => {
      failComplete = true;
    },
    resolutionCommitted: () => {
      committedResolution = true;
    },
    changeScope: () => {
      context++;
    },
    tick: (ms: number) => {
      time += ms;
    },
  };
}
function intent(target = false) {
  const c = command();
  return {
    operationReference: c.operationReference,
    versionReference: c.versionReference,
    action: "Validate" as const,
    scopeSet: c.scopeSet,
    effectivePeriod: c.effectivePeriod,
    scheduleReference: null,
    successorDraftVersionReference: null,
    occurredAt: c.occurredAt,
    reasonCode: c.reasonCode,
    replacementIntent: target ? exact() : c.replacementIntent,
  };
}
const signal = () => new AbortController().signal;
it.each([false, true])(
  "clears only authoritative resolution outcome Committed=%s and observes the actual current revision",
  async (committed) => {
    const original = await buildPublicationPendingRecordV2(command(), scope),
      s = setup(original);
    await s.controller.refresh(csrf, signal());
    if (committed) s.resolutionCommitted();
    s.tick(10000);
    const result = await s.controller.resolveOriginal(csrf, signal());
    expect(result.outcome).toBe(committed ? "Committed" : "Abandoned");
    expect(s.controller.view()).toMatchObject({
      pendingOperation: false,
      revision: 12,
      source: null,
      status: "NeedsRefresh",
    });
    expect(s.stored()).toBeNull();
    expect(s.routes.some((route) => route.includes("management"))).toBe(false);
    expect(s.bodies).toHaveLength(1);
    expect(JSON.parse(s.bodies[0] ?? "null")).toMatchObject({
      originalKind: "PublicationV2",
      originalCommand: JSON.parse(original.body),
    });
  },
);
it("keeps the exact pending record after denied resolution or failed terminal CAS", async () => {
  const original = await buildPublicationPendingRecordV2(command(), scope),
    s = setup(original);
  await s.controller.refresh(csrf, signal());
  s.deny();
  await expect(s.controller.resolveOriginal(csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(s.stored()).toEqual(original);
  s.restore();
  s.failCleanup();
  await expect(s.controller.resolveOriginal(csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(s.stored()).toEqual(original);
  expect(s.controller.view()).toMatchObject({ pendingOperation: true, status: "OutcomeUnknown" });
});
it("does not clear a pending record after the selected scope changes during resolution", async () => {
  const original = await buildPublicationPendingRecordV2(command(), scope),
    s = setup(original);
  const configured = s.options.resolutions.resolve.bind(s.options.resolutions);
  s.options.resolutions = {
    resolve: async (...args) => {
      const value = await configured(...args);
      s.changeScope();
      return value;
    },
  };
  const controller = createProductPublicationControllerV2(s.options);
  await controller.refresh(csrf, signal());
  await expect(controller.resolveOriginal(csrf, signal())).rejects.toMatchObject({
    code: "ScopeChanged",
  });
  expect(s.stored()).toEqual(original);
});
it.each([false, true])(
  "prepares owner bound None/Exact=%s only after current held management then consumes original journal CAS",
  async (target) => {
    const s = setup(null, target);
    await s.controller.refresh(csrf, signal());
    const result = await s.controller.act(intent(target), csrf, signal());
    expect(result.aggregateVersion).toBe(8);
    expect(s.stored()).toBeNull();
    expect(s.controller.view()).toMatchObject({
      revision: 8,
      status: "NeedsRefresh",
      source: null,
    });
    const body = s.bodies[0];
    if (!body) throw new Error("Missing sent body");
    expect(JSON.parse(body)).toMatchObject({
      profile: "CatalogProductPublicationCommandV2",
      replacementIntent: intent(target).replacementIntent,
    });
  },
);
it("refuses retargeting between preview and admission without reserving or sending", async () => {
  const s = setup(null, true);
  await s.controller.refresh(csrf, signal());
  s.retarget();
  await expect(s.controller.act(intent(true), csrf, signal())).rejects.toMatchObject({
    code: "Conflict",
  });
  expect(s.stored()).toBeNull();
  expect(s.bodies).toHaveLength(0);
});
it("keeps unknown original through denial, refuses new intent, and replays without management re-read", async () => {
  const s = setup();
  await s.controller.refresh(csrf, signal());
  s.lose();
  await expect(s.controller.act(intent(), csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  const record = s.stored(),
    reads = s.routes.filter((r) => r.includes("management")).length;
  await expect(
    s.controller.act({ ...intent(), operationReference: id(99) }, csrf, signal()),
  ).rejects.toMatchObject({ code: "PendingOperation" });
  s.deny();
  await expect(s.controller.retry(csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(s.stored()).toEqual(record);
  s.restore();
  expect((await s.controller.retry(csrf, signal())).status).toBe("Replayed");
  expect(new Set(s.bodies).size).toBe(1);
  expect(s.routes.filter((r) => r.includes("management")).length).toBe(reads);
});
it.each(["V1", "V2"])(
  "restores %s original using its original endpoint before any new management read",
  async (profile) => {
    const c = command(),
      { profile: p, replacementIntent, replacementIntentDigest, ...legacy } = c;
    void p;
    void replacementIntent;
    void replacementIntentDigest;
    const original =
        profile === "V1"
          ? await buildPublicationPendingRecord(legacy, scope)
          : await buildPublicationPendingRecordV2(c, scope),
      s = setup(original);
    await s.controller.refresh(csrf, signal());
    expect(s.controller.view()).toMatchObject({ status: "OutcomeUnknown", pendingOperation: true });
    expect(s.routes.some((r) => r.includes("management"))).toBe(false);
    await s.controller.retry(csrf, signal());
    expect(s.routes.at(-1)).toBe(
      profile === "V1"
        ? "/merchant/catalog/products/publication"
        : "/merchant/catalog/products/publication/v2",
    );
    expect(s.bodies[0]).toBe(original.body);
    expect(s.stored()).toBeNull();
  },
);
it("expired reservation remains recoverable but does not send a new request", async () => {
  const s = setup();
  await s.controller.refresh(csrf, signal());
  s.expireOnReserve();
  await expect(s.controller.act(intent(), csrf, signal())).rejects.toMatchObject({ code: "Stale" });
  expect(s.stored()).not.toBeNull();
  expect(s.bodies).toHaveLength(0);
});
it("local CAS cleanup failure keeps original uncertain after a matching native receipt", async () => {
  const s = setup();
  await s.controller.refresh(csrf, signal());
  s.failCleanup();
  await expect(s.controller.act(intent(), csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(s.controller.view().pendingOperation).toBe(true);
  expect(s.stored()).not.toBeNull();
});
it("captures configured ports and rejects changed route context", async () => {
  const s = setup();
  Object.assign(s.options, {
    reads: {
      load: () => {
        throw Error("mutated");
      },
    },
    commands: {
      prepare: () => {
        throw Error("mutated");
      },
    },
  });
  await s.controller.refresh(csrf, signal());
  s.changeScope();
  await expect(s.controller.act(intent(), csrf, signal())).rejects.toMatchObject({
    code: "ScopeChanged",
  });
  expect(s.bodies).toHaveLength(0);
});

it("keeps editing blocked when original journal recovery cannot be established", async () => {
  const s = setup({ profile: "CatalogProductPublicationPendingV2", body: "corrupt" });
  expect(s.controller.view().originalRecoveryChecked).toBe(false);
  await expect(s.controller.refresh(csrf, signal())).rejects.toMatchObject({ code: "Unavailable" });
  expect(s.controller.view()).toMatchObject({
    originalRecoveryChecked: false,
    pendingOperation: false,
  });
  expect(s.bodies).toHaveLength(0);
  expect(s.routes.some((route) => route.includes("management"))).toBe(false);
});

const acknowledgementIntent = async () => ({
  operationReference: id(301),
  report: await warningReport(),
  reasonCode: "EXPLICIT_REVIEW",
  occurredAt: at,
  confirmed: true as const,
});
it.each([7, 8])(
  "freshly admits historical report after human reading with current root %s unchanged",
  async (root) => {
    const s = setup(null, false, true, root),
      intent = await acknowledgementIntent();
    await s.controller.refresh(csrf, signal());
    s.tick(60000);
    expect(s.controller.view().source).toBeNull();
    Object.assign(s.options, {
      acknowledgements: {
        ...s.options.acknowledgements,
        prepare: () => {
          throw Error("mutated configured port");
        },
      },
    });
    const result = await s.controller.acknowledge(intent, csrf, signal());
    expect(result).toMatchObject({
      profile: "CatalogProductPublicationWarningAcknowledgementResultV1",
      aggregateVersion: root,
      reportDigest: intent.report.report?.digest,
      warningCodes: ["ChangeImpact"],
    });
    expect(s.controller.view()).toMatchObject({
      revision: root,
      status: "NeedsRefresh",
      pending: null,
      pendingOperation: false,
    });
    expect(s.stored()).toBeNull();
    const body = s.bodies[0];
    if (!body) throw Error("No actual transport body");
    expect(JSON.parse(body)).toMatchObject({
      expectedProductAggregateVersion: root,
      reasonCode: "EXPLICIT_REVIEW",
    });
    expect(Object.keys(JSON.parse(body) as object)).toHaveLength(12);
  },
);
it("restores independent Ack with visible original summary and exact retry before management", async () => {
  const s = setup(null, false, true),
    intent = await acknowledgementIntent();
  await s.controller.refresh(csrf, signal());
  s.lose();
  await expect(s.controller.acknowledge(intent, csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  const original = s.stored();
  expect(s.controller.view()).toMatchObject({
    originalRecoveryChecked: true,
    pendingOperation: true,
    pending: {
      kind: "WarningAcknowledgementV1",
      versionReference: id(6),
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_REVIEW",
      occurredAt: at,
    },
  });
  await expect(s.controller.act(intentForPublication(), csrf, signal())).rejects.toMatchObject({
    code: "PendingOperation",
  });
  await expect(
    s.controller.acknowledge({ ...intent, operationReference: id(303) }, csrf, signal()),
  ).rejects.toMatchObject({ code: "PendingOperation" });
  await expect(s.controller.refresh(csrf, signal())).rejects.toMatchObject({
    code: "PendingOperation",
  });
  const restored = createProductPublicationControllerV2(s.options),
    before = s.routes.filter((r) => r.includes("management")).length;
  await restored.refresh(csrf, signal());
  s.deny();
  await expect(restored.retry(csrf, signal())).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(s.stored()).toEqual(original);
  expect(restored.view().pending?.kind).toBe("WarningAcknowledgementV1");
  s.restore();
  expect(await restored.retry(csrf, signal())).toMatchObject({
    profile: "CatalogProductPublicationWarningAcknowledgementResultV1",
    status: "Replayed",
    aggregateVersion: 7,
  });
  expect(s.routes.filter((r) => r.includes("management"))).toHaveLength(before);
  expect(new Set(s.bodies).size).toBe(1);
  expect(s.stored()).toBeNull();
});
// Alias avoids shadowing the existing publication intent helper in the scenario above.
const intentForPublication = () => intent();
it("rejects changed saved Draft binding before reserving or sending confirmation", async () => {
  const s = setup(null, false, true),
    intent = await acknowledgementIntent();
  await s.controller.refresh(csrf, signal());
  s.changeSavedContent();
  await expect(s.controller.acknowledge(intent, csrf, signal())).rejects.toMatchObject({
    code: "Conflict",
  });
  expect(s.bodies).toHaveLength(0);
  expect(s.stored()).toBeNull();
});
it.each(["ChecksOnly", "NoWarnings", "HardError", "Unconfirmed", "ScopeChanged"])(
  "does not confirm %s report context",
  async (mode) => {
    const s = setup(null, false, true),
      intent = await acknowledgementIntent();
    await s.controller.refresh(csrf, signal());
    if (mode === "ChecksOnly") intent.report = await warningReport(false);
    if (mode === "NoWarnings") intent.report = await warningReport(true, "ApprovalPending");
    if (mode === "HardError") intent.report = await warningReport(true, "HardError");
    if (mode === "Unconfirmed") Object.assign(intent, { confirmed: false });
    if (mode === "ScopeChanged") s.changeScope();
    await expect(s.controller.acknowledge(intent, csrf, signal())).rejects.toMatchObject({
      code: mode === "ScopeChanged" ? "ScopeChanged" : "Invalid",
    });
    expect(s.bodies).toHaveLength(0);
    expect(s.stored()).toBeNull();
  },
);
it("expired Ack reservation stays recoverable and blocks later ordinary publication", async () => {
  const s = setup(null, false, true);
  await s.controller.refresh(csrf, signal());
  s.expireOnReserve();
  await expect(
    s.controller.acknowledge(await acknowledgementIntent(), csrf, signal()),
  ).rejects.toMatchObject({ code: "Stale" });
  expect(s.stored()).not.toBeNull();
  expect(s.bodies).toHaveLength(0);
  expect(s.controller.view().pending?.kind).toBe("WarningAcknowledgementV1");
  await expect(s.controller.act(intent(), csrf, signal())).rejects.toMatchObject({
    code: "PendingOperation",
  });
});
it("shared journal CAS keeps a competing publication original and blocks Draft recovery", async () => {
  const s = setup(null, false, true);
  await s.controller.refresh(csrf, signal());
  const publication = await buildPublicationPendingRecordV2(command(), scope);
  await s.options.journal.reserve(publication);
  await expect(
    s.controller.acknowledge(await acknowledgementIntent(), csrf, signal()),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(s.stored()).toEqual(publication);
  expect(s.bodies).toHaveLength(0);
  expect(s.controller.view().originalRecoveryChecked).toBe(false);
});
it("same-scope Ack original remains Unknown when receipt cleanup CAS fails", async () => {
  const intent = await acknowledgementIntent(),
    report = intent.report.report;
  if (!report || !report.warningBindingDigest) throw Error("Missing synthetic report");
  const original = await buildProductPublicationWarningAcknowledgementPendingRecord(
      {
        profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
        action: "AcknowledgeProductPublicationWarnings",
        operationReference: intent.operationReference,
        productReference: scope.productReference,
        versionReference: id(6),
        expectedProductAggregateVersion: 7,
        reportOperationReference: report.operationReference,
        reportDigest: report.digest,
        warningBindingDigest: report.warningBindingDigest,
        warningCodes: ["ChangeImpact"],
        reasonCode: intent.reasonCode,
        occurredAt: at,
      },
      scope,
    ),
    s = setup(original, false, true);
  await s.controller.refresh(csrf, signal());
  s.failCleanup();
  await expect(s.controller.retry(csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(s.stored()).toEqual(original);
  expect(s.controller.view().pending?.kind).toBe("WarningAcknowledgementV1");
});
