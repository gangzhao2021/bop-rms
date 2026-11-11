import { listStoreMenuSellableNames } from "@rms/catalog";
import {
  createPostgresDiningCheckoutHoldSource,
  loadDiningCheckoutScopeSetting,
} from "@rms/dining";
import {
  readDiningCheckoutScopeState,
  type CartQueryTransactionRunner,
  type CustomerCartTablePay,
  type CustomerCartTablePayPort,
} from "@rms/ordering";

/**
 * WP-2423 shared-table-checkout (a): what a table's phones see of a round being paid for chosen
 * dishes, read in one transaction: Ordering's live scope and waiting dishes, the dishes' names on
 * the Store's menus, the Store's starting choice (Dining's setting) and whether another guest's
 * checkout holds the cart (Dining's public hold read). A read never writes: a phone that may give
 * the waiting dishes back asks for that itself.
 */
export function createCustomerCartTablePay(
  transactions: CartQueryTransactionRunner,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
): CustomerCartTablePayPort {
  const owner = Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  return Object.freeze({
    read: (input: Parameters<CustomerCartTablePayPort["read"]>[0]) =>
      transactions.run(async (tx): Promise<CustomerCartTablePay> => {
        const state = await readDiningCheckoutScopeState(tx, owner, {
          diningSessionReference: input.diningSessionReference,
          observedAt: input.observedAt,
        });
        const names =
          state.waiting.length === 0
            ? new Map<string, Readonly<Record<string, string>>>()
            : await listStoreMenuSellableNames(
                tx as never,
                owner,
                state.waiting.map((line) => line.sellableReference),
              );
        const setting = await loadDiningCheckoutScopeSetting(tx as never, scope);
        const live = state.live;
        const thisPhone =
          live !== null &&
          (live.chooserParticipantReference === input.participantReference ||
            live.chooserGuestSessionReference === input.guestSessionReference);
        const reserved = live !== null && Date.parse(live.expiresAt) > Date.parse(input.observedAt);
        let held = false;
        if (state.waiting.length > 0 && state.cartReference !== null && state.cartVersion !== null)
          held =
            (await createPostgresDiningCheckoutHoldSource(
              { run: (work) => work(tx as never) },
              scope,
            ).read({
              diningSessionReference: input.diningSessionReference,
              cartReference: state.cartReference,
              cartVersion: state.cartVersion,
              participantReference: input.participantReference,
              observedAt: input.observedAt,
            })) !== null;
        return Object.freeze({
          defaultChoice: setting.defaultScope,
          payer:
            live === null
              ? null
              : Object.freeze({
                  thisPhone,
                  choice: live.choice,
                  expiresAt: live.expiresAt,
                  reserved,
                }),
          waiting: Object.freeze(
            state.waiting.map((line) =>
              Object.freeze({
                waitingLineReference: line.waitingLineReference,
                quantity: line.quantity,
                names: names.get(line.sellableReference) ?? Object.freeze({}),
                withOptions: line.optionCount > 0,
                mine: line.addedByParticipantReference === input.participantReference,
              }),
            ),
          ),
          // Nobody is paying for the round they wait on (it was sent, or its reservation ran out)
          // and no other guest's checkout holds the cart: this phone may give them back now. The
          // payer's own phone goes back with "Back to cart" instead while its choice is reserved.
          returnable:
            state.waiting.length > 0 &&
            state.cartReference !== null &&
            !held &&
            (live === null || !reserved),
        });
      }),
  });
}
