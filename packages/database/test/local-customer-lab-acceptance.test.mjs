import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  startCustomerLab,
  verifyCustomerLab,
} from "../../../apps/customer-pwa/scripts/local-customer-lab.mjs";
import {
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createCustomerPickupCheckoutDetailsComposition } from "../../../apps/api/src/customer-checkout-details-composition.ts";
import { createCustomerCheckoutSessionAuthorization } from "../../../apps/api/src/customer-checkout-session-authorization.ts";
import { createCustomerPickupSessionValidation } from "../../../apps/api/src/customer-pickup-session-validation.ts";
import { createCustomerCartSelectionInventory } from "../../../apps/api/src/customer-cart-selection-inventory.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import {
  fixture,
  id,
  now as at,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client, Pool } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };
import { seedDining } from "../test-support/local-customer-dining-seed.mjs";
import { seedMenu } from "../test-support/local-customer-menu-seed.mjs";
import { prepareEntryPickupCheckout } from "../test-support/entry-pickup-checkout.mjs";
import {
  createPostgresCartQueryStore,
  createPostgresCartQuoteStore,
} from "../../rms/ordering/src/index.ts";
import { createHash } from "node:crypto";
import { verifyPickupQuoteLab } from "../../../apps/customer-pwa/scripts/pickup-quote-lab.mjs";
import { seedPickup } from "../test-support/local-customer-pickup-seed.mjs";
import { seedCart } from "../test-support/local-customer-cart-seed.mjs";
const modes =
  process.env.BOP_LOCAL_CUSTOMER_MODE === "pickup"
    ? ["Pickup"]
    : process.env.BOP_LOCAL_CUSTOMER_MODE === "dining" ||
        process.env.BOP_LOCAL_CUSTOMER_INTERACTIVE === "1"
      ? ["DineIn"]
      : ["DineIn", "Pickup"];
for (const mode of modes)
  it(
    "runs isolated browser " +
      mode +
      " entry, persisted Cart and " +
      (mode === "Pickup" ? "CheckoutSession with payment gated" : "Dining admission"),
    async () => {
      await withIsolatedDatabase(
        { caseId: mode === "Pickup" ? "wp2401_pickup" : "wp2222_runtime" },
        async (context) => {
          const admin = new Client(context.clientConfig);
          const pool = new Pool({
            ...context.clientConfig,
            max: 2,
            connectionTimeoutMillis: 2000,
            query_timeout: 5000,
          });
          const sessionRole = `wp2222_s_${context.runId}`;
          const menuRole = `wp2222_m_${context.runId}`;
          const observedAt = mode === "Pickup" ? new Date(Date.now() - 1000).toISOString() : at;
          const runtimeNow = () => (mode === "Pickup" ? new Date().toISOString() : observedAt);
          const f = fixture(observedAt);
          if (mode === "Pickup") {
            f.payload.channel = f.context.channel = "Pickup";
            f.context.tableLifecycle = f.context.assignmentState = null;
            f.payload.publicTableReference = null;
            f.context.publicTableReference = null;
            f.context.tableReference = null;
          }
          const key = randomBytes(32);
          const credentials = createGuestSessionCredentialProvider(key);
          const logs = [];

          let runtime;
          let dining;
          let pickup;
          let lab;
          const priorLabFlag = process.env.BOP_LOCAL_CUSTOMER_LAB;
          process.env.BOP_LOCAL_CUSTOMER_LAB = "1";
          let sequence = 600;

          await admin.connect();
          try {
            for (const role of [sessionRole, menuRole]) {
              assert.match(role, /^wp2222_[sm]_[a-f0-9]+$/u);
              await admin.query(
                `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
              );
              await admin.query(`GRANT USAGE ON SCHEMA platform_helpers TO ${role}`);
              await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
              await admin.query(
                `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
              );
            }
            await admin.query(`GRANT USAGE ON SCHEMA bop_identity TO ${sessionRole}`);
            await admin.query(
              `GRANT SELECT, INSERT ON bop_identity.guest_session, bop_identity.guest_session_operation TO ${sessionRole}`,
            );
            await admin.query(`GRANT USAGE ON SCHEMA rms_catalog TO ${menuRole}`);
            await admin.query(
              `GRANT SELECT ON rms_catalog.published_menu_projection_generation, rms_catalog.published_menu_projection, rms_catalog.published_menu_projection_section, rms_catalog.published_menu_projection_sellable, rms_catalog.published_menu_projection_checkpoint, rms_catalog.menu_release_effective_period, rms_catalog.menu_publication_release, rms_catalog.menu_publication_revision, rms_catalog.menu_version_store, rms_catalog.menu_version_channel, rms_catalog.menu_version_order_type TO ${menuRole}`,
            );
            if (mode === "DineIn") await seedMenu(admin, mode);
            const sessionRunner = createTenantTransactionRunner(
              {
                options: pool.options,
                async connect() {
                  const client = await pool.connect();
                  try {
                    await client.query(`SET ROLE ${sessionRole}`);
                    return client;
                  } catch (error) {
                    client.release(true);
                    throw error;
                  }
                },
              },
              { brandId: scope.brandReference, storeId: scope.storeReference },
            );
            const sessionTransactions = {
              async run(action) {
                return sessionRunner.run(action);
              },
            };
            const menuTransactions = {
              async run(action) {
                const client = new Client(context.clientConfig);
                await client.connect();
                try {
                  await client.query("BEGIN READ ONLY");
                  await client.query(`SET LOCAL ROLE ${menuRole}`);
                  await client.query("SET LOCAL statement_timeout='5s'");
                  assert.equal(
                    (await client.query("SHOW transaction_read_only")).rows[0]
                      .transaction_read_only,
                    "on",
                  );
                  const value = await action({
                    query: (sql, values) => client.query(sql, [...values]),
                  });
                  await client.query("COMMIT");
                  const cleared = await client.query(
                    "SELECT current_setting('bop.brand_id',true) AS brand, current_setting('bop.store_id',true) AS store",
                  );
                  assert(!cleared.rows[0].brand && !cleared.rows[0].store);
                  return value;
                } catch (error) {
                  await client.query("ROLLBACK");
                  throw error;
                } finally {
                  await client.end();
                }
              },
            };
            dining =
              mode === "DineIn"
                ? await seedDining({ admin, context, sessionRole, sessionTransactions, fixture: f })
                : undefined;
            const cart = dining ? await seedCart({ admin, context, dining }) : undefined;
            pickup =
              mode === "Pickup"
                ? await seedPickup({ admin, context, sessionRole, observedAt })
                : undefined;
            let detailsSequence = 9000;
            const checkoutDetails =
              pickup === undefined
                ? undefined
                : {
                    quoteVersion: 1,
                    ...createCustomerPickupCheckoutDetailsComposition({
                      scope,
                      quoteVersion: 1,
                      cartTransactions: pickup.options.cartTransactions,
                      detailsTransactions: pickup.checkoutDetailsTransactions,
                      policies: {
                        current: async (input) => ({
                          brandReference: input.brandReference,
                          storeReference: input.storeReference,
                          orderType: input.orderType,
                          checkedAt: input.observedAt,
                          validUntil: new Date(
                            Date.parse(input.observedAt) + 120_000,
                          ).toISOString(),
                          required: [],
                        }),
                      },
                      audit: async (input) => ({
                        auditId: id(++detailsSequence),
                        brandId: scope.brandReference,
                        storeId: scope.storeReference,
                        actor: { type: "System" },
                        actionCode: "ORDERING_CHECKOUT_DETAILS_SAVE",
                        targetType: "CheckoutDetails",
                        targetId: input.detailsReference,
                        reasonCode: "AUTHORIZED_CHECKOUT_UPDATE",
                        correlationId: input.operationReference,
                        occurredAt: input.observedAt,
                        sourceChannel: "CUSTOMER_PWA",
                        dataClassification: "Restricted",
                        retentionPolicyCode: "AUDIT_DEFAULT",
                        retentionPolicyVersion: 1,
                      }),
                      now: runtimeNow,
                      session: {
                        ...f.options.session,
                        credentials,
                        store: createPostgresGuestSessionEntryStore(sessionTransactions, scope),
                      },
                    }),
                  };
            const checkoutSession =
              pickup === undefined
                ? undefined
                : await prepareEntryPickupCheckout({
                    admin,
                    role: pickup.orderingRole,
                    run: pickup.orderingTransactions.run,
                    scope,
                    at: observedAt,
                    now: runtimeNow,
                    capacityLimit: 2,
                    session: { credentials, binding: f.options.session.binding },
                    binding: () => f.options.session.binding,
                  });
            if (checkoutSession !== undefined) {
              pickup.checkoutSessionFailures = checkoutSession.failures;
              pickup.checkoutStages = [];
              const track = async (stage, work) => {
                pickup.checkoutStages.push({ stage, result: "started" });
                try {
                  const result = await work();
                  pickup.checkoutStages.push({ stage, result: "completed" });
                  return result;
                } catch (error) {
                  pickup.checkoutStages.push({
                    stage,
                    result: "failed",
                    errorType:
                      typeof error?.name === "string" &&
                      /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)
                        ? error.name
                        : "Error",
                    code: /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : "UNKNOWN",
                  });
                  throw error;
                }
              };
              const hashIntent = (value) =>
                "sha256:" + createHash("sha256").update(value).digest("hex");
              const carts = createPostgresCartQueryStore(
                { run: pickup.orderingTransactions.run },
                scope,
              );
              const quotes = createPostgresCartQuoteStore(
                { run: pickup.orderingTransactions.run },
                scope,
                { hashIntent, equals: (left, right) => left === right },
              );
              checkoutSession.attach(async (input) => {
                const access = createCustomerCheckoutSessionAuthorization(checkoutSession.options, {
                  sessionCredential: input.sessionCredential,
                  csrfCredential: input.csrfCredential,
                  cartReference: input.request.cartReference,
                });
                const catalogOptions = pickup.options.catalogCartItems;
                let selectionObservedAt;
                const catalogOwner = createCustomerCartSelectionInventory(
                  catalogOptions.catalogTransactions,
                  { ...scope, ...catalogOptions.catalogScope, orderType: "Pickup" },
                  {
                    ...catalogOptions.catalogSafety,
                    clock: { now: () => selectionObservedAt ?? runtimeNow() },
                  },
                  {
                    ...catalogOptions.selectedInventory,
                    authorize: async (_inventoryTransaction, selection) => {
                      const authority = await access.authorize(input.request, selection.observedAt);
                      return authority
                        ? checkoutSession.options.transactions.run((tx) =>
                            access.authorizeInTransaction(tx, authority, selection.observedAt),
                          )
                        : false;
                    },
                  },
                );
                const catalog = {
                  async validateSelection(selection) {
                    selectionObservedAt = selection.observedAt;
                    try {
                      return await track("catalog", async () => {
                        const cart = await carts.load(input.request.cartReference);
                        assert(cart);
                        assert.equal(cart.aggregateVersion, input.request.cartVersion);
                        const quantity = cart.items
                          .filter((item) => item.sellableReference === selection.sellableReference)
                          .reduce((sum, item) => sum + item.quantity, 0);
                        return catalogOwner.validateSelection(selection, {
                          diningSessionReference: cart.diningSessionReference,
                          cartReference: cart.cartReference,
                          cartVersion: cart.aggregateVersion,
                          guestSessionReference: input.allocation.guestSessionReference,
                          quantity,
                        });
                      });
                    } finally {
                      selectionObservedAt = undefined;
                    }
                  },
                };
                const preparation = {
                  ...checkoutSession.preparation,
                  prepare: (value) =>
                    track("capacity-prepare", () => checkoutSession.preparation.prepare(value)),
                  prepareForOrdering: (value) =>
                    track("capacity-ordering", () =>
                      checkoutSession.preparation.prepareForOrdering(value),
                    ),
                };
                return createCustomerPickupSessionValidation({
                  preparation,
                  checkout: {
                    catalog,
                    repository: {
                      loadCart: (reference) => carts.load(reference),
                      loadQuote: (reference) =>
                        quotes.loadLatest({
                          cartReference: reference,
                          cartVersion: input.request.cartVersion,
                          observedAt: checkoutSession.options.now(),
                        }),
                    },
                    references: { hashIntent },
                  },
                })(input);
              });
            }
            const options = {
              ...(cart
                ? {
                    cartTransactions: cart.cartTransactions,
                    diningCart: cart.diningCart,
                    diningAdmission: dining.options,
                  }
                : pickup.options),
              scope,
              // Synthetic request admission for this isolated browser/Cart fixture.
              entryRequestAdmission: { consume: async () => ({ status: "Allowed" }) },
              entry: { ...f.options, session: { binding: f.options.session.binding, credentials } },
              menuStores: {
                resolvePublic: async (reference) =>
                  reference === id(4) ? { ...scope, status: "Active" } : null,
              },
              sessionTransactions,
              menuTransactions,
              ...(checkoutDetails === undefined ? {} : { checkoutDetails }),
              ...(checkoutSession === undefined
                ? {}
                : { checkoutSessions: checkoutSession.options }),
              allowedOrigin: "https://127.0.0.1:5184",
              now: runtimeNow,
              uuidV7Factory: () => id(++sequence),
              runtime: {
                logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
              },
            };
            runtime = createLocalCustomerRuntime(options);
            await runtime.listen();
            const address = runtime.server.address();
            assert(address && typeof address === "object");
            let stop;
            const stopped = new Promise((resolve) => {
              stop = resolve;
            });
            lab = await startCustomerLab({
              apiOrigin: `http://127.0.0.1:${address.port}`,
              token: f.token,
              diningAdmissionEnabled: mode === "DineIn",
              quoteEnabled: mode === "Pickup",
              cartEnabled: true,
              stop: () => stop(),
            });
            assert.equal(lab.origin, options.allowedOrigin);
            if (pickup) await verifyPickupQuoteLab(lab.origin, pickup);
            else
              await verifyCustomerLab(
                lab.origin,
                async () =>
                  (
                    await admin.query(
                      "SELECT count(*)::int AS count FROM bop_identity.guest_session",
                    )
                  ).rows[0].count,
                process.env.BOP_LOCAL_CUSTOMER_INTERACTIVE !== "1",
                dining,
                cart,
              );
            if (process.env.BOP_LOCAL_CUSTOMER_INTERACTIVE === "1") {
              process.stdout.write(
                `Synthetic local customer lab: ${lab.origin} — expires in 15 minutes.\n`,
              );
              await new Promise((resolve) => {
                const timer = setTimeout(done, 900_000);
                function done() {
                  clearTimeout(timer);
                  process.off("SIGINT", done);
                  process.off("SIGTERM", done);
                  resolve();
                }
                void stopped.then(done);
                process.once("SIGINT", done);
                process.once("SIGTERM", done);
              });
            }
          } finally {
            if (priorLabFlag === undefined) delete process.env.BOP_LOCAL_CUSTOMER_LAB;
            else process.env.BOP_LOCAL_CUSTOMER_LAB = priorLabFlag;
            try {
              try {
                if (lab) await lab.close();
              } finally {
                if (runtime) await runtime.shutdown("SIGTERM");
              }
            } finally {
              try {
                await pool.end();
              } finally {
                await admin.end();
              }
            }
            dining?.close();
            pickup?.close();
            key.fill(0);
          }
        },
      );
    },
    process.env.BOP_LOCAL_CUSTOMER_INTERACTIVE === "1" ? 960_000 : 180_000,
  );
