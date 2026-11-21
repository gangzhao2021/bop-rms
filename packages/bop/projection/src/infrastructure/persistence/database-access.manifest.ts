const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "projection", packageName: "@bop/projection", layer: "BOP" },
  tables: [],
  accesses: [
    {
      id: "order-exception-source.read",
      operation: "read",
      mechanism: "raw-sql",
      target: { schema: "platform_projection", table: "order_exception_source" },
      principal: { kind: "projection-builder", id: "@bop/projection.order-exception.v1" },
      readPattern: "public-query-contract",
      source:
        "packages/bop/projection/src/infrastructure/persistence/order-exception-source-store.ts",
    },
    {
      id: "order-exception-source.write",
      operation: "write",
      mechanism: "raw-sql",
      target: { schema: "platform_projection", table: "order_exception_source" },
      principal: { kind: "projection-builder", id: "@bop/projection.order-exception.v1" },
      readPattern: null,
      source:
        "packages/bop/projection/src/infrastructure/persistence/order-exception-source-store.ts",
    },
  ],
} as const;
export const databaseAccessManifest = databaseAccessManifestInput;
export default databaseAccessManifest;
