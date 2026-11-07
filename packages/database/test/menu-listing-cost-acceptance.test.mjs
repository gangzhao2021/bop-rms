import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: what a listing costs, read from the statements the Owner's real
 * commands send under the restricted role, never from a clock. Submit used to review the menu three
 * times and two of those ran while it held the write fence, so every reader of that family queued
 * behind the review. Now a listing reviews three times in all, once per step that must, and always
 * before that step's first Publishing write.
 */
it("a listing reviews the menu once per step, and never under the write", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_cost" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let store = null;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_ct");
      store = await prepareRealStaffRoundStore({ admin, context, api });
      const { owner, tea } = store;
      await owner.saveDish(
        "Tea charge (TEST)",
        "茶位",
        "175",
        tea.productReference,
        "NoIngredients",
      );
      const transactions = [];
      owner.hooks.onStatement = (sql, values) => {
        const text = typeof sql === "string" ? sql : String(sql?.text ?? "");
        if (text === "BEGIN") transactions.push([]);
        transactions.at(-1)?.push({ text, key: values?.[0] });
      };
      await owner.listAll();
      owner.hooks.onStatement = null;

      // A review reads each sellable's choices under this fence, once per sellable.
      const reviewRead = (statement) =>
        typeof statement.key === "string" && statement.key.startsWith("CatalogOptionContentFence:");
      const sellables = 2;
      // A review also reads the allergen evidence; the listing check and Submit's preparation only
      // count the choice combinations against the review's budget, in short reads of their own.
      const allergenRead = (statement) =>
        typeof statement.key === "string" &&
        statement.key.startsWith("CatalogAllergenEvidenceFence:");
      const reviewing = transactions.filter(
        (statements) => statements.some(reviewRead) && statements.some(allergenRead),
      );
      const counting = transactions.filter(
        (statements) => statements.some(reviewRead) && !statements.some(allergenRead),
      );
      assert.equal(counting.length, 2, "the listing check and Submit count the combinations");
      for (const statements of counting)
        assert.ok(
          !statements.some((statement) =>
            statement.text.includes("INSERT INTO bop_publishing.publishing_mutation_record"),
          ),
          "counting the combinations writes nothing",
        );
      assert.deepEqual(
        reviewing.map((statements) => statements.filter(reviewRead).length),
        [sellables, sellables, sellables],
        "Submit, Approve and Publish each review the menu once",
      );
      const firstWrites = transactions.map((statements) =>
        statements.findIndex((statement) =>
          statement.text.includes("INSERT INTO bop_publishing.publishing_mutation_record"),
        ),
      );
      assert.equal(firstWrites.filter((at) => at >= 0).length, 2, "Submit and Approve write");
      transactions.forEach((statements, index) => {
        const at = firstWrites[index];
        if (at < 0) return;
        for (const statement of statements.slice(at))
          assert.ok(
            !/rms_recipe\.|rms_catalog\.(option|product_option_binding)/u.test(statement.text) &&
              !reviewRead(statement),
            "no recipe or choice is read under the write fence: " + statement.text.slice(0, 80),
          );
      });
    } finally {
      await store?.close().catch(() => undefined);
      await admin.end();
    }
  });
});
