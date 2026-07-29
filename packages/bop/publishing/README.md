# `@bop/publishing`

Provider-neutral minimum Publishing owner for WP-0122.

The package owns strict Draft、Review、Approval、Publish、Archive、Rollback lifecycle records and
immutable Release Records. Caller Domains retain configuration payload and validation ownership；
Publishing accepts only an opaque snapshot reference、`sha256:` digest、configuration family/type
and exact Brand or Store scope.

Every mutation requires exact Tenant scope、Permission、positive expected version、idempotency and
atomic lifecycle/release/Audit composition through injected ports. Submit Review binds successful
validation evidence；Approve binds accepted approval evidence；Publish and Rollback revalidate both.
Rollback creates a new reviewed Release Record from an eligible prior release and never rewinds
transactions.

Schedule returns an explicit unsupported result in this minimum. Effective Period、time-zone
resolution、activation/expiry and overlap rules belong to WP-0123. This package contains no
database、migration、event claim、production API/UI、Provider/resource or real configuration.
