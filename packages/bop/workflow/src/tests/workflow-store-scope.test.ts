import { expect, it } from "vitest";
import { createPostgresWorkflowDefinitionStore } from "../index.js";
import { id, at, definition } from "./workflow-definition.fixture.js";
it("keeps owner scope authoritative when runtime query input contains shadow fields", async () => {
  const override = definition({
    workflowReference: id(20),
    versionReference: id(21),
    storeReference: id(10),
    baseVersionReference: id(2),
    overrideAuthorizationReference: id(22),
  });
  const store = createPostgresWorkflowDefinitionStore(
    {
      run: async (work) =>
        work({
          query: async (sql) => ({
            rows: sql.startsWith("SELECT definition_json")
              ? [definition(), override].map((definition) => ({ definition }))
              : [],
          }),
        }),
    },
    { tenantReference: id(3), brandReference: id(4), storeReference: id(10) },
  );
  const query = {
    purposeCode: "OrderFulfillment",
    applicabilityCode: "Pickup",
    observedAt: at,
    tenantReference: id(99),
    brandReference: id(99),
    storeReference: id(99),
    versions: [],
  };
  expect((await store.resolveCurrent(query)).definition.versionReference).toBe(id(21));
});
