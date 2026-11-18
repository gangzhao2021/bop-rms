/** This host's clock half a second ahead of the database's (no pilot clock alignment asked for). */
const aheadMs = 500;
const HostDate = globalThis.Date;
globalThis.Date = new Proxy(HostDate, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length === 0 ? [HostDate.now() + aheadMs] : args, newTarget),
  get: (target, key) => (key === "now" ? () => HostDate.now() + aheadMs : Reflect.get(target, key)),
});
