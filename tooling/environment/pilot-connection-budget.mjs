/**
 * WP-2423 connection budget of the pilot's application role, computed from the Stores served and
 * the database's limits (measured 2026-11-02 with 3 Stores: a fixed 5 per process summed to 105
 * against a limit of 45). Each Store runs a customer API and HTTPS pool plus five workers, all as
 * the api role. Workers were seen holding 1-3 connections at once, the entries more under guests.
 */
export const pilotApiRoleConnectionLimit = 80;
/** Left for operator commands, migrations and the other roles. */
export const pilotOperatorHeadroom = 10;
/** Of `max_connections`, what the admin and worker roles may need. */
export const pilotOtherRolesReserve = 20;
const processClasses = (entry, business, worker) => ({ entry, business, worker });
const comfortable = processClasses(5, 3, 2);
const smallest = processClasses(3, 2, 2);
const perStore = ({ entry, business, worker }) => 2 * entry + business + 4 * worker;
/** Below this the role can't run even one Store: reported not ready. */
export const pilotApiRoleMinimumLimit = perStore(smallest) + pilotOperatorHeadroom;
/** What the database allows this role: its own limit, within what `max_connections` leaves. */
export function pilotEffectiveRoleLimit({ roleLimit, maxConnections }) {
  const shared = maxConnections - pilotOtherRolesReserve;
  return roleLimit === -1 ? shared : Math.min(roleLimit, shared);
}
/**
 * The pool sizes for this many Stores, and how many of them fit (the installation's own first,
 * then `stores.json` order, so a Store that fits today still fits tomorrow).
 */
export function planPilotConnections({ storeCount, limit }) {
  const available = limit - pilotOperatorHeadroom;
  const pools = storeCount * perStore(comfortable) <= available ? comfortable : smallest;
  const admittedStores = Math.min(storeCount, Math.floor(available / perStore(pools)));
  return Object.freeze({
    pools: Object.freeze(pools),
    admittedStores: Math.max(admittedStores, 0),
    required: storeCount * perStore(pools) + pilotOperatorHeadroom,
  });
}
/** This process's pool, from the entry it was started with; anything else is an operator command. */
export function pilotProcessPoolSize(plan, entryFile) {
  const name = String(entryFile ?? "");
  if (/pilot-(api|https)-entry\.mjs$/u.test(name)) return plan.pools.entry;
  if (/pilot-business-worker\.mjs$/u.test(name)) return plan.pools.business;
  if (/pilot-[a-z-]+-worker\.mjs$/u.test(name)) return plan.pools.worker;
  return 2;
}
