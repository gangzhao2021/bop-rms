import assert from "node:assert/strict";
import {
  createProductPublicationCommandClient,
  ProductPublicationClientError,
} from "../../../apps/merchant-web/src/product-publication-command-client.ts";

/** Isolated native HTTP bridge, never an owning eligibility or permission source. */
export function createPublicationNativeHttpClient({ post, command, scope, csrf }) {
  let nativeReply,
    loseResponse = false;
  const sent = [];
  const prepared = createProductPublicationCommandClient(async (path, options) => {
    assert.equal(path, "/merchant/catalog/products/publication");
    assert.equal(options.method, "POST");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "same-origin");
    const headers = new globalThis.Headers(options.headers);
    assert.equal(headers.get("x-bop-csrf"), csrf);
    const body = options.body;
    assert.equal(typeof body, "string");
    assert.equal(JSON.stringify(JSON.parse(body)), body);
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
    if (loseResponse) throw new Error("isolated response deliberately unavailable");
    assert.equal(typeof nativeReply.contentType, "string");
    assert.equal(typeof nativeReply.cacheControl, "string");
    return new globalThis.Response(JSON.stringify(nativeReply.body), {
      status: nativeReply.status,
      headers: {
        "content-type": nativeReply.contentType,
        "cache-control": nativeReply.cacheControl,
      },
    });
  }).prepare(command, scope);
  return async ({ loseNextResponse = false } = {}) => {
    nativeReply = undefined;
    loseResponse = loseNextResponse;
    let receipt, error;
    try {
      receipt = await prepared.execute(csrf);
    } catch (failure) {
      assert.ok(failure instanceof ProductPublicationClientError);
      error = failure;
    }
    assert.ok(nativeReply);
    if (receipt) {
      assert.equal(receipt.operationReference, command.operationReference);
      assert.equal(receipt.productReference, command.productReference);
      assert.equal(receipt.versionReference, command.versionReference);
    }
    return { nativeReply, receipt, error };
  };
}
