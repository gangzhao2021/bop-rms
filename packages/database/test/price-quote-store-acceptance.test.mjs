import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPriceQuoteStore,
  createPriceQuote,
  encodePriceQuoteSnapshot,
} from "../../rms/pricing/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const id = (n) => `018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function check(value, code) {
  if (!value) throw new Error(`WP2227_${code}`);
}
function failure(phase) {
  return new Error(`WP2227_${phase}_FAILED`);
}
function equal(a, b, code) {
  check(JSON.stringify(a) === JSON.stringify(b), code);
}
async function denied(action, code) {
  let actual;
  try {
    await action();
  } catch (error) {
    actual = error?.code;
  }
  check(actual === code, "EXPECTED_CONTROLLED_REFUSAL");
}
function quote() {
  const source = globalThis.structuredClone(input());
  source.priceBook.entries[0].amount.amountMinor = 9007199254740993n;
  source.lines[0].quantity = 1;
  source.lines.unshift({ ...source.lines[0], lineReference: id(80) });
  source.taxConfiguration.rules.push({
    ...source.taxConfiguration.rules[0],
    ruleReference: id(81),
    calculationOrder: 2,
    compoundOnPriorTax: true,
    rate: "0.05",
    taxComponentCode: "SYNTHETIC_SECOND",
  });
  return createPriceQuote(source);
}

it("stores full immutable Quote evidence with exact money, scoped replay, Audit and rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2227_quote" }, async (database) => {
    const admin = new Client(database.clientConfig),
      pools = [];
    const role = `bop_wp2227_${database.runId}`;
    const q = quote();
    let next = 1000,
      taxIds = 0,
      roleCreated = false,
      auditedRollback = false,
      phase = "SETUP";
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roleCreated = true;
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_pricing, platform_helpers, platform_audit TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON rms_pricing.price_quote, rms_pricing.price_quote_line, rms_pricing.price_quote_tax_line, platform_audit.audit_record TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON platform_audit.audit_chain_head TO ${role}`,
      );
      function runner(store = q.storeReference, brand = q.brandReference, fail = false) {
        const pool = new Pool({
          ...database.clientConfig,
          max: 4,
          connectionTimeoutMillis: 5000,
          query_timeout: 5000,
        });
        pools.push(pool);
        const base = createTenantTransactionRunner(
          {
            options: pool.options,
            async connect() {
              const client = await pool.connect();
              try {
                await client.query(`SET ROLE ${role}`);
                return client;
              } catch {
                client.release(true);
                throw failure("ROLE");
              }
            },
          },
          { brandId: brand, storeId: store },
        );
        return {
          run(action) {
            return base.run(async (tx) => {
              let audited = false;
              const result = await action({
                async query(sql, values) {
                  const response = await tx.query(sql, values);
                  if (sql.startsWith("INSERT INTO platform_audit.audit_record")) audited = true;
                  return response;
                },
              });
              if (fail && audited) {
                auditedRollback = true;
                throw failure("INJECTED_ROLLBACK");
              }
              return result;
            });
          },
        };
      }
      function store(scopeStore = q.storeReference, brand = q.brandReference, fail = false) {
        return createPostgresPriceQuoteStore({
          brandReference: brand,
          storeReference: scopeStore,
          runner: runner(scopeStore, brand, fail),
          nextTaxLineReference() {
            taxIds += 1;
            return id(next++);
          },
        });
      }
      function audit(snapshot) {
        return {
          auditId: id(next++),
          brandId: snapshot.brandReference,
          storeId: snapshot.storeReference,
          actor: { type: "System" },
          actionCode: "PRICING_QUOTE_CREATE",
          targetType: "PricingQuote",
          targetId: snapshot.quoteReference,
          reasonCode: "AUTHORIZED_PRICE_QUOTE",
          correlationId: id(next++),
          occurredAt: snapshot.createdAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        };
      }
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::int FROM rms_pricing.price_quote) AS headers,
        (SELECT count(*)::int FROM rms_pricing.price_quote_line) AS lines,
        (SELECT count(*)::int FROM rms_pricing.price_quote_tax_line) AS taxes,
        (SELECT count(*)::int FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      phase = "CONCURRENT_WRITE";
      const request = { snapshot: q, audit: audit(q) },
        repository = store();
      const results = await Promise.all([repository.save(request), store().save(request)]);
      for (const result of results)
        equal(encodePriceQuoteSnapshot(result), encodePriceQuoteSnapshot(q), "FULL_ROUND_TRIP");
      equal(await counts(), { headers: 1, lines: 2, taxes: 4, audits: 1 }, "EXACTLY_ONCE");
      check(taxIds === 4, "REPLAY_DOES_NOT_ALLOCATE_IDS");
      equal(
        encodePriceQuoteSnapshot(await store().load(q.quoteReference)),
        encodePriceQuoteSnapshot(q),
        "FRESH_READ",
      );
      check(Object.isFrozen(results[0].lines[0].taxResolution.rules), "IMMUTABLE_RESULT");
      check(results[0].lines[0].lineReference === id(80), "SOURCE_LINE_ORDER");
      check(results[0].lines[0].unitPrice.amountMinor === 9007199254740993n, "BIGINT_PRECISION");
      const changed = { ...q, inputDigest: `sha256:${"f".repeat(64)}` };
      await denied(
        () => repository.save({ snapshot: changed, audit: audit(changed) }),
        "QUOTE_STORE_CONFLICT",
      );
      equal(await counts(), { headers: 1, lines: 2, taxes: 4, audits: 1 }, "CONFLICT_UNCHANGED");

      phase = "SCOPE";
      check((await store(id(999)).load(q.quoteReference)) === null, "FOREIGN_STORE_ABSENT");
      check(
        (await store(q.storeReference, id(999)).load(q.quoteReference)) === null,
        "FOREIGN_BRAND_ABSENT",
      );
      check((await store().load(id(999))) === null, "MISSING_QUOTE");
      const foreign = runner(id(999));
      for (const table of ["price_quote", "price_quote_line", "price_quote_tax_line"]) {
        const result = await foreign.run((tx) =>
          tx.query(`SELECT count(*)::int AS n FROM rms_pricing.${table}`, []),
        );
        check(result.rows[0].n === 0, "FORCED_RLS");
      }
      const raw = (
        await admin.query(
          `SELECT to_jsonb(q)::text AS document FROM rms_pricing.price_quote q WHERE price_quote_id=$1`,
          [q.quoteReference],
        )
      ).rows[0].document;
      await denied(
        () =>
          foreign.run((tx) =>
            tx.query(
              `INSERT INTO rms_pricing.price_quote SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote,$1::jsonb)).*`,
              [raw.replaceAll(q.quoteReference, id(990))],
            ),
          ),
        "TENANT_DATABASE_TRANSACTION_FAILED",
      );

      phase = "REQUOTING_AND_ROLLBACK";
      const replacement = { ...q, quoteReference: id(30) };
      await repository.save({ snapshot: replacement, audit: audit(replacement) });
      equal(await counts(), { headers: 2, lines: 4, taxes: 8, audits: 2 }, "REQUOTING_HISTORY");
      const candidate = { ...q, quoteReference: id(40) };
      await denied(
        () =>
          store(q.storeReference, q.brandReference, true).save({
            snapshot: candidate,
            audit: audit(candidate),
          }),
        "QUOTE_STORE_UNAVAILABLE",
      );
      check(auditedRollback, "FAILURE_AFTER_AUDIT");
      equal(await counts(), { headers: 2, lines: 4, taxes: 8, audits: 2 }, "ATOMIC_ROLLBACK");
      check((await store().load(candidate.quoteReference)) === null, "ROLLED_BACK_READ");
      const occupied = (
        await admin.query(
          `SELECT price_quote_tax_line_id::text AS id FROM rms_pricing.price_quote_tax_line LIMIT 1`,
        )
      ).rows[0].id;
      const collisionStore = createPostgresPriceQuoteStore({
        brandReference: q.brandReference,
        storeReference: q.storeReference,
        runner: runner(),
        nextTaxLineReference: () => occupied,
      });
      await denied(
        () => collisionStore.save({ snapshot: candidate, audit: audit(candidate) }),
        "QUOTE_STORE_UNAVAILABLE",
      );
      equal(await counts(), { headers: 2, lines: 4, taxes: 8, audits: 2 }, "MID_WRITE_ROLLBACK");

      phase = "LEGACY_AND_CORRUPTION";
      async function cloneHeader(reference, legacy = false, corrupt = false) {
        await admin.query(
          `INSERT INTO rms_pricing.price_quote
          SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote,
            to_jsonb(h) || jsonb_build_object('price_quote_id',$1::text,
              'snapshot_json',CASE WHEN $3::boolean THEN NULL ELSE jsonb_set(h.snapshot_json,'{snapshot,quoteReference}',to_jsonb($1::text)) END,
              'subtotal_minor',h.subtotal_minor + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
              'total_minor',h.total_minor + CASE WHEN $4::boolean THEN 1 ELSE 0 END))).*
          FROM rms_pricing.price_quote h WHERE price_quote_id=$2`,
          [reference, q.quoteReference, legacy, corrupt],
        );
      }
      await cloneHeader(id(50), true);
      await denied(() => repository.load(id(50)), "QUOTE_STORE_SNAPSHOT_UNAVAILABLE");
      const legacyCandidate = { ...q, quoteReference: id(50) };
      await denied(
        () => repository.save({ snapshot: legacyCandidate, audit: audit(legacyCandidate) }),
        "QUOTE_STORE_SNAPSHOT_UNAVAILABLE",
      );
      await cloneHeader(id(54));
      await denied(() => repository.load(id(54)), "QUOTE_STORE_UNAVAILABLE");
      await denied(
        () =>
          admin.query(
            `INSERT INTO rms_pricing.price_quote
        SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote, to_jsonb(h) || jsonb_build_object(
          'price_quote_id',$1::text,'snapshot_json',jsonb_set(h.snapshot_json,'{snapshot,quoteReference}',to_jsonb($1::text)) || '{"version":2}'::jsonb))).*
        FROM rms_pricing.price_quote h WHERE price_quote_id=$2`,
            [id(55), q.quoteReference],
          ),
        "23514",
      );
      await cloneHeader(id(51), false, true);
      await denied(() => repository.load(id(51)), "QUOTE_STORE_UNAVAILABLE");
      // Corrupt synthetic mirrors are appended as new records; no immutable history is rewritten.
      for (const mode of ["line", "tax"]) {
        const reference = id(mode === "line" ? 52 : 53);
        await cloneHeader(reference);
        await admin.query(
          `INSERT INTO rms_pricing.price_quote_line
          SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote_line,
            to_jsonb(l) || jsonb_build_object('price_quote_id',$1::text,
              'product_version_id',CASE WHEN $3::boolean THEN $4::text ELSE l.product_version_id::text END))).*
          FROM rms_pricing.price_quote_line l WHERE price_quote_id=$2`,
          [reference, q.quoteReference, mode === "line", id(995)],
        );
        const taxReferences = (
          await admin.query(
            `SELECT price_quote_tax_line_id::text AS reference FROM rms_pricing.price_quote_tax_line WHERE price_quote_id=$1`,
            [q.quoteReference],
          )
        ).rows;
        for (const tax of taxReferences)
          await admin.query(
            `INSERT INTO rms_pricing.price_quote_tax_line
          SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote_tax_line,
            to_jsonb(t) || jsonb_build_object('price_quote_id',$1::text,'price_quote_tax_line_id',$3::text,
              'tax_minor',t.tax_minor + CASE WHEN $4::boolean THEN 1 ELSE 0 END))).*
          FROM rms_pricing.price_quote_tax_line t WHERE price_quote_tax_line_id=$2`,
            [reference, tax.reference, id(next++), mode === "tax"],
          );
        await denied(() => repository.load(reference), "QUOTE_STORE_UNAVAILABLE");
      }
      const before = await counts();
      for (const table of ["price_quote", "price_quote_line", "price_quote_tax_line"]) {
        check(
          (await admin.query(`UPDATE rms_pricing.${table} SET currency_code='USD'`)).rowCount === 0,
          "IMMUTABLE_UPDATE",
        );
        check(
          (await admin.query(`DELETE FROM rms_pricing.${table}`)).rowCount === 0,
          "IMMUTABLE_DELETE",
        );
      }
      equal(await counts(), before, "HISTORY_UNCHANGED");
      await repository.save(request);
      equal(await counts(), before, "FINAL_REPLAY_UNCHANGED");
    } catch (error) {
      if (error instanceof Error && /^WP2227_[A-Z0-9_]+$/u.test(error.message)) throw error;
      throw failure(phase);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      try {
        if (roleCreated) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      } finally {
        await admin.end();
      }
    }
  });
}, 180_000);
