import assert from "node:assert/strict";
import {
  createProductCommandClient,
  productCommandMaximumRequestBytes,
  productCompleteDraftMaximumRequestBytes,
} from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
/** Isolated native HTTP adapter. Never replaces an owning permission/reference source.
 * Original client bytes/CSRF/scope and actual observed response headers are forwarded.
 * Existing listener owns encrypted synthetic session transport and cleanup.
 */
export function createCompleteDraftNativeHttpClient({ post, command, scope, csrf }) {
  let nativeReply;
  const sent = [];
  const fetcher = async (path, options) => {
    assert.equal(path, "/merchant/catalog/products/draft");
    assert.equal(options.method, "POST");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "same-origin");
    const headers = new globalThis.Headers(options.headers);
    assert.equal(headers.get("x-bop-csrf"), csrf);
    const body = options.body;
    assert.equal(typeof body, "string");
    assert.equal(JSON.stringify(JSON.parse(body)), body);
    const bytes = new globalThis.TextEncoder().encode(body).byteLength;
    assert.ok(
      bytes > productCommandMaximumRequestBytes && bytes <= productCompleteDraftMaximumRequestBytes,
    );
    sent.push(body);
    assert.equal(body, sent[0]);
    nativeReply = await post(
      JSON.parse(body),
      {
        "x-bop-csrf": headers.get("x-bop-csrf"),
        "x-bop-catalog-scope": headers.get("x-bop-catalog-scope"),
      },
      path,
    );
    assert.equal(typeof nativeReply.contentType, "string");
    assert.equal(typeof nativeReply.cacheControl, "string");
    return new globalThis.Response(JSON.stringify(nativeReply.body), {
      status: nativeReply.status,
      headers: {
        "content-type": nativeReply.contentType,
        "cache-control": nativeReply.cacheControl,
      },
    });
  };
  const prepared = createProductCommandClient(fetcher).prepareDraft(command, scope);
  return async () => {
    nativeReply = undefined;
    const result = await prepared.execute(csrf);
    assert.ok(nativeReply);
    assert.equal(result.productReference, command.productReference);
    assert.equal(result.operationReference, command.operationReference);
    assert.deepEqual(result.draft.editorContent, command.draft.editorContent);
    return nativeReply;
  };
}
