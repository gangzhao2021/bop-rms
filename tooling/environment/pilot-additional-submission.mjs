import console from "node:console";
import { GuestSessionService } from "../../packages/bop/identity/src/index.ts";
import { createConfiguredCheckoutValidationService } from "../../packages/rms/ordering/src/index.ts";
import { createPostgresPaymentTipSelectionStore } from "../../packages/rms/payment/src/index.ts";
import { createCustomerCheckoutSessionAuthorization } from "../../apps/api/dist/customer-checkout-session-authorization.js";
import { createCustomerAdditionalDiningHistoryAuthorization } from "../../apps/api/dist/customer-additional-dining-history-authorization.js";
import { createInternalOrderSourceOptions } from "./pilot-order-sources.mjs";
import { createInternalCheckout } from "./pilot-checkout.mjs";
export async function createInternalAdditionalSubmission(
  resources,
  checkout,
  diningCheckout,
  orders,
  catalogOptions,
  input,
  selected,
) {
  const { scope, transactions, now, credentials: references } = resources,
    reference = references.reference;
  const credentials = {
      sessionCredential: input.sessionCredential,
      csrfCredential: input.csrfCredential,
    },
    session = selected.session,
    v = session.validation;
  const options = await orders.createOptions({
    ...credentials,
    submissionReference: session.submissionReference,
    cartReference: v.cartReference,
    expectedCartVersion: v.cartVersion,
    quoteReference: v.quoteReference,
  });
  const request = {
    cartReference: v.cartReference,
    cartVersion: v.cartVersion,
    quoteReference: v.quoteReference,
  };
  const access = createCustomerCheckoutSessionAuthorization(checkout.accessOptions, {
    ...credentials,
    cartReference: v.cartReference,
  });
  const authority = await access.authorize(request, now());
  if (!authority) throw new Error("ADDITIONAL_AUTHORITY_UNAVAILABLE");
  const authorize = async (tx, value) =>
    value.submissionReference === session.submissionReference &&
    value.actorReference === v.guestSessionReference &&
    (await access.authorizeInTransaction(tx, authority, now()));
  const authorizeOrder = async (tx, q) => {
    const identity = new GuestSessionService({
        ...diningCheckout.identity(tx).session,
        now,
        admission: { consume: async () => null },
      }),
      guest = await identity.authorize(credentials);
    return (
      guest.channel === "DineIn" &&
      guest.diningState === "DiningBound" &&
      guest.brandReference === scope.brandReference &&
      guest.storeReference === scope.storeReference &&
      guest.sessionReference === q.guestSessionReference &&
      guest.diningSessionReference === q.diningSessionReference &&
      q.orderReference === selected.orderReference
    );
  };
  const historyAuthorization = createCustomerAdditionalDiningHistoryAuthorization(
    { scope: options.inventoryOptions.scope, identity: diningCheckout.identity },
    credentials,
  );
  const submissionTransactions = {
    run: (work) =>
      transactions.run((tx) =>
        work({
          query: async (sql, values) => {
            try {
              return await tx.query(sql, values);
            } catch (error) {
              console.error(
                JSON.stringify({
                  event: "INTERNAL_ADDITIONAL_SQL_UNAVAILABLE",
                  code: /^[A-Z0-9]{5}$/.test(error?.code ?? "") ? error.code : "UNAVAILABLE",
                  table:
                    sql.match(/(?:INTO|FROM|UPDATE|JOIN)\s+([a-z_]+\.[a-z_]+)/)?.[1] ?? "unknown",
                }),
              );
              throw error;
            }
          },
        }),
      ),
  };
  const runtime = {
    ...scope,
    transactions: submissionTransactions,
    identity: diningCheckout.identity,
    inventory: options.inventoryOptions,
    currentPolicies: (_tx, q) => options.policies.current(q),
    eventReference: reference,
    audit: async (s) => ({
      auditId: reference(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_ADDITIONAL_BATCH_SUBMIT",
      targetType: "OrderingOrderBatch",
      targetId: s.batch.orderBatchReference,
      reasonCode: "AUTHORIZED_ADDITIONAL_BATCH_SUBMIT",
      correlationId: s.batch.submissionReference,
      occurredAt: s.batch.submittedAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
    diningSealAudit: (record) =>
      options.clock.audit.create({ record, observedAt: record.paymentRequestedAt }),
    validateCurrent: async (tx, snapshot, link, context) => {
      try {
        if (
          snapshot.orderReference !== selected.orderReference ||
          !(await access.authorizeInTransaction(tx, authority, now()))
        )
          throw new Error("ADDITIONAL_CURRENT_DENIED");
        const bound = { run: (work) => work(tx) },
          identityOptions = diningCheckout.identity(tx),
          identity = new GuestSessionService({
            ...identityOptions.session,
            now,
            admission: { consume: async () => null },
          });
        const currentCheckout = createInternalCheckout(
          { ...resources, transactions: bound },
          {
            entry: { session: identityOptions.session },
            binding: () => checkout.accessOptions.binding(tx),
          },
          catalogOptions,
        );
        const ports = currentCheckout.checkoutPorts({
          request,
          ...credentials,
          guestSessionReference: v.guestSessionReference,
          orderType: "DineIn",
        });
        const fresh = await createConfiguredCheckoutValidationService({
          ...ports,
          now,
          authorization: {
            authorize: async () => ({ guestSession: await identity.authorize(credentials) }),
          },
          fulfillment: {
            validate: async (q) => {
              if (
                q.brandReference !== link.brandReference ||
                q.storeReference !== link.storeReference ||
                q.cartReference !== link.cartReference ||
                q.cartVersion !== link.cartVersion ||
                q.quoteReference !== link.quoteReference ||
                q.orderType !== "DineIn" ||
                now() >= link.validUntil
              )
                throw new Error("ADDITIONAL_CAPACITY_CHANGED");
              return {
                status: "Accepted",
                brandReference: link.brandReference,
                storeReference: link.storeReference,
                cartReference: link.cartReference,
                cartVersion: link.cartVersion,
                quoteReference: link.quoteReference,
                orderType: "DineIn",
                sourceChannel: q.sourceChannel,
                evidenceReference: link.commitmentReference,
                evidenceVersion: link.commitmentVersion,
                evidenceDigest: link.ownerSnapshotDigest,
                checkedAt: q.observedAt,
                validUntil: link.validUntil,
              };
            },
          },
        }).validate({
          validationReference: v.validationReference,
          cartReference: v.cartReference,
          expectedCartVersion: v.cartVersion,
          quoteReference: v.quoteReference,
          requestedAt: now(),
        });
        for (const key of [
          "guestSessionReference",
          "brandReference",
          "storeReference",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "quoteVersion",
          "quoteInputDigest",
          "orderType",
          "sourceChannel",
        ])
          if (fresh[key] !== v[key]) throw new Error("ADDITIONAL_CHECKOUT_CHANGED");
        const lines = (value) =>
          value.catalogLines.map((source) => {
            const line = { ...source };
            delete line.validatedAt;
            return line;
          });
        if (
          JSON.stringify(lines(fresh)) !== JSON.stringify(lines(v)) ||
          now() >= fresh.validUntil ||
          context.observedAt > now()
        )
          throw new Error("ADDITIONAL_CATALOG_CHANGED");
      } catch (error) {
        const code = error?.code ?? error?.message;
        console.error(
          JSON.stringify({
            event: "INTERNAL_ADDITIONAL_CURRENT_UNAVAILABLE",
            code: /^[A-Z0-9_]{1,80}$/.test(code ?? "") ? code : "UNAVAILABLE",
            frames:
              String(error?.stack ?? "")
                .match(
                  /(?:apps\/api\/dist|packages\/[a-z]+\/[a-z-]+\/src|\.local\/pilot-v4)\/[a-zA-Z0-9_./-]+:\d+:\d+/g,
                )
                ?.slice(0, 4) ?? [],
          }),
        );
        throw error;
      }
    },
  };
  const tip = {
    preparation: diningCheckout.preparation,
    quoteVersion: 2,
    authorizeOrder,
    tip: {
      repository: createPostgresPaymentTipSelectionStore(transactions, scope, { now }),
      audit: {
        create: async (record) => ({
          auditId: reference(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "PAYMENT_TIP_SELECT",
          targetType: "PaymentTipSelection",
          targetId: record.selectionReference,
          reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
          correlationId: record.submissionReference,
          occurredAt: record.selectedAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      },
    },
  };
  return {
    submission: {
      access: checkout.accessOptions,
      runtime,
      source: createInternalOrderSourceOptions(resources, catalogOptions, "DineIn"),
      historyAuthorization,
      nextItemReference: reference,
    },
    tip,
    authorize,
  };
}
