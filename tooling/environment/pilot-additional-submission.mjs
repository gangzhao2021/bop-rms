import { readPublishedStoreTipOff } from "../../packages/rms/store/src/index.ts";
import console from "node:console";
import { GuestSessionService } from "../../packages/bop/identity/src/index.ts";
import {
  CheckoutValidationError,
  OrderCreationError,
  createConfiguredCheckoutValidationService,
} from "../../packages/rms/ordering/src/index.ts";
import { confirmCatalogSaleStillCurrent } from "../../packages/rms/catalog/src/index.ts";
import { createPostgresPaymentTipSelectionStore } from "../../packages/rms/payment/src/index.ts";
import { createCustomerCheckoutSessionAuthorization } from "../../apps/api/dist/customer-checkout-session-authorization.js";
import { createCustomerAdditionalDiningHistoryAuthorization } from "../../apps/api/dist/customer-additional-dining-history-authorization.js";
import { createInternalOrderSourceOptions } from "./pilot-order-sources.mjs";
import { createInternalCheckout } from "./pilot-checkout.mjs";
import { customerRoundRefusal } from "../../apps/api/dist/customer-round-refusal.js";
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
              // Safe identifiers only (SQLSTATE, constraint, table, statement kind); never values.
              const diagnostic = error?.diagnostic ?? null;
              console.error(
                JSON.stringify({
                  event: "INTERNAL_ADDITIONAL_SQL_UNAVAILABLE",
                  code: /^[A-Z0-9]{5}$/.test(error?.code ?? "")
                    ? error.code
                    : /^[0-9A-Z]{5}$/.test(diagnostic?.sqlState ?? "")
                      ? diagnostic.sqlState
                      : diagnostic?.closed === true
                        ? "TRANSACTION_CLOSED"
                        : "UNAVAILABLE",
                  constraint: diagnostic?.constraint ?? null,
                  table:
                    diagnostic?.table ??
                    sql.match(/(?:INTO|FROM|UPDATE|JOIN)\s+([a-z_]+\.[a-z_]+)/)?.[1] ??
                    (/^\s*SELECT pg_advisory_xact_lock/u.test(sql)
                      ? "advisory_lock"
                      : /^\s*SELECT set_config/u.test(sql)
                        ? "set_config"
                        : /^\s*(SAVEPOINT|RELEASE|ROLLBACK)/u.test(sql)
                          ? "savepoint"
                          : "unknown"),
                }),
              );
              throw error;
            }
          },
        }),
      ),
  };
  // The current check's error handling, before and inside the write transaction alike.
  const reported = async (work) => {
    try {
      return await work();
    } catch (error) {
      // WP-2423 expected refusals (a dish ran out, came off the menu, the menu moved on): the
      // batch store answers them as themselves and the payment's catch logs the one information
      // line for the attempt; only an unexpected failure is logged here.
      if (customerRoundRefusal(error) !== null) throw error;
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
  };
  /** What this round's pre-check found current (per attempt), for the write's re-check. */
  let prepared = null;
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
    // WP-2423 (rush-connection-hold, later rounds): the full current check of the round's dishes
    // (menu, availability, choices, stock, prices) runs before the round's write transaction, each
    // read in its own snapshot, as the table's opening round does. The write transaction then only
    // confirms what it can fence: the guest, the Order, the Cart version, the windows, and that the
    // menu release and the dishes' and choices' sale state the pre-check read are still in effect
    // (Catalog's re-check on the write connection). Stock it does not re-read: the round's stock
    // reservation in the same transaction refuses a dish that ran out after the pre-check.
    prepareCurrent: async ({ snapshot, capacityLink: link }) =>
      reported(async () => {
        prepared = null;
        if (snapshot.orderReference !== selected.orderReference)
          throw new Error("ADDITIONAL_CURRENT_DENIED");
        const currentCheckout = createInternalCheckout(
          resources,
          {
            // Only the checkout ports are used (their reads each in a transaction of their own);
            // the Cart's table binding is read as the guest's access reads it.
            entry: { session: {} },
            binding: (runner) => runner.run((tx) => checkout.accessOptions.binding(tx)),
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
            // The guest's session, in a transaction of its own (no connection is held meanwhile).
            authorize: async () => ({
              guestSession: await transactions.run((tx) =>
                new GuestSessionService({
                  ...diningCheckout.identity(tx).session,
                  now,
                  admission: { consume: async () => null },
                }).authorize(credentials),
              ),
            }),
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
            // Owner #26 (DEC-PRICE-HOLD): a listing since checkout leaves the same dish (product
            // version, checked here) at the held price; only the menu version may be newer.
            delete line.menuVersionReference;
            return line;
          });
        // WP-2423 expected refusals: the menu moved on since checkout (a price, option or name
        // changed), or the checkout window lapsed while the guest decided. Nothing is sent; the
        // cart prices again (the guest's plain "the menu changed"), not "unavailable, try again".
        if (JSON.stringify(lines(fresh)) !== JSON.stringify(lines(v)) || now() >= fresh.validUntil)
          throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
        prepared = {
          submissionReference: snapshot.batch.submissionReference,
          link,
          validUntil: fresh.validUntil,
          menuVersionReferences: fresh.catalogLines.map((line) => line.menuVersionReference),
          sellableReferences: fresh.catalogLines.map((line) => line.sellableReference),
        };
      }),
    validateCurrent: async (tx, snapshot, link, context) =>
      reported(async () => {
        const before = prepared;
        if (
          before === null ||
          before.submissionReference !== snapshot.batch.submissionReference ||
          snapshot.orderReference !== selected.orderReference ||
          JSON.stringify(before.link) !== JSON.stringify(link) ||
          context.cart.aggregateVersion !== v.cartVersion ||
          context.cart.cartReference !== v.cartReference ||
          !(await access.authorizeInTransaction(tx, authority, now()))
        )
          throw new Error("ADDITIONAL_CURRENT_DENIED");
        if (now() >= link.validUntil) throw new Error("ADDITIONAL_CAPACITY_CHANGED");
        // The checkout window lapsed between the pre-check and the write: the cart prices again.
        if (now() >= before.validUntil)
          throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
        // The round's own time ahead of the server clock: no moment of service does that.
        if (context.observedAt > now()) throw new Error("ADDITIONAL_CLOCK_AHEAD");
        // What the pre-check read is still in effect: the same menu release, every dish and every
        // chosen choice still on sale (a staff sold-out mark made since is caught here).
        const standing = await confirmCatalogSaleStillCurrent(tx, {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          menuReference: catalogOptions.catalogScope.menuReference,
          channelCode: catalogOptions.catalogScope.channelCode,
          orderTypeCode: "DINE_IN",
          observedAt: now(),
          menuVersionReferences: before.menuVersionReferences,
          sellableReferences: before.sellableReferences,
          optionReferences: context.cart.items.flatMap((item) =>
            item.optionSelections.map((option) => option.optionReference),
          ),
        });
        if (standing === "MenuChanged")
          throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
        // A dish or choice marked sold out (or no longer offered) since the pre-check: answered as
        // stock running out at the write is (the guest's "a dish ran out", staff's "can't be
        // sold now"; the round's dishes leave the Cart and nothing is ordered or charged).
        if (standing !== "Current") throw new OrderCreationError("ORDER_CREATE_STOCK_SHORT");
      }),
  };
  const tip = {
    preparation: diningCheckout.preparation,
    quoteVersion: 2,
    authorizeOrder,
    tip: {
      repository: createPostgresPaymentTipSelectionStore(transactions, scope, { now }, (tx) =>
        readPublishedStoreTipOff(tx, scope),
      ),
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
