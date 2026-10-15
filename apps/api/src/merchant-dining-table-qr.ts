import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createDiningTable,
  createDiningTableQrPayload,
  createDiningTableService,
  createPostgresDiningTableQrStore,
  createPostgresDiningTableStore,
  parseDiningInstant,
  parseDiningReference,
  parseQrSignedPayload,
  transitionDiningTable,
  type DiningTable,
  type DiningTableQrIssue,
  type QrSignedPayload,
} from "@rms/dining";
import { createPostgresPublicStoreProfilePublisher } from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { renderTableQrSheet } from "./table-qr-sheet.js";

/**
 * WP-2423 Q11 (DEC-TABLE-QR-ISSUANCE): Store Managers issue, print, replace and turn off the QR
 * code of each table (Section 88 DIN-TABLE-LIST). Every action needs `dining.table.qr.manage` in
 * the current Store, is audited, and changes the table and its code in one transaction. A new code
 * raises the table's QR version, so the previous code stops admitting guests immediately.
 */
export const tableQrPermission = "dining.table.qr.manage";

/** Signs a table code. The pilot uses the TEST-ONLY local key; a managed key replaces it later. */
export interface DiningTableQrSigner {
  sign(payload: QrSignedPayload): Promise<{ readonly keyId: string; readonly token: string }>;
}

export type TableQrCodeState = "SetupIncomplete" | "None" | "Active" | "NotPrintable" | "TurnedOff";
export interface TableQrItem {
  readonly tableReference: string;
  readonly stableLabel: string;
  readonly areaCode: string;
  readonly aggregateVersion: number;
  readonly seated: boolean;
  readonly codeState: TableQrCodeState;
  readonly issuedAt: string | null;
  readonly validUntil: string | null;
}

interface Options {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly newReference: () => string;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
  readonly signer: DiningTableQrSigner;
  /** The Store's public reference and code language, from the Store's published public profile. */
  readonly publicStore: (storeReference: string) => Promise<{
    readonly publicStoreReference: string;
    readonly locale: string;
  } | null>;
  /** Exact HTTPS origin of the customer app that printed codes open. */
  readonly customerOrigin: string;
}

const hashIntent = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const fail = (code = "TABLE_QR_UNAVAILABLE"): never => {
  throw new Error(code);
};

function origin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) return fail();
  return url.origin;
}

function item(table: DiningTable, issue: DiningTableQrIssue | undefined): TableQrItem {
  const matching = issue !== undefined && issue.qrVersion === table.qrVersion;
  const codeState: TableQrCodeState =
    table.lifecycle !== "Published"
      ? "SetupIncomplete"
      : table.qrStatus === "Inactive"
        ? "None"
        : table.qrStatus === "Revoked"
          ? "TurnedOff"
          : matching
            ? "Active"
            : "NotPrintable";
  return Object.freeze({
    tableReference: table.tableReference,
    stableLabel: table.stableLabel,
    areaCode: table.areaCode,
    aggregateVersion: table.aggregateVersion,
    seated: table.activeDiningSessionReference !== null,
    codeState,
    issuedAt: codeState === "Active" && issue ? issue.issuedAt : null,
    validUntil: codeState === "Active" && issue ? issue.expiresAt : null,
  });
}

export function createMerchantDiningTableQr(options: Options) {
  const resolve = createMerchantStoreScope(options.persistence);
  const customerOrigin = origin(options.customerOrigin);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];

  const denied = () => fail("TABLE_QR_PERMISSION_DENIED");

  /**
   * WP-2423: one authorized run. The caller and `dining.table.qr.manage` are resolved in full once
   * at the start and once more before the reply or commit (inside the transaction, so a withdrawn
   * permission or ended Session never commits); owner callbacks in between take the run's
   * no-query guard instead of re-resolving the caller for every table page and write.
   */
  function authorizedRun<T>(
    sessionCookie: unknown,
    sessionReference: string,
    work: (
      tx: Tx,
      run: {
        current: Awaited<ReturnType<typeof resolve>>;
        guard: (transaction?: unknown) => Promise<boolean>;
        scope: { tenantReference: string; brandReference: string; storeReference: string };
        tables: ReturnType<typeof createPostgresDiningTableStore>;
        codes: ReturnType<typeof createPostgresDiningTableQrStore>;
      },
    ) => Promise<T>,
  ) {
    return options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(tx, sessionCookie, tableQrPermission, sessionReference);
            if ((await current.allowed()) !== true) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        (authority) => {
          const current = authority.scope;
          const scope = {
            tenantReference: current.selected.tenantReference,
            brandReference: current.context.brand.brandReference,
            storeReference: current.store.storeReference,
          };
          const runner = { run: <R>(work: (transaction: Tx) => Promise<R>) => work(tx) };
          const tables = createPostgresDiningTableStore(runner, scope, {
            hashIntent,
            equals: (left, right) => left === right,
          });
          const codes = createPostgresDiningTableQrStore(tx, scope);
          return work(tx, {
            current,
            guard: (transaction?: unknown) => authority.guard(transaction),
            scope,
            tables,
            codes,
          });
        },
      ),
    );
  }

  async function listAll(
    tables: ReturnType<typeof createPostgresDiningTableStore>,
    guard: () => Promise<boolean>,
  ) {
    const all: DiningTable[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result = await tables.listTables({
        afterTableReference: after,
        limit: 100,
        authorize: () => guard(),
      });
      all.push(...result.items);
      after = result.nextAfterTableReference;
      if (after === null) return all;
    }
    return fail();
  }

  const url = (token: string) => customerOrigin + "/#qr=" + token;

  return Object.freeze({
    /** Every table of the Store with the state of its printed code. */
    async list(input: { sessionCookie: unknown; csrf: unknown; query: unknown }) {
      const authenticated = await options.authentication.authorize(input);
      readClosedRecord(input.query, []);
      return authorizedRun(
        input.sessionCookie,
        authenticated.sessionReference,
        async (_tx, { guard, tables, codes }) => {
          const all = await listAll(tables, guard);
          const latest = new Map<string, DiningTableQrIssue>();
          for (let i = 0; i < all.length; i += 200)
            for (const [key, value] of await codes.loadLatestForTables(
              all.slice(i, i + 200).map((table) => table.tableReference),
            ))
              latest.set(key, value);
          return Object.freeze({
            items: Object.freeze(all.map((table) => item(table, latest.get(table.tableReference)))),
          });
        },
      );
    },

    /** Issue (first code or replacement) or turn off a table's code; idempotent per operation. */
    async command(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
      const authenticated = await options.authentication.authorize(input);
      const raw = readClosedRecord(input.command, [
        "action",
        "tableReference",
        "expectedAggregateVersion",
        "operationReference",
      ]);
      if (raw.action !== "Issue" && raw.action !== "TurnOff") return fail();
      const action = raw.action === "Issue" ? ("IssueQr" as const) : ("RevokeQr" as const);
      const tableReference = parseDiningReference(raw.tableReference);
      const operationReference = parseDiningReference(raw.operationReference);
      if (
        !Number.isSafeInteger(raw.expectedAggregateVersion) ||
        (raw.expectedAggregateVersion as number) < 1
      )
        return fail();
      const expectedAggregateVersion = raw.expectedAggregateVersion as number;
      return authorizedRun(
        input.sessionCookie,
        authenticated.sessionReference,
        async (_tx, { current, guard, scope, tables, codes }) => {
          const prior = await tables.resolveTableOperation(operationReference);
          type Reason =
            "TABLE_QR_CREATED" | "TABLE_QR_REPLACED" | "TABLE_QR_REISSUED" | "TABLE_QR_TURNED_OFF";
          const reasons: readonly Reason[] = [
            "TABLE_QR_CREATED",
            "TABLE_QR_REPLACED",
            "TABLE_QR_REISSUED",
            "TABLE_QR_TURNED_OFF",
          ];
          let candidate: DiningTable, observedAt: string, reasonCode: Reason;
          let beforeSummary: Record<string, string | number | boolean>,
            afterSummary: Record<string, string | number | boolean>;
          if (prior !== null) {
            if (
              prior.table.tableReference !== tableReference ||
              prior.table.aggregateVersion !== expectedAggregateVersion + 1 ||
              prior.audit.actionCode !== `DINING_TABLE_${action.toUpperCase()}`
            )
              return fail("TABLE_QR_CONFLICT");
            candidate = createDiningTable(prior.table);
            observedAt = candidate.observedAt;
            // A retry repeats the recorded audit exactly.
            const recorded = prior.audit.reasonCode as Reason;
            if (!reasons.includes(recorded)) return fail("TABLE_QR_CONFLICT");
            reasonCode = recorded;
            beforeSummary = { ...(prior.audit.beforeSummary ?? {}) } as typeof beforeSummary;
            afterSummary = { ...(prior.audit.afterSummary ?? {}) } as typeof afterSummary;
          } else {
            const table = await tables.loadTable(tableReference);
            if (!table || table.aggregateVersion !== expectedAggregateVersion)
              return fail("TABLE_QR_CONFLICT");
            if (action === "IssueQr" && table.lifecycle !== "Published")
              return fail("TABLE_QR_CONFLICT");
            if (action === "RevokeQr" && table.qrStatus !== "Active")
              return fail("TABLE_QR_CONFLICT");
            observedAt = parseDiningInstant(current.context.resolvedAt);
            candidate = transitionDiningTable(table, action, parseDiningInstant(observedAt));
            // First code ever, a printed code superseded, or a new code after turn-off / a test code.
            const earlier = await codes.loadLatestForTable(tableReference);
            const printable = table.qrStatus === "Active" && earlier?.qrVersion === table.qrVersion;
            reasonCode =
              action === "RevokeQr"
                ? "TABLE_QR_TURNED_OFF"
                : earlier === null
                  ? "TABLE_QR_CREATED"
                  : printable
                    ? "TABLE_QR_REPLACED"
                    : "TABLE_QR_REISSUED";
            // What changed, never the code itself.
            beforeSummary = {
              tableLabel: table.stableLabel,
              qrStatus: table.qrStatus,
              qrVersion: table.qrVersion,
              printableCode: printable,
              seated: table.activeDiningSessionReference !== null,
            };
            afterSummary = {
              tableLabel: candidate.stableLabel,
              qrStatus: candidate.qrStatus,
              qrVersion: candidate.qrVersion,
              printableCode: action === "IssueQr",
            };
          }
          const service = createDiningTableService({
            references: { hashIntent, equals: (left, right) => left === right },
            authorization: {
              async authorize(request) {
                if (
                  request.action !== action ||
                  request.targetReference !== tableReference ||
                  request.observedAt !== observedAt ||
                  !(await guard())
                )
                  return null;
                return {
                  tenantReference: parseDiningReference(scope.tenantReference),
                  brandReference: parseDiningReference(scope.brandReference),
                  storeReference: parseDiningReference(scope.storeReference),
                  actorReference: parseDiningReference(current.actorReference),
                  purpose: "dining-table" as const,
                  // The Dining table service names its Store permission family; the exact action
                  // this command needs was resolved at the start of this run and is re-checked in
                  // full before the commit.
                  permission: {
                    effect: "Allow" as const,
                    action: "dining.operate" as const,
                    scopeKind: "Store" as const,
                  },
                  audit: {
                    auditId: options.newReference(),
                    brandId: scope.brandReference,
                    storeId: scope.storeReference,
                    actor: { type: "User" as const, reference: current.actorReference },
                    actionCode: `DINING_TABLE_${action.toUpperCase()}`,
                    targetType: "DiningTable",
                    targetId: tableReference,
                    reasonCode,
                    beforeSummary,
                    afterSummary,
                    correlationId: operationReference,
                    occurredAt: observedAt,
                    sourceChannel: "MERCHANT_WEB",
                    dataClassification: "Restricted" as const,
                    retentionPolicyCode: options.retentionPolicyCode,
                    retentionPolicyVersion: options.retentionPolicyVersion,
                  },
                };
              },
            },
            repository: {
              resolveTableOperation: tables.resolveTableOperation,
              loadTable: tables.loadTable,
              async commitTable(record) {
                if (!(await guard())) throw new Error("DINING_TABLE_PERMISSION_DENIED");
                return tables.commitTable(record);
              },
              resolveMoveOperation: async () => null,
              loadSession: async () => null,
              commitMove: async () => fail(),
            },
          });
          const result = await service.executeTable({
            action,
            operationReference,
            expectedAggregateVersion,
            candidate,
            observedAt,
          });
          let issue: DiningTableQrIssue | undefined;
          if (action === "IssueQr") {
            issue = (await codes.loadByOperation(operationReference)) ?? undefined;
            if (issue === undefined) {
              if (result.status !== "Applied") return fail();
              const store = await options.publicStore(scope.storeReference);
              if (store === null) return fail();
              const previous = await codes.loadLatestForTable(tableReference);
              const payload = createDiningTableQrPayload({
                qrReference: options.newReference(),
                publicStoreReference: store.publicStoreReference,
                publicTableReference: previous?.publicTableReference ?? options.newReference(),
                qrVersion: result.table.qrVersion,
                locale: store.locale,
                issuedAt: observedAt,
              });
              const signed = await options.signer.sign(payload);
              const segment = signed.token.split(".")[1] ?? "";
              if (JSON.stringify(parseQrSignedPayload(segment)) !== JSON.stringify(payload))
                return fail();
              issue = await codes.recordIssue({
                qrReference: payload.qrReference,
                tableReference,
                publicStoreReference: payload.publicStoreReference,
                publicTableReference: String(payload.publicTableReference),
                qrVersion: payload.revocationVersion,
                operationReference,
                keyId: signed.keyId,
                qrToken: signed.token,
                issuedAt: payload.issuedAt,
                expiresAt: payload.expiresAt,
              });
            }
          }
          return Object.freeze({
            status: result.status,
            item: item(result.table, issue),
          });
        },
      );
    },

    /** The printable sheet for the listed tables; every table must have a current code. */
    async sheet(input: { sessionCookie: unknown; csrf: unknown; query: unknown }) {
      const authenticated = await options.authentication.authorize(input);
      const raw = readClosedRecord(input.query, ["tableReferences"]);
      if (
        !Array.isArray(raw.tableReferences) ||
        raw.tableReferences.length < 1 ||
        raw.tableReferences.length > 100
      )
        return fail();
      const requested = raw.tableReferences.map((value) => String(parseDiningReference(value)));
      if (new Set(requested).size !== requested.length) return fail();
      return authorizedRun(
        input.sessionCookie,
        authenticated.sessionReference,
        async (tx, { current, guard, scope, tables, codes }) => {
          const latest = await codes.loadLatestForTables(requested);
          const cards = [];
          for (const reference of requested) {
            const table = await tables.loadTable(parseDiningReference(reference));
            const issue = latest.get(reference);
            if (!table || item(table, issue).codeState !== "Active" || issue === undefined)
              return fail("TABLE_QR_CONFLICT");
            cards.push({
              tableLabel: table.stableLabel,
              url: url(issue.qrToken),
              validUntil: issue.expiresAt,
            });
          }
          const occurredAt = parseDiningInstant(current.context.resolvedAt);
          const sheetReference = options.newReference();
          await appendAuditRecordInTransaction(tx, {
            auditId: options.newReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: current.actorReference },
            actionCode: "DINING_TABLE_QR_PRINTED",
            targetType: "DiningTableQrSheet",
            targetId: sheetReference,
            afterSummary: { tableReferences: requested, tableCount: requested.length },
            reasonCode: "TABLE_QR_PRINTED",
            correlationId: sheetReference,
            occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Restricted",
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          });
          // WP-2423 DEC-STORE-CUSTOMER-NAME: the printed card names the Store as guests see it
          // (current published profile, the Store's own language); the Store record name only when
          // none is published.
          // A failed name read must not end the print: it is isolated in a savepoint.
          await tx.query("SAVEPOINT table_qr_store_name", []);
          const published = await createPostgresPublicStoreProfilePublisher({
            tenantReference: String(current.selected.tenantReference),
            brandReference: String(scope.brandReference),
            storeReference: String(scope.storeReference),
            // Read-only, inside this run: the caller was resolved in full at its start and is
            // re-checked in full before the sheet is returned.
            authorize: (transaction) => guard(transaction),
            hash: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
            verifyMedia: async () => false,
            appendAudit: async () => fail(),
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          })
            .readCurrent(tx, occurredAt)
            .then(async (profile) => {
              await tx.query("RELEASE SAVEPOINT table_qr_store_name", []);
              return profile;
            })
            .catch(async () => {
              await tx.query("ROLLBACK TO SAVEPOINT table_qr_store_name", []);
              return null;
            });
          const publicName = published?.localizedFields[published.defaultLocale]?.storeDisplayName;
          const store = current.store as { displayName?: unknown; timeZone?: unknown };
          return Object.freeze({
            fileName: "table-qr-codes-" + occurredAt.slice(0, 10) + ".html",
            html: renderTableQrSheet({
              storeName:
                publicName ?? (typeof store.displayName === "string" ? store.displayName : ""),
              timeZone: typeof store.timeZone === "string" ? store.timeZone : "UTC",
              cards,
            }),
          });
        },
      );
    },
  });
}
