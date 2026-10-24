import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createCustomerDiningSessionOrderSubmission,
  createCustomerPickupSessionOrderSubmission,
} from "../../../apps/api/src/customer-session-order-submission.ts";
import { createCustomerSubmissionInventoryFinalizer } from "../../../apps/api/src/customer-submission-inventory-finalizer.ts";
import { createPostgresInventoryFinalizedOrderCreationRepository } from "../../rms/ordering/src/index.ts";
import { createPostgresDiningCheckoutCommitmentStore } from "../../rms/dining/src/index.ts";
import { seedSubmissionInventoryWorkflow } from "./submission-inventory-workflow.mjs";

/** Same Entry Cart/site/Recipe, actual owner transaction and explicit synthetic Workflow policy. */
export async function exerciseEntryDiningOrder({
  admin,
  role,
  run,
  scope,
  commitment,
  checkout,
  details,
  orderSources,
  sources,
  cookie,
  csrfToken,
  reference,
  mode = "DineIn",
  http,
  base,
  oldCookie,
}) {
  const identityScope = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  const access = mode === "Pickup" ? checkout.access : commitment.allocated.options;
  const capacityRecord = mode === "Pickup" ? checkout.capacity : commitment.record;
  const now = access.now;
  await admin.query(
    "GRANT USAGE ON SCHEMA platform_eventing,bop_workflow,bop_publishing TO " + role,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rms_inventory,bop_workflow,bop_publishing TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.order_header,rms_ordering.order_submission_record,rms_ordering.order_revision,rms_ordering.order_batch,rms_ordering.order_item,rms_ordering.order_number_allocation,rms_ordering.order_capacity_link,rms_ordering.order_checkout_details_link,platform_eventing.outbox_event TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_ordering.order_number_counter TO " + role);
  // Recipe final demand uses SHARE locks to fence concurrent binding/modifier changes.
  await admin.query(
    "GRANT UPDATE ON rms_recipe.recipe,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version TO " +
      role,
  );
  const workflow = await seedSubmissionInventoryWorkflow({
    runner: () => ({ run }),
    scope,
    actorReference: capacityRecord.guestSessionReference,
    at: now(),
    orderType: mode,
  });
  const inventory = createCustomerSubmissionInventoryFinalizer({
    scope,
    stockSiteReference: sources.inventoryScope.stockSiteReference,
    workflow,
    // Called only inside Ordering's locked current-authorized write; no standalone admission.
    authorize: async (_tx, input) =>
      input.submissionReference === checkout.session.submissionReference &&
      input.actorReference === capacityRecord.guestSessionReference,
    resolveExpiryCutoff: async () => {
      throw new Error("NoLot fixture");
    },
    generateReference: reference,
    audit: {
      reasonCode: "SYNTHETIC_SUBMISSION",
      sourceChannel: "CUSTOMER_PWA",
      retentionPolicyCode: "SYNTHETIC_AUDIT",
      retentionPolicyVersion: 1,
    },
  });
  const diagnostics = [];
  const transactions = {
    run: (work) =>
      run((tx) =>
        work({
          query: async (sql, values) => {
            const table =
              /(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1] ?? "owner-query";
            try {
              const result = await tx.query(sql, values);
              diagnostics.push({ table, rows: result.rows.length });
              return result;
            } catch (error) {
              diagnostics.push({
                table,
                code: /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "unknown",
              });
              throw error;
            }
          },
        }),
      ),
  };
  let finalizations = 0;
  const options = {
    ...checkout.submissionOptions,
    ...(mode === "DineIn"
      ? {
          clock: {
            repository: createPostgresDiningCheckoutCommitmentStore({ run }, scope, { now }),
            audit: {
              create: async (input) => ({
                ...(await commitment.preparation.dining.audit.create(input)),
                auditId: reference(),
                actionCode: "DINING_CHECKOUT_SEAL",
              }),
            },
          },
        }
      : {}),
    ordering: {
      source: orderSources.source,
      businessDate: orderSources.businessDate,
      references: {
        generate: reference,
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
      },
      audit: {
        create: async (input) => ({
          auditId: reference(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "ORDERING_ORDER_CREATE",
          targetType: "OrderingOrder",
          targetId: input.order.orderReference,
          occurredAt: input.observedAt,
          reasonCode: "AUTHORIZED_ORDER_CREATE",
          correlationId: input.submissionReference,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      },
    },
    repository: (link, authorization) =>
      createPostgresInventoryFinalizedOrderCreationRepository(
        { query: transactions, write: transactions },
        identityScope,
        link,
        1,
        { now, policies: details.policies, authorization },
        {
          finalize: async (input) => {
            finalizations++;
            diagnostics.push({ stage: "inventory-finalization" });
            const result = await inventory.finalize(input);
            diagnostics.push({ stage: "inventory-finalized" });
            return result;
          },
        },
      ),
  };
  const service = (
    mode === "Pickup"
      ? createCustomerPickupSessionOrderSubmission
      : createCustomerDiningSessionOrderSubmission
  )(access, options);
  const input = {
    sessionCredential: cookie.split("=")[1],
    csrfCredential: csrfToken,
    checkoutSessionReference: checkout.session.checkoutSessionReference,
  };
  if (http) await http.exercise({ options, checkout, base, cookie, csrfToken, oldCookie });
  let first;
  try {
    first = await service.create(input);
  } catch {
    assert.fail(JSON.stringify(diagnostics.slice(-50)));
  }
  assert.equal(first.status, http ? "AlreadyCreated" : "Created");
  assert.equal(first.record.submissionReference, checkout.session.submissionReference);
  assert.equal(first.record.order.orderReference, capacityRecord.orderReference);
  assert.equal(first.record.items.length, mode === "Pickup" ? 1 : 2);
  assert.equal(first.record.order.orderType, mode);
  assert.equal(first.session.checkoutSessionReference, checkout.session.checkoutSessionReference);
  const replay = await service.create(input);
  assert.equal(replay.status, "AlreadyCreated");
  assert.deepEqual(replay.record, first.record);
  assert.equal(finalizations, 1);
  const counts = await admin.query(
    "SELECT (SELECT count(*)::int FROM rms_ordering.order_header) orders,(SELECT count(*)::int FROM rms_ordering.order_checkout_details_link) details,(SELECT count(*)::int FROM rms_inventory.submission_final_validation) finals,(SELECT count(*)::int FROM rms_inventory.stock_reservation_set) reservations",
  );
  assert.deepEqual(counts.rows[0], { orders: 1, details: 1, finals: 1, reservations: 1 });
  return { service, input, options, record: first.record, workflow };
}
