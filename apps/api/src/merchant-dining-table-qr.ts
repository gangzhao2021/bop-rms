import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction } from "@bop/audit";
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
import { createMerchantStoreScope } from "./merchant-store-scope.js";
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

  async function open(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const current = await resolve(tx, sessionCookie, tableQrPermission, sessionReference);
    const allowed = async () => (await current.allowed()) === true;
    if (!(await allowed())) fail("TABLE_QR_PERMISSION_DENIED");
    const scope = {
      tenantReference: current.selected.tenantReference,
      brandReference: current.context.brand.brandReference,
      storeReference: current.store.storeReference,
    };
    const runner = { run: <T>(work: (transaction: Tx) => Promise<T>) => work(tx) };
    const tables = createPostgresDiningTableStore(runner, scope, {
      hashIntent,
      equals: (left, right) => left === right,
    });
    const codes = createPostgresDiningTableQrStore(tx, scope);
    return { current, allowed, scope, tables, codes };
  }

  async function listAll(
    tables: ReturnType<typeof createPostgresDiningTableStore>,
    allowed: () => Promise<boolean>,
  ) {
    const all: DiningTable[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result = await tables.listTables({
        afterTableReference: after,
        limit: 100,
        authorize: allowed,
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
      return options.persistence.transactions.run(async (tx) => {
        const { allowed, tables, codes } = await open(
          tx,
          input.sessionCookie,
          authenticated.sessionReference,
        );
        const all = await listAll(tables, allowed);
        const latest = new Map<string, DiningTableQrIssue>();
        for (let i = 0; i < all.length; i += 200)
          for (const [key, value] of await codes.loadLatestForTables(
            all.slice(i, i + 200).map((table) => table.tableReference),
          ))
            latest.set(key, value);
        if (!(await allowed())) fail("TABLE_QR_PERMISSION_DENIED");
        return Object.freeze({
          items: Object.freeze(all.map((table) => item(table, latest.get(table.tableReference)))),
        });
      });
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
      return options.persistence.transactions.run(async (tx) => {
        const { current, allowed, scope, tables, codes } = await open(
          tx,
          input.sessionCookie,
          authenticated.sessionReference,
        );
        const prior = await tables.resolveTableOperation(operationReference);
        let candidate: DiningTable, observedAt: string, replacing: boolean;
        if (prior !== null) {
          if (
            prior.table.tableReference !== tableReference ||
            prior.table.aggregateVersion !== expectedAggregateVersion + 1 ||
            prior.audit.actionCode !== `DINING_TABLE_${action.toUpperCase()}`
          )
            return fail("TABLE_QR_CONFLICT");
          candidate = createDiningTable(prior.table);
          observedAt = candidate.observedAt;
          replacing = prior.audit.reasonCode === "TABLE_QR_REPLACED";
        } else {
          const table = await tables.loadTable(tableReference);
          if (!table || table.aggregateVersion !== expectedAggregateVersion)
            return fail("TABLE_QR_CONFLICT");
          if (action === "IssueQr" && table.lifecycle !== "Published")
            return fail("TABLE_QR_CONFLICT");
          if (action === "RevokeQr" && table.qrStatus !== "Active")
            return fail("TABLE_QR_CONFLICT");
          observedAt = parseDiningInstant(current.context.resolvedAt);
          replacing = action === "IssueQr" && table.qrStatus === "Active";
          candidate = transitionDiningTable(table, action, parseDiningInstant(observedAt));
        }
        const reasonCode =
          action === "RevokeQr"
            ? "TABLE_QR_TURNED_OFF"
            : replacing
              ? "TABLE_QR_REPLACED"
              : "TABLE_QR_ISSUED";
        const service = createDiningTableService({
          references: { hashIntent, equals: (left, right) => left === right },
          authorization: {
            async authorize(request) {
              if (
                request.action !== action ||
                request.targetReference !== tableReference ||
                request.observedAt !== observedAt ||
                !(await allowed())
              )
                return null;
              return {
                tenantReference: parseDiningReference(scope.tenantReference),
                brandReference: parseDiningReference(scope.brandReference),
                storeReference: parseDiningReference(scope.storeReference),
                actorReference: parseDiningReference(current.actorReference),
                purpose: "dining-table" as const,
                // The Dining table service names its Store permission family; the exact action
                // this command needs was checked above and is rechecked before every write.
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
              if (!(await allowed())) throw new Error("DINING_TABLE_PERMISSION_DENIED");
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
        if (!(await allowed())) fail("TABLE_QR_PERMISSION_DENIED");
        return Object.freeze({
          status: result.status,
          item: item(result.table, issue),
        });
      });
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
      return options.persistence.transactions.run(async (tx) => {
        const { current, allowed, scope, tables, codes } = await open(
          tx,
          input.sessionCookie,
          authenticated.sessionReference,
        );
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
        if (!(await allowed())) fail("TABLE_QR_PERMISSION_DENIED");
        const store = current.store as { displayName?: unknown; timeZone?: unknown };
        return Object.freeze({
          fileName: "table-qr-codes-" + occurredAt.slice(0, 10) + ".html",
          html: renderTableQrSheet({
            storeName: typeof store.displayName === "string" ? store.displayName : "",
            timeZone: typeof store.timeZone === "string" ? store.timeZone : "UTC",
            cards,
          }),
        });
      });
    },
  });
}
