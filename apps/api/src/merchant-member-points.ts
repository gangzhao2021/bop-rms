import type { ConsumerTransaction } from "@bop/eventing";
import {
  createMemberPointsStore,
  MemberPointsError,
  type MemberPhoneProtector,
} from "@rms/customer-loyalty";
import { readClosedRecord } from "@bop/identity";
import { listBrandSkuChoices } from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { storeOffersPoints } from "./merchant-store-features.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { onlyRefusal } from "./merchant-failure.js";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS (Section 88 LOY-PROGRAM-LIST): the back office of a Brand's
 * points: the rules, the member list with only a phone's last four digits, and what was issued,
 * used and is outstanding. No route here can read a whole phone number.
 */
export const memberPointsReadPermission = "loyalty.member.read" as const;
export const memberPointsManagePermission = "loyalty.program.manage" as const;
export type MerchantMemberPointsErrorCode =
  | "MEMBER_POINTS_PERMISSION_DENIED"
  | "MEMBER_POINTS_INPUT_INVALID"
  | "MEMBER_POINTS_CHANGED"
  | "MEMBER_POINTS_UNAVAILABLE";
export class MerchantMemberPointsError extends Error {
  constructor(readonly code: MerchantMemberPointsErrorCode) {
    super(code);
    this.name = "MerchantMemberPointsError";
  }
}
const fail = (code: MerchantMemberPointsErrorCode): never => {
  throw new MerchantMemberPointsError(code);
};
/** The back office never handles a phone number, so it holds no key for one. */
const noPhones = new Proxy(
  {},
  {
    get() {
      throw new MerchantMemberPointsError("MEMBER_POINTS_UNAVAILABLE");
    },
  },
) as MemberPhoneProtector;

/** Active dishes of the Brand, one per product, named as the guests read them. */
async function rewardDishChoices(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
) {
  const skus = await listBrandSkuChoices(tx as never, scope);
  await tx.query("SELECT set_config('bop.store_id',$1,true)", [scope.storeReference]);
  const dishes = new Map<string, string>();
  for (const sku of skus) {
    if (!sku.active || dishes.has(sku.productReference)) continue;
    const names = Object.values(sku.productLocalizedNames);
    const name = [...new Set(names)].join(" ").slice(0, 120);
    if (name !== "") dishes.set(sku.productReference, name);
  }
  return [...dishes].map(([productReference, displayName]) =>
    Object.freeze({ productReference, displayName }),
  );
}

export function createMerchantMemberPoints(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const inScope = <T>(
    sessionCookie: unknown,
    permission: string,
    work: (
      tx: ConsumerTransaction,
      scope: {
        brandReference: string;
        storeReference: string;
        actorReference: string;
        canManage: boolean;
      },
    ) => Promise<T>,
  ): Promise<T> =>
    options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const current = await resolveScope(transaction, sessionCookie, permission).catch(
              onlyRefusal(() => fail("MEMBER_POINTS_PERMISSION_DENIED")),
            );
            const decisions = await current.authorizeActions([
              permission,
              memberPointsManagePermission,
            ]);
            if (decisions.get(permission)?.effect !== "Allow")
              return fail("MEMBER_POINTS_PERMISSION_DENIED");
            return {
              current,
              canManage: decisions.get(memberPointsManagePermission)?.effect === "Allow",
            };
          },
          recheck: async ({ current }) => (await current.allowed()) === true,
          denied: () => fail("MEMBER_POINTS_PERMISSION_DENIED"),
        },
        async ({ scope: { current, canManage } }) =>
          work(transaction as never, {
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
            actorReference: String(current.actorReference),
            canManage,
          }),
      ),
    ) as Promise<T>;
  const store = (scope: { brandReference: string; storeReference: string }) =>
    createMemberPointsStore({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      nextReference: options.nextReference,
      now: () => new Date(Date.parse(options.persistence.now())).toISOString(),
      protector: noPhones,
    });
  const translated = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MerchantMemberPointsError) throw error;
      if (error instanceof MemberPointsError && error.code === "MEMBER_RULE_CHANGED")
        return fail("MEMBER_POINTS_CHANGED");
      if ((error as { code?: unknown } | null)?.code === "CUSTOMER_PROFILE_INVALID")
        return fail("MEMBER_POINTS_INPUT_INVALID");
      return fail("MEMBER_POINTS_UNAVAILABLE");
    }
  };
  return Object.freeze({
    async read(input: { readonly sessionCookie: unknown }) {
      return translated(() =>
        inScope(input.sessionCookie, memberPointsReadPermission, async (tx, scope) => {
          const points = store(scope);
          const view = {
            canManage: scope.canManage,
            offeredHere: await storeOffersPoints(tx as never, scope),
            rule: await points.currentRule(tx as never),
            members: await points.listMembers(tx as never, 200),
            report: await points.report(tx as never),
          };
          return Object.freeze({
            ...view,
            // The dishes a Brand's rule can offer for points: only who can change the rules reads them.
            dishChoices: scope.canManage ? await rewardDishChoices(tx, scope) : [],
          });
        }),
      );
    },
    async changeRule(input: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
      readonly command: unknown;
    }) {
      return translated(async () => {
        await options.authentication.authorize({
          sessionCookie: input.sessionCookie,
          csrf: input.csrf,
        } as never);
        let command: { expectedVersion: number; operationReference: string; change: unknown };
        try {
          const raw = readClosedRecord(input.command, [
            "operationReference",
            "expectedVersion",
            "change",
          ]);
          if (
            typeof raw.operationReference !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
              raw.operationReference,
            ) ||
            !Number.isSafeInteger(raw.expectedVersion)
          )
            throw new Error();
          command = {
            expectedVersion: raw.expectedVersion as number,
            operationReference: raw.operationReference,
            change: raw.change,
          };
        } catch {
          return fail("MEMBER_POINTS_INPUT_INVALID");
        }
        return inScope(input.sessionCookie, memberPointsManagePermission, async (tx, scope) =>
          store(scope).recordRule(tx as never, {
            expectedVersion: command.expectedVersion,
            operationReference: command.operationReference,
            actorReference: scope.actorReference,
            change: command.change,
          }),
        );
      });
    },
  });
}
