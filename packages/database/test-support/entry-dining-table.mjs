import { createHash } from "node:crypto";
import {
  createDiningTable,
  transitionDiningTable,
  createDiningTableService,
  createPostgresDiningTableStore,
} from "../../rms/dining/src/index.ts";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

/** Real commands/Audit; Staff authorization is explicitly synthetic test evidence. */
export async function prepareEntryDiningTable({ admin, role, run, binding, at }) {
  await admin.query("GRANT USAGE ON SCHEMA rms_dining TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_dining.dining_table TO " + role);
  await admin.query("GRANT SELECT,INSERT ON rms_dining.dining_table_operation TO " + role);
  const scope = {
    tenantReference: binding.tenantReference,
    brandReference: binding.brandReference,
    storeReference: binding.storeReference,
  };
  let sequence = 30000;
  const reference = () => id(++sequence);
  const references = {
    hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    equals: (a, b) => a === b,
  };
  const repository = createPostgresDiningTableStore({ run }, scope, references);
  const service = createDiningTableService({
    references,
    authorization: {
      authorize: async (input) => ({
        ...scope,
        actorReference: id(31000),
        purpose: "dining-table",
        permission: { effect: "Allow", action: "dining.operate", scopeKind: "Store" },
        audit: {
          auditId: reference(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: id(31000) },
          actionCode: "DINING_TABLE_" + input.action.toUpperCase(),
          targetType: "DiningTable",
          targetId: input.targetReference,
          reasonCode: "AUTHORIZED_OPERATION",
          correlationId: id(31001),
          occurredAt: input.observedAt,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        },
      }),
    },
    repository: {
      ...repository,
      loadSession: async () => null,
      resolveMoveOperation: async () => null,
      commitMove: async () => {
        throw new Error("unconfigured test Move");
      },
    },
  });
  let table = createDiningTable({
    ...scope,
    tableReference: id(31002),
    stableLabel: "T01",
    areaReference: id(31003),
    areaCode: "MAIN",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Draft",
    qrStatus: "Inactive",
    qrVersion: 0,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: null,
    aggregateVersion: 1,
    createdAt: at,
    observedAt: at,
  });
  await service.executeTable({
    action: "CreateDraft",
    operationReference: reference(),
    candidate: table,
    expectedAggregateVersion: null,
    observedAt: at,
  });
  const transition = async (action) => {
    table = await repository.loadTable(table.tableReference);
    const next = transitionDiningTable(table, action, at);
    await service.executeTable({
      action,
      operationReference: reference(),
      candidate: next,
      expectedAggregateVersion: table.aggregateVersion,
      observedAt: at,
    });
    table = next;
  };
  await transition("Publish");
  await transition("IssueQr");
  return {
    tableReference: table.tableReference,
    publicTableReference: id(31004),
    qrReference: id(31005),
    qrVersion: table.qrVersion,
    revoke: () => transition("RevokeQr"),
  };
}
