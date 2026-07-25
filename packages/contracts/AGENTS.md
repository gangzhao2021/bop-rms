# Contract Package Guide

- Keep Zod source、generated schemas、AsyncAPI and TypeScript types aligned; generated artifacts never become an independent authority.
- Treat `eventType + schemaVersion` as immutable identity. Block removals and breaking same-version changes.
- Require explicit owner、consumer、scope、classification、retention、replay and deprecation metadata.
- Do not expose ORM、database、Provider SDK、transport binding、credential、Tenant inventory or private Module types.
- Do not place secrets、real identifiers、PII、Payment、health/allergy values、examples/defaults or free text in schemas、fixtures、errors or generated artifacts.
- Use synthetic-only tests. Run the dedicated contract acceptance plus root verification after every change.
