/**
 * FetchResponse → Crawlee Response wrapping.
 *
 * `BaseHttpClient.fetch` must return a WHATWG `Response`. The wrapper
 * preserves every piece of wire fidelity Crawlee's machinery consumes:
 *
 * - `status` / `statusText` — read by redirect detection and status handling.
 * - `url` — `ResponseWithUrl` carries the (final) request URL; `sendRequest`
 *   resolves redirect targets against it and harvests cookies for it.
 * - `headers` — rebuilt as a WHATWG `Headers` from the flat record plus
 *   `fetchResponse.getSetCookie()`. WHATWG semantics preserve duplicate
 *   `set-cookie` entries constructed from a sequence of pairs, so
 *   `getSetCookie()` on the built Response returns every value in wire
 *   order — the session jar harvests them all (fidelity flows through the
 *   API; the record itself stays last-wins for backward compatibility).
 * - HTTP/2 pseudo-headers (":status") are dropped — they are wire mapping,
 *   not the header section, and WHATWG Headers rejects them outright.
 * - `body` — buffered (browsersmith delivers the fully decompressed bytes;
 *   crawlers parse the complete body anyway, and streaming adds no fidelity
 *   the signal path needs — an aborted signal tears down the connection).
 */

import { ResponseWithUrl } from "@crawlee/http-client";
import type { FetchResponse } from "browsersmith";

/**
 * Wrap a browsersmith response into the `ResponseWithUrl` Crawlee expects.
 *
 * @param fetchResponse - The completed browsersmith response. Its body must
 *   still be unconsumed.
 * @returns A `Response` whose `url`, status, headers, and `getSetCookie()`
 *   surface match the wire response.
 */
export async function toCrawleeResponse(fetchResponse: FetchResponse): Promise<ResponseWithUrl> {
    const body = await fetchResponse.body();
    const headerPairs: [string, string][] = [];
    for (const [name, value] of Object.entries(fetchResponse.headers)) {
        if (name === "set-cookie") {
            // The record is last-wins; the fidelity view below carries every
            // value.
            continue;
        }
        if (name.startsWith(":")) {
            continue;
        }
        headerPairs.push([name, value]);
    }
    for (const raw of fetchResponse.getSetCookie()) {
        // `set-cookie` pairs keep their identity through the Headers
        // constructor — each value must survive as its own entry so
        // `getSetCookie()` returns them all.
        headerPairs.push(["set-cookie", raw]);
    }
    return new ResponseWithUrl(body, {
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        headers: new Headers(headerPairs),
        url: fetchResponse.url,
    });
}
