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

WP-2421 adds the owning PostgreSQL implementation of the existing upload/finalization unit of work:
single-use session CAS, immutable quarantine versions, operation receipts and atomic Audit.
Current authority and the original transaction lease remain held through commit. Stored upload or
finalization success does not prove scanner, processing or rendition readiness and creates no usable
current version pointer. Original bytes and history remain immutable.

The private public-image processor uses pinned Sharp0.35.5 to fully decode JPEG/PNG/WebP inputs
within 10 MiB/25 megapixels, normalize orientation, retain only the first animation frame, and
encode fresh metadata-free JPEG/WebP outputs at 320/640/1280 pixels wide. It processes sequentially
through an sRGB RGBA boundary; quality80, a white JPEG background and preserved WebP alpha are
fixed encoding defaults. Private execution limits reject outputs over 16,383 pixels on an edge,
25 megapixels, 10 MiB per rendition or 30 MiB total. Each libvips operation has a 10-second
processing limit, which does not cover worker queue time or the whole job. Unsupported aspect
ratios fail instead of being silently cropped. No processing result alone grants Clean/Ready.

The private S3 quarantine reader uses the directly owned existing SDK3.1094.0 and a fixed
ca-central-1 endpoint. It binds the stored Finalized session, quarantined version and opaque
object mapping to the exact bucket/key/VersionId, GuardDuty event and current versioned scan tag.
HEAD/GET must agree on full-object SHA256, length, content type, SSE-KMS key and original upload
metadata; downloaded bytes are independently hashed within one 30-second deadline. The upload
key convention is the configured quarantine prefix plus 32 random bytes encoded as lowercase hex.
Public Media contracts and exports do not expose these private locators or binary buffers.

The private S3 upload runtime now composes the existing CreateUpload/FinalizeAsset services with
owning PostgreSQL storage. A held operation lock precedes original receipt recovery, random key
generation and Provider verification. Two immutable, scoped binding tables commit with the
business receipt and Audit; new S3 operations cannot commit without their binding. Exact retries
recover the same grant or pinned object version, including after Session expiry, without fresh S3
calls. Legacy operations without bindings remain unavailable to this private runtime.

POST delivery separately rechecks and locks the actual Pending Session. The actual AWS signer
fixes key, MIME, exact length, SHA256, SSE-KMS and scope metadata to the original expiry. Signed
fields stay transient. Finalization discovers a version once and repeats HEAD with its explicit
VersionId/ETag before saving it; later processing recovery never falls back to the current object.
The private User recovery method supplies stored tuples to the quarantine reader; it is not a
System scan-worker authorization path. Existing uploaded URLs may remain valid until their
original expiry, but cannot replace an already pinned finalized version.

Private image processing now persists an immutable plan before Provider work, with seven random
object destinations. The actual quarantine reader and Sharp processor feed a private original
copy and six conditional rendition uploads. Explicit S3 version/ETag checks bind every output;
unknown write outcomes recover only the same destination. An original copy may create redundant
identical versions after an uncertain concurrent Copy response; no physical exactly-once write
or S3/PostgreSQL distributed transaction is claimed.

A separate five-second System transaction commits completion, six rendition records, a new
Clean/Ready AssetVersion, the root CAS and Audit atomically. Its representative is the JPEG1280
derivative; the original copy is private. Quarantined version1, upload/finalize receipts and old
processing versions remain immutable. Completed-operation recovery precedes new Provider work
and current root CAS. The required authority port must retain both System permission and trusted
scan admission; a passing controlled-port test does not implement or authenticate ingress.

Event JSON fields are not authentication. The accepted scanner and image profile follow
Handoff87.5.3; controlled SDK responses in tests are not evidence of real AWS scans or IAM
enforcement. Restricted scan-tag writers, cloud deployment assembly,
production route/UI, delivery URLs and retention/Legal Hold execution remain unfinished.

The Worker transaction host now runs real READ COMMITTED transactions, retains all asynchronous
and final synchronous guards, and reports uncertain COMMIT outcomes separately. Permission owns
the fixed System promotion grant and immutable authorization decisions. Its separate, audited
deployment provisioner requires a configured direct-login non-owner database role; Worker roles
can read and hold current authorization but cannot create or change grants. Missing, revoked,
expired or configuration-mismatched authority denies processing. Exact event-object resolution
recovers the original finalized version, even after the Asset root advances. Native PostgreSQL
acceptance composes these implementations with owning scan admission to exercise atomic rollback
and original-receipt recovery; AWS responses remain controlled fixtures. No real deployment grant
has been created.

The server-only `@bop/media/worker` entry now receives its own SQS delivery, holds current System
Permission, saves immutable scan admission, plans and processes the original object, commits
completion and only then acknowledges the message. It accepts protected configuration and the
guarded transaction host, never caller event JSON or SDK/clock doubles. Its full configuration
digest must match the separately provisioned Permission decision. Admission binds account,
region and event ID to the original event, finalized source and first transport provenance;
redelivery recovers that receipt. Unknown commits never trigger acknowledgement. New processing
intents require admission; old NULL-admission history remains unchanged and cannot be adopted
for execution by this entry.

The private ingress uses actual SQS/STS/EventBridge clients and checks the actual Worker role,
queue incarnation and fixed policy, exact enabled default-bus rule and unmodified target before
and after receiving. Receipt handles stay transient. The separate queue-creation helper applies
the restricted producer policy at creation and returns an origin receipt for protected deployment
configuration; it refuses an existing queue. That helper does not provision the EventBridge
rule/target, IAM/KMS policies or GuardDuty protection plan. Those deployment components and real
evidence remain open; queue timestamps or a current policy cannot authenticate unknown backlog.

`apps/worker/src/media-image-workload.ts` composes this entry with the real transaction host and
existing sequential scheduler. Shutdown cancels a pending receive or image job before draining,
then closes owned SDK clients and the supplied database resource. A failed cycle fails the
workload and leaves the message unacknowledged; poison-message handling, restart policy and
deployment activation are not supplied by this composition.

Implementation references: [Sharp input limits](https://sharp.pixelplumbing.com/api-constructor/),
[output metadata and timeout](https://sharp.pixelplumbing.com/api-output/),
[GuardDuty events](https://docs.aws.amazon.com/guardduty/latest/ug/monitor-with-eventbridge-s3-malware-protection.html)
and [versioned S3 reads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
Upload constraints follow the actual SDK3.1094.0 implementation and AWS
[POST policy](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-HTTPPOSTConstructPolicy.html)
and [POST checksum/encryption fields](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/RESTObjectPOST.html).

Public access captures the closed request and owning parsed Asset/Version bodies, refuses unknown
uses and malformed or unavailable reads, and checks exact Tenant scope before authorization.
Successful reference evaluation requires a fresh permission decision after the version read;
errors return bounded `MEDIA_UNAVAILABLE` without source details. Dynamic Draft versions remain
unique, and all other uses require Pinned references. These are controlled-port authorization
checks at return, not transaction-held current readiness, processing/Provider evidence, or
Product publication eligibility. The generic helper does not supply a held publication lease.

`createPostgresMediaPublicationReadSource` supplies the separate owning publication reader.
It uses the actual outer transaction and exact Tenant/Brand/Store context, holds
`media.asset.access` authority under the original five-second deadline, and validates a pinned
version against its immutable upload/finalization, scan admission, processing intent/completion
and all six rendition records. It makes no S3 calls. Missing or unready references are negative
facts; a claimed Ready version with broken provenance fails the read. Crop/focus and shared-scope
authority remain unsupported and cannot silently pass. Results contain no storage locators.

A later current pointer does not invalidate an otherwise valid historical pin or change its
relevant digest. The source retains permission and lease checks through the actual outer async
and final synchronous commit guards. Native acceptance proves this with real PostgreSQL and
consumer writes/Audit that roll back after late denial or expiry; its User grant and Product
binding inputs are controlled. The API publication/Ack source and Merchant composition bind
the actual command, aggregate and original deadline. The Merchant host supplies current Brand
User authorization; it does not reuse the System promotion grant. The complete Product
qualification producer and ordinary publication journey still require assembly. Required-image
presence continues to be evaluated by the existing content policy.
