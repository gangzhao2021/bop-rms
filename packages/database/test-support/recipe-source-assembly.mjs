import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  createRecipeCoverageSourceAssembly,
  createPostgresRecipeCoveragePublicationStore,
  createPostgresRecipeOwnerCoverageSource,
  createPostgresRecipePreparationCoverageSource,
  createPostgresRecipeSubstitutionCoverageSource,
  createPostgresRecipeUsageCoverageSource,
} from "../../rms/recipe/src/index.ts";
import { createPostgresInventoryRecipeConfigurationSource } from "../../rms/inventory/src/index.ts";
import { createPostgresCatalogAllergenCoverageSource } from "../../rms/catalog/src/index.ts";
/** Six actual owner adapters/publication, explicit synthetic Supplier/IAM/directory leases. */
export async function exerciseRecipeSourceAssembly({ admin, context, role, id, at }) {
  const scope = { tenantReference: id(50001), brandReference: id(50002) },
    held = new Set();
  let sequence = 51000,
    authorityHeld = 0,
    directoryHeld = 0,
    writing;
  const writer = new pg.Client(context.clientConfig);
  await writer.connect();
  await writer.query("SET lock_timeout='5s'");
  function runner(publication = false) {
    return {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
          if (publication) {
            assert.equal(authorityHeld, 1);
            assert.equal(directoryHeld, 1);
            assert.equal(held.size, 7);
            if (!writing) {
              writing = (async () => {
                await writer.query("BEGIN");
                try {
                  await writer.query(
                    "INSERT INTO rms_catalog.allergen_registry_version(registry_version_id,brand_id,jurisdiction_code,policy_document_digest,reviewed_at,reviewer_actor_id,status) VALUES($1,$2,'ON',$3,$4,$5,'Approved')",
                    [id(52000), scope.brandReference, `sha256:${"a".repeat(64)}`, at, id(3)],
                  );
                  await writer.query(
                    "INSERT INTO rms_catalog.allergen_registry_entry(registry_version_id,brand_id,allergen_id,allergen_code,localized_names_json) VALUES($1,$2,$3,'MILK',$4::jsonb)",
                    [
                      id(52000),
                      scope.brandReference,
                      id(52001),
                      JSON.stringify({ "en-CA": "Synthetic assembly milk" }),
                    ],
                  );
                  await writer.query("COMMIT");
                } catch (error) {
                  await writer.query("ROLLBACK");
                  throw error;
                }
              })().then(
                (value) => ({ ok: true, value }),
                (error) => ({ ok: false, error }),
              );
              let blocked = false;
              for (let n = 0; n < 100; n++) {
                const row = (
                  await admin.query(
                    "SELECT wait_event_type AS kind FROM pg_stat_activity WHERE pid=$1",
                    [writer.processID],
                  )
                ).rows[0];
                if (row?.kind === "Lock") {
                  blocked = true;
                  break;
                }
                await delay(10);
              }
              assert.equal(blocked, true);
            }
          }
          await client.query("COMMIT");
          if (publication) {
            assert.equal(authorityHeld, 1);
            assert.equal(directoryHeld, 1);
            assert.equal(held.size, 7);
          }
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
  }
  const options = {
    runner: runner(),
    scope,
    generateReference: () => id(++sequence),
    authorize: async () => authorityHeld === 1,
    usageStores: {
      async withCurrent(_request, work) {
        directoryHeld++;
        try {
          return await work({
            ...scope,
            snapshotReference: id(50003),
            digest: `sha256:${"d".repeat(64)}`,
            complete: true,
            storeReferences: [],
          });
        } finally {
          directoryHeld--;
        }
      },
    },
  };
  const supplierRead = {
    coverage: {
      ...scope,
      family: "Supplier",
      snapshotReference: id(50004),
      digest: `sha256:${"e".repeat(64)}`,
      complete: true,
      dependencies: [],
    },
    capturedAtUtc: at,
    asOfUtc: at,
  };
  const sources = {
    Recipe: createPostgresRecipeOwnerCoverageSource(options),
    Inventory: createPostgresInventoryRecipeConfigurationSource(options),
    Allergen: createPostgresCatalogAllergenCoverageSource(options),
    Preparation: createPostgresRecipePreparationCoverageSource(options),
    Substitution: createPostgresRecipeSubstitutionCoverageSource(options),
    Usage: createPostgresRecipeUsageCoverageSource(options),
    Supplier: {
      async capture() {
        assert.equal(authorityHeld, 1);
        return supplierRead;
      },
      async withCurrent(_request, _read, work) {
        return work(supplierRead);
      },
    },
  };
  for (const [family, owner] of Object.entries(sources)) {
    sources[family] = {
      capture: owner.capture,
      async withCurrent(input, read, work) {
        return owner.withCurrent(input, read, async (current) => {
          held.add(family);
          try {
            return await work(current);
          } finally {
            held.delete(family);
          }
        });
      },
    };
  }
  const authority = {
    async withAuthorizedScope(input, work) {
      assert.deepEqual(input, {
        ...scope,
        actorReference: id(3),
        purpose: "RecipeProjectionBuild",
        observedAtUtc: at,
      });
      authorityHeld++;
      try {
        return await work();
      } finally {
        authorityHeld--;
      }
    },
  };
  const assembly = createRecipeCoverageSourceAssembly({ scope, sources, authorization: authority });
  const request = { actorReference: id(3), purpose: "RecipeProjectionBuild", observedAtUtc: at };
  try {
    const captured = await assembly.capture(request);
    assert.equal(captured.sources.length, 7);
    assert.equal(authorityHeld, 0);
    assert.equal(directoryHeld, 0);
    assert.equal(held.size, 0);
    let rejectedCode = null;
    const fence = {
      async withAuthorizedCurrentCoverage(input, work) {
        try {
          return await assembly.withAuthorizedCurrentCoverage(input, work);
        } catch (error) {
          rejectedCode = error.code;
          throw error;
        }
      },
    };
    const publisher = createPostgresRecipeCoveragePublicationStore(runner(true), scope, fence);
    const input = {
      generationReference: id(53000),
      actorReference: id(3),
      purpose: "RecipeProjectionBuild",
      builtAt: at,
      expectedRevision: "0",
      coverage: captured,
    };
    const result = await publisher.publish(input);
    assert.equal(result.publicationRevision, "1");
    assert.equal(result.active, true);
    assert.equal(authorityHeld, 0);
    assert.equal(directoryHeld, 0);
    assert.equal(held.size, 0);
    const written = await writing;
    if (!written.ok) throw written.error;
    await assert.rejects(
      publisher.publish({ ...input, generationReference: id(53001), expectedRevision: "1" }),
      (error) => {
        assert.equal(rejectedCode, "RECIPE_COVERAGE_CHANGED");
        return error.code === "RECIPE_COVERAGE_CHANGED";
      },
    );
    // Real source append cannot be accepted by retrying an old generation's inputs.
    const next = await assembly.capture(request);
    assert.notEqual(
      next.sources.find((s) => s.family === "Allergen").snapshotReference,
      captured.sources.find((s) => s.family === "Allergen").snapshotReference,
    );
    const accepted = await publisher.publish({
      ...input,
      generationReference: id(53002),
      expectedRevision: "1",
      coverage: next,
    });
    assert.equal(accepted.publicationRevision, "2");
    await assert.rejects(
      publisher.publish({
        ...input,
        generationReference: id(53003),
        expectedRevision: "0",
        coverage: next,
      }),
      (error) => error.code === "RECIPE_PUBLICATION_VERSION_CONFLICT",
    );
    assert.equal(
      (
        await publisher.publish({
          ...input,
          generationReference: id(53002),
          expectedRevision: "1",
          coverage: next,
        })
      ).replay,
      true,
    );
    const missing = { ...sources };
    delete missing.Supplier;
    const unavailable = createRecipeCoverageSourceAssembly({
      scope,
      sources: missing,
      authorization: authority,
    });
    await assert.rejects(
      unavailable.capture(request),
      (error) => error.code === "RECIPE_ASSEMBLY_INCOMPLETE",
    );
    assert.equal(authorityHeld, 0);
    assert.equal(directoryHeld, 0);
    assert.equal(held.size, 0);
  } finally {
    if (writing) await writing;
    await writer.end();
  }
}
