/**
 * WP-2423 connection budget of the pilot's application role, computed from the Stores served and
 * the database's limits (measured 2026-11-02 with 3 Stores: a fixed 5 per process summed to 105
 * against a limit of 45). The first Store runs five worker processes, the others share one, and every
 * Store is served by one customer API and one HTTPS entry, all as the api role. Workers were seen holding 1-3 connections at once, the entries more under guests.
 */
export const pilotApiRoleConnectionLimit = 80;
/** Left for operator commands, migrations and the other roles. */
export const pilotOperatorHeadroom = 10;
/** Of `max_connections`, what the admin and worker roles may need. */
export const pilotOtherRolesReserve = 20;
const processClasses = (api, https, business, worker) => ({ api, https, business, worker });
// WP-2423 (burst 2026-11-02): guests' reads all land on the API entry, so it has the most.
const comfortable = processClasses(7, 5, 3, 2);
const smallest = processClasses(3, 3, 2, 2);
const perStore = ({ api, https, business, worker }) => api + https + business + 4 * worker;
/**
 * WP-2423 M68 (a): how long one attempt waits in the pool's queue for a connection (also the limit
 * for opening a new one), and the request's whole acquire budget across attempts. An entry retries
 * with jitter for up to 10 s: the phones and staff screens wait 15 s for an answer, which leaves
 * one statement's 5 s limit for the work, so a burst of guests is served in turn and a stuck
 * database still fails within the request. Workers keep one 2 s attempt: they retry on their next
 * cycle.
 */
export const pilotEntryAcquireMs = 2000;
export const pilotEntryAcquireBudgetMs = 10_000;
export const pilotWorkerAcquireMs = 2000;
export const pilotWorkerAcquireBudgetMs = 2000;
/** Below this the role can't run even one Store: reported not ready. */
export const pilotApiRoleMinimumLimit = perStore(smallest) + pilotOperatorHeadroom;
/** What the database allows this role: its own limit, within what `max_connections` leaves. */
export function pilotEffectiveRoleLimit({ roleLimit, maxConnections }) {
  const shared = maxConnections - pilotOtherRolesReserve;
  return roleLimit === -1 ? shared : Math.min(roleLimit, shared);
}
/**
 * DEC-MULTI-MERCHANT-ONE-INSTALLATION A5: the Stores after the first share one worker process, whose
 * pool grows slowly: each of its workloads holds a connection only briefly and waits its turn.
 */
const hostedWorkersPool = (storeCount) => (storeCount < 2 ? 0 : Math.min(3 + storeCount, 16));
const firstStoreWorkers = ({ business, worker }) => business + 4 * worker;
/** The Stores this pool can serve: every Store has at least one connection in each entry. */
function entryPools(storeCount, available, pools) {
  const left = available - firstStoreWorkers(pools) - hostedWorkersPool(storeCount);
  const api = Math.min(Math.ceil((left * 7) / 12), pools.api * storeCount),
    https = Math.min(left - Math.ceil((left * 7) / 12), pools.https * storeCount);
  return { api, https };
}
/**
 * The pool sizes for this many Stores, and how many of them fit (the installation's own first,
 * then `stores.json` order, so a Store that fits today still fits tomorrow). The entries share what
 * the workers leave; a burst at one Store can use all of it, and others wait their turn.
 */
export function planPilotConnections({ storeCount, limit }) {
  const available = limit - pilotOperatorHeadroom;
  const needed = (count, shape) =>
    firstStoreWorkers(shape) + hostedWorkersPool(count) + count * (shape.api + shape.https);
  const pools = needed(storeCount, comfortable) <= available ? comfortable : smallest;
  // The first Store needs its smallest whole; each other Store one connection per entry.
  let admittedStores = 0;
  if (needed(1, smallest) <= available) {
    admittedStores = 1;
    for (let count = 2; count <= storeCount; count += 1) {
      const entries = entryPools(count, available, pools);
      if (
        entries.api < Math.max(count, smallest.api) ||
        entries.https < Math.max(count, smallest.https)
      )
        break;
      admittedStores = count;
    }
  }
  return Object.freeze({
    pools: Object.freeze(pools),
    entries: Object.freeze(entryPools(Math.max(admittedStores, 1), available, pools)),
    hostedWorkers: hostedWorkersPool(admittedStores),
    admittedStores,
    required: needed(storeCount, smallest) + pilotOperatorHeadroom,
  });
}
/** This process's pool, from the entry it was started with; anything else is an operator command. */
export const isPilotEntryProcess = (entryFile) =>
  /pilot-(api|https)-entry\.mjs$/u.test(String(entryFile ?? ""));
export function pilotProcessPoolSize(plan, entryFile) {
  const name = String(entryFile ?? "");
  // An entry serves every Store from one process and one pool: a burst at one Store can use it all.
  if (/pilot-api-entry\.mjs$/u.test(name)) return plan.entries.api;
  if (/pilot-https-entry\.mjs$/u.test(name)) return plan.entries.https;
  if (/pilot-store-workers\.mjs$/u.test(name)) return plan.hostedWorkers;
  if (/pilot-business-worker\.mjs$/u.test(name)) return plan.pools.business;
  if (/pilot-[a-z-]+-worker\.mjs$/u.test(name)) return plan.pools.worker;
  return 2;
}
