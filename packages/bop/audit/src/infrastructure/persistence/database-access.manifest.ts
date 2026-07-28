const databaseAccessManifestInput = {
  version: 1,
  module: { moduleName: "audit", packageName: "@bop/audit", layer: "BOP" },
  tables: [],
  accesses: [
    {
      id: "append-audit-record",
      operation: "write",
      mechanism: "raw-sql",
      target: { schema: "platform_audit", table: "audit_record" },
      principal: { kind: "shared-infrastructure", id: "audit-infrastructure" },
      readPattern: null,
      source: "packages/bop/audit/src/infrastructure/persistence/append-audit-record.ts",
    },
    {
      id: "advance-audit-chain-head",
      operation: "write",
      mechanism: "raw-sql",
      target: { schema: "platform_audit", table: "audit_chain_head" },
      principal: { kind: "shared-infrastructure", id: "audit-infrastructure" },
      readPattern: null,
      source: "packages/bop/audit/src/infrastructure/persistence/append-audit-record.ts",
    },
  ],
} as const;

export const databaseAccessManifest = databaseAccessManifestInput;
