# `@bop/media`

Provider-neutral minimum Media owner for WP-0121.

The package owns strict Asset metadata、single-use Upload Session、immutable Asset Version and
Dynamic/Pinned reference contracts. Business callers receive references and bounded authorization
results only. Binary data、temporary/signed URLs、bucket/key or other storage locators、credentials、
original filenames and arbitrary metadata are not public contract fields.

Create Upload and Finalize Asset require exact Tenant scope、Permission and atomic Audit composition
through injected ports. Finalization accepts only server-obtained object evidence and creates a
quarantined version；only a unique `Clean + Ready` version can resolve. Published、Transaction、
Evidence and Compliance uses require a Pinned reference.

This package contains no database、migration、Provider/scanner、production route/UI、delivery URL、
retention/Legal Hold execution or real media integration. Those remain future gated work.
