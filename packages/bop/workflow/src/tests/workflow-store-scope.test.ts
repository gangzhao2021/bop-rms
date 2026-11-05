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
it("keeps a resolver refusal as it is and names any other failure as a failed dependency", async () => {
  const scope = { tenantReference: id(3), brandReference: id(4), storeReference: id(10) };
  const query = { purposeCode: "OrderFulfillment", applicabilityCode: "Pickup", observedAt: at };
  const twoFamilies = createPostgresWorkflowDefinitionStore(
    {
      run: async (work) =>
        work({
          query: async (sql) => ({
            rows: sql.startsWith("SELECT definition_json")
              ? [
                  definition(),
                  definition({ workflowReference: id(40), versionReference: id(41) }),
                ].map((definition) => ({ definition }))
              : [],
          }),
        }),
    },
    scope,
  );
  await expect(twoFamilies.resolveCurrent(query)).rejects.toMatchObject({
    code: "WORKFLOW_DEFINITION_UNAVAILABLE",
    rule: "TwoBrandVersions",
  });
  const denied = Object.assign(new Error("permission denied for table"), { code: "42501" });
  const broken = createPostgresWorkflowDefinitionStore(
    {
      run: async (work) =>
        work({
          query: async () => {
            throw denied;
          },
        }),
    },
    scope,
  );
  await expect(broken.resolveCurrent(query)).rejects.toMatchObject({
    code: "WORKFLOW_DEFINITION_UNAVAILABLE",
    message: "Workflow definition is unavailable",
    rule: "Dependency",
    cause: denied,
  });
});
it("reads the latest version of every family in this scope under the purpose lock", async () => {
  const queries: (readonly [string, readonly unknown[]])[] = [];
  const store = createPostgresWorkflowDefinitionStore(
    {
      run: async (work) =>
        work({
          query: async (sql, values) => {
            queries.push([sql, values]);
            return {
              rows: sql.startsWith("SELECT DISTINCT ON")
                ? [{ definition: definition(), operation: id(50) }]
                : [],
            };
          },
        }),
    },
    { tenantReference: id(3), brandReference: id(4), storeReference: null },
  );
  const families = await store.familiesOfPurpose({
    purposeCode: "OrderFulfillment",
    applicabilityCode: "Pickup",
  });
  expect(families).toEqual([
    {
      definition: expect.objectContaining({ versionReference: id(2) }),
      operationReference: id(50),
    },
  ]);
  expect(queries.map(([sql]) => sql.slice(0, 25))).toEqual([
    "SELECT set_config('bop.te",
    "SELECT pg_advisory_xact_l",
    "SELECT DISTINCT ON (workf",
  ]);
  // The same key the database guard locks on a new family's first row.
  expect(queries[1]?.[1]).toEqual([
    `WorkflowPurpose:${id(3)}:${id(4)}:Brand:OrderFulfillment:Pickup`,
  ]);
});
