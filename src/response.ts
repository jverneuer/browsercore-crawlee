/**
 * FetchResponse → Crawlee Response wrapping.
 *
 * `BaseHttpClient.fetch` must return a WHATWG `Response`. The wrapper preserves
 * every piece of wire fidelity Crawlee's machinery consumes:
 *
 * - `status` / `statusText` — read by redirect detection and status handling.
 * - `url` — `ResponseWithUrl` carries the (final) request URL; `sendRequest`
 *   resolves redirect targets against it and harvests cookies for it.
 * - `headers` — forwarded verbatim, lowercased names as browsersmith emits
 *   them; `getSetCookie()` on the wrapped response exposes the `Set-Cookie`
 *   values the stack preserved, which arrive via the capture jar because the
 *   public `FetchResponse.headers` record cannot hold duplicates (and the
 *   protocol decoders collapse them to the last value — see
 *   {@link SetCookieCaptureJar}).
 * - `body` — buffered (browsersmith delivers the fully decompressed bytes;
 *   crawlers parse the complete body anyway, and streaming adds no fidelity
 *   the signal path needs — an aborted signal tears down the connection).
 */

import { ResponseWithUrl } from "@crawlee/http-client";
import type { FetchResponse } from "browsersmith";
import type { CapturedSetCookies } from "./cookie-capture.js";

/**
 * Wrap a browsersmith response (plus the raw `Set-Cookie` values captured on
 * the wire) into the `ResponseWithUrl` Crawlee expects.
 *
 * @param fetchResponse - The completed browsersmith response. Its body must
 *   still be unconsumed.
 * @param capturedSetCookies - Raw `Set-Cookie` header values recorded by the
 *   request's capture jar, in wire order.
 * @returns A `Response` whose `url`, status, headers, and `getSetCookie()`
 *   surface match the wire response.
 */
export async function toCrawleeResponse(
    fetchResponse: FetchResponse,
    capturedSetCookies: CapturedSetCookies,
): Promise<ResponseWithUrl> {
    const body = await fetchResponse.body();
    const headers = new Headers();
    for (const [name, value] of Object.entries(fetchResponse.headers)) {
        if (name === "set-cookie") {
            // The record only carries the last value — skip it; the captured
            // raw values below are everything the stack preserved.
            continue;
        }
        if (name.startsWith(":")) {
            // HTTP/2 pseudo-headers (":status") are part of the wire mapping,
            // not the header section; WHATWG Headers rejects them outright.
            // The status code itself rides fetchResponse.status.
            continue;
        }
        headers.append(name, value);
    }
    for (const raw of capturedSetCookies) {
        // `append` (not `set`): each Set-Cookie value must survive as its own
        // entry so `getSetCookie()` returns them all.
        headers.append("set-cookie", raw);
    }
    return new ResponseWithUrl(body, {
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        headers,
        url: fetchResponse.url,
    });
}
