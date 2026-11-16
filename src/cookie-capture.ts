/**
 * Cookie interop between Crawlee's session jar and browsersmith.
 *
 * Strategy (mirroring the division of labor in ImpitHttpClient):
 *
 * - Request direction: Crawlee's `BaseHttpClient` applies the session cookie
 *   jar to the request's `cookie` header BEFORE the request reaches this
 *   client's `fetch`. The header is forwarded verbatim to browsersmith, so
 *   the session's cookies ride the request without this package touching
 *   them. Crawlee's jar cannot be handed to browsersmith directly —
 *   `@crawlee/types`' jar is async (tough-cookie-shaped) while
 *   `@browsercore/cookies`' jar is sync — so the jar objects never meet; the
 *   HTTP headers are the interchange format, exactly the seam impit relies
 *   on for its `sendRequest` cookie loop.
 *
 * - Response direction: `BaseHttpClient` harvests response cookies via
 *   `response.headers.getSetCookie()` into the session jar. browsersmith's
 *   public `FetchResponse.headers` is a `Record<string, string>` — it cannot
 *   represent duplicate `set-cookie` entries — and the underlying protocol
 *   decoders (@browsercore/http1's response parser, @browsercore/http2's
 *   HEADERS assembly) already collapse duplicate names to the last value, so
 *   browsersmith 0.0.16 delivers at most ONE `Set-Cookie` per response. This
 *   package cannot recover what the wire decoders dropped, but it forwards
 *   everything the stack preserves: {@link SetCookieCaptureJar} is passed to
 *   browsersmith as the per-request `FetchOptions.cookieJar` and records the
 *   raw `Set-Cookie` string(s) verbatim (via `FetchClient.storeCookies`);
 *   the wrapped `Response` re-emits each as its own `set-cookie` header. When
 *   browsersmith gains duplicate-header fidelity, crawlee harvesting picks
 *   the additional cookies up with no change here.
 *
 * The jar is deliberately inert on the request side (`getCookies` returns
 * nothing): request cookies must come from the Crawlee-managed header only,
 * never from a jar this package owns.
 */

import type { Cookie, CookieJar, CookieJarId, CookieUrl, SameSiteContext } from "@browsercore/cookies";

/**
 * Opaque identifier for {@link SetCookieCaptureJar} — the browsersmith jar
 * contract requires one.
 */
const CAPTURE_JAR_ID: CookieJarId = "browsercore-crawlee-set-cookie-capture" as CookieJarId;

/** All raw `Set-Cookie` values recorded by one captured response, in wire order. */
export type CapturedSetCookies = readonly string[];

/**
 * A browsersmith `CookieJar` adapter that captures raw `Set-Cookie` header
 * values and does nothing else. One instance per request; read
 * {@link capturedSetCookies} after the fetch returns.
 */
export class SetCookieCaptureJar implements CookieJar {
    public readonly id: CookieJarId = CAPTURE_JAR_ID;
    readonly #captured: string[] = [];

    /** Every raw `Set-Cookie` value this jar received, in wire order. */
    public get capturedSetCookies(): CapturedSetCookies {
        return this.#captured;
    }

    /** Request-side no-op: cookies come from the Crawlee-managed header, not from here. */
    public getCookies(_url: CookieUrl, _context?: SameSiteContext): Cookie[] {
        return [];
    }

    /** Record the raw header value verbatim — no parsing, so nothing can throw. */
    public setCookie(raw: string, _url: CookieUrl): void {
        this.#captured.push(raw);
    }

    public removeCookie(_name: string, _domain: string, _path: string): void {
        // A capture jar holds no queryable cookies — nothing to remove.
    }

    public clear(): void {
        this.#captured.length = 0;
    }

    public serialize(): string {
        return JSON.stringify({ captured: this.#captured });
    }

    public deserialize(_json: string): void {
        // Captures are per-request and never restored; deserializing into
        // this jar is a no-op by design.
    }
}
