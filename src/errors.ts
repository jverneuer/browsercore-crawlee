/**
 * Typed errors for @browsercore/crawlee.
 *
 * Errors are part of the API — every failure mode is an explicit type so
 * callers can match on `kind` instead of parsing messages (house style,
 * mirrored from @browsercore/proxy's errors.ts).
 *
 * Failures raised by the underlying stacks surface unchanged: browsersmith's
 * `FetchError` hierarchy (including `FetchProxyError`), `@browsercore/proxy`'s
 * `ProxyConfigError` for unsupported proxy schemes, and
 * `@browsercore/profiles`' `UnknownProfileError` for unregistered profile ids.
 */

/** Arbitrary structured metadata attached to a {@link BrowsersmithHttpClientError}. */
export type HttpClientErrorDetails = Record<string, unknown>;

/**
 * Base class for every error raised by `@browsercore/crawlee` itself.
 *
 * All client failures extend this class, which itself extends `Error` — so a
 * single `catch` on `BrowsersmithHttpClientError` works, while `instanceof`
 * against a subclass narrows to a specific failure mode. Network-level
 * failures are NOT instances of this class: they are browsersmith's typed
 * `FetchError` hierarchy, re-exported from this package for matching.
 *
 * @since 0.1.0
 */
export class BrowsersmithHttpClientError extends Error {
    public readonly kind: string = "BrowsersmithHttpClientError";
    public readonly details: HttpClientErrorDetails;
    /** `Error | undefined` (not `?`) so assignment is valid under exactOptionalPropertyTypes. */
    public override readonly cause: Error | undefined;

    /**
     * @param message - Human-readable description of the failure.
     * @param details - Structured metadata about the error.
     * @param options - Standard `Error` options; `cause` preserves the wrapped error.
     */
    constructor(
        message: string,
        details: HttpClientErrorDetails = {},
        options?: { cause?: Error },
    ) {
        super(message, options);
        this.name = new.target.name;
        this.details = details;
        this.cause = options?.cause;
    }
}

/**
 * TLS certificate validation was disabled for a request, which browsersmith
 * cannot do.
 *
 * browsersmith performs real TLS handshakes with browser-identical
 * ClientHellos; there is no hook to skip certificate verification (the whole
 * point of the stack is a wire-accurate browser handshake, and a MITM'd
 * handshake would betray the fingerprint anyway). Requests that ask for
 * `ignoreTlsErrors` fail with this error instead of silently downgrading
 * security.
 *
 * Sources of the flag: the crawler-level `ignoreTlsErrors` option, or a
 * session bound to a MITM proxy (`session.proxyInfo.ignoreTlsErrors`).
 *
 * @since 0.1.0
 */
export class IgnoreTlsErrorsUnsupportedError extends BrowsersmithHttpClientError {
    public override readonly kind = "IgnoreTlsErrorsUnsupportedError" as const;

    /**
     * @param details - `source` names where the flag came from
     *   (`"constructor"` for a client-level option, `"request"` for a
     *   per-request / crawler-level flag).
     */
    constructor(details: { readonly source: "constructor" | "request" }) {
        super(
            "browsersmith cannot disable TLS certificate verification — the `ignoreTlsErrors` flag is unsupported. " +
                "browsersmith performs real browser-identical TLS handshakes, so a request that skips certificate " +
                "validation would not produce a browser fingerprint worth impersonating. Remove the " +
                "`ignoreTlsErrors` crawler/client option, or use a client that supports MITM proxies (e.g. ImpitHttpClient).",
            details,
        );
    }
}

/**
 * The request method is outside the set browsersmith models.
 *
 * browsersmith's `FetchMethod` union is GET, POST, PUT, PATCH, DELETE, HEAD,
 * OPTIONS. Crawlee request queues almost always stay within that set; a
 * method outside it fails fast with this error instead of sending a wire
 * method the fingerprint stack never validated.
 *
 * @since 0.1.0
 */
export class UnsupportedHttpMethodError extends BrowsersmithHttpClientError {
    public override readonly kind = "UnsupportedHttpMethodError" as const;
    /** The rejected method token, uppercased. */
    public readonly method: string;

    /**
     * @param method - The offending HTTP method token.
     */
    constructor(method: string) {
        super(
            `browsersmith does not support the HTTP method "${method}" — supported: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.`,
            { method },
        );
        this.method = method;
    }
}
