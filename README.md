# @browsercore/crawlee

[![npm version](https://img.shields.io/npm/v/@browsercore/crawlee)](https://www.npmjs.com/package/@browsercore/crawlee)
[![CI](https://img.shields.io/github/actions/workflow/status/jverneuer/browsercore-crawlee/ci.yml?label=ci)](https://github.com/jverneuer/browsercore-crawlee/actions/workflows/ci.yml)

`@browsercore/crawlee` is a Crawlee HTTP client (`BrowsersmithHttpClient`) that routes every crawler request through browsersmith's browser-identical TLS + HTTP/2 fingerprint stack — the JA3/JA4 ClientHello, HTTP/2 SETTINGS frame order, and header casing a real Chrome (or Firefox) would emit — with HTTP CONNECT and SOCKS5 proxying and **zero native dependencies**. It plugs into any `@crawlee/http-client`-based crawler (`CheerioCrawler`, `HttpCrawler`, `BasicCrawler`, …) via the standard `httpClient` option.

Crawlee keeps everything it is good at (queues, retries, sessions, autoscaling concurrency); this package owns the wire.

## Install

```bash
npm install @browsercore/crawlee
npm install crawlee        # peer: @crawlee/http-client >= 4.0.0-rc.0
```

## Quick usage

```ts
import { CheerioCrawler } from "crawlee";
import { BrowsersmithHttpClient } from "@browsercore/crawlee";

const crawler = new CheerioCrawler({
    httpClient: new BrowsersmithHttpClient(),
    async requestHandler({ $, request }) {
        console.log(request.url, "→", $("title").text());
    },
});

await crawler.run(["https://books.toscrape.com/"]);
```

Every request now completes a real TLS handshake with the `chrome-140` fingerprint — pass Bot Check, whoami.freesample.io-style probes, or your own JA3 collector and the connection looks like Chrome 140 on the wire.

### Proxy rotation

Crawlee's `ProxyConfiguration` works as-is: each session's proxy URL reaches the client and is dialed through browsersmith's own HTTP CONNECT / SOCKS5 tunnel (no `https-proxy-agent`, no native modules).

```ts
import { CheerioCrawler } from "crawlee";
import { BrowsersmithHttpClient } from "@browsercore/crawlee";

const crawler = new CheerioCrawler({
    httpClient: new BrowsersmithHttpClient(),
    proxyUrls: [
        "socks5://user:pass@proxy1.example.com:1080",
        "socks5h://proxy2.example.com:1080", // remote DNS
        "http://user:pass@proxy3.example.com:8080",
    ],
    // Each session keeps its own exit IP AND its own TLS fingerprint for the
    // life of the session — identity and wire look stay coherent.
    maxConcurrency: 10,
    async requestHandler({ $ }) { /* ... */ },
});
```

Accepted proxy schemes: `http` (CONNECT), `socks5` (client-side DNS), `socks5h` (proxy-side DNS). An `https://` proxy scheme throws a typed `ProxyConfigError` naming the scheme — TLS-to-the-proxy is not supported by the underlying stack.

### Profile selection

```ts
import { BrowsersmithHttpClient } from "@browsercore/crawlee";

// Pin one profile for every request (wins over session fingerprints):
new BrowsersmithHttpClient({ profile: "firefox-128" });

// Or follow each session's fingerprint (default "auto"):
//   fingerprint.browser "firefox" → firefox-128
//   "chrome" / "edge" / "safari" / no fingerprint → chrome-140
new BrowsersmithHttpClient({ profile: "auto" });
```

This mirrors `ImpitHttpClient`'s override precedence: an explicit profile wins over the session, and Chromium-based families collapse onto Chrome. Any profile id in the browsersmith registry is accepted (`safari-18`, `edge-128`, …) and is validated at construction with the registry's own typed error.

## The contract

`BrowsersmithHttpClient` extends `@crawlee/http-client`'s `BaseHttpClient`, whose concrete `sendRequest` owns redirect handling (manual-mode loop, 10-hop cap, 301/302-POST→GET and 303 semantics, cross-origin credential stripping) and cookie interchange (session jar → `cookie` header per hop; response `Set-Cookie` → jar). This package implements the single abstract primitive, `fetch`, mapping the `CustomFetchOptions` the base hands in:

| Option | Mapping |
| --- | --- |
| `proxyUrl` | `parseProxyUrl` → browsersmith's tunnel (`http` / `socks5` / `socks5h`; `https` scheme → typed `ProxyConfigError` naming the scheme) |
| `fingerprint.browser` | profile: `firefox` → `firefox-128`, everything else / missing → `chrome-140`; an explicit `profile` option wins |
| `cookieJar` | not forwarded — Crawlee's async jar and browsersmith's sync jar are incompatible objects, so cookies interchange as HTTP headers (see below) |
| `ignoreTlsErrors` | typed `IgnoreTlsErrorsUnsupportedError` — browsersmith performs real certificate-validating handshakes and cannot skip verification |
| `signal` | forwarded; the signal owns the deadline (the wall-clock timer is set past any practical crawl length, mirroring impit's `timeout: null` signal mode) |

**Cookie interop strategy** (mirroring the impit-client division of labor): Crawlee's `BaseHttpClient` applies the session jar to the request's `cookie` header before the request reaches this client, and the header is forwarded verbatim; on the response side, this package re-emits the `Set-Cookie` values the stack saw on the wire onto the wrapped `Response` so `BaseHttpClient` harvests them into the session jar via `headers.getSetCookie()`. The jar objects never meet — the HTTP headers are the interchange format.

**Response fidelity**: the wrapper (`ResponseWithUrl`) preserves status, status text, final URL, all headers, and the fully decompressed body, so redirect resolution and cookie harvesting see exactly what the wire produced.

One browsersmith `FetchClient` per client instance; no additional queuing — Crawlee owns concurrency.

## Public API

| Export | Kind | Purpose |
| --- | --- | --- |
| `BrowsersmithHttpClient` | class | The Crawlee HTTP client (extends `BaseHttpClient`) |
| `BrowsersmithHttpClientOptions` | interface | `profile` (`ProfileId \| "auto"`), `timeoutMs`, `maxRedirects`, `ignoreTlsErrors`, `logger`, `platform`, `transportFactory` |
| `ProfileSelection` | type alias | `ProfileId \| "auto"` |
| `resolveProfileId()` | function | Pure fingerprint → profile mapping |
| `toCrawleeResponse()` | function | FetchResponse → `ResponseWithUrl` wrapping |
| `SetCookieCaptureJar` | class | Inert response-side jar capturing raw `Set-Cookie` values verbatim |
| `BrowsersmithHttpClientError` | class | Base typed error (`kind` + `details` + `cause`) |
| `IgnoreTlsErrorsUnsupportedError` | class | `ignoreTlsErrors` requested — browsersmith cannot skip certificate validation |
| `UnsupportedHttpMethodError` | class | Method outside GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS |
| `FetchError`, `FetchProxyError`, `FetchTimeoutError`, `RedirectError`, `ProtocolError`, `ProxyConfigError`, `UnknownProfileError` | classes | Re-exported underlying-stack errors — match without importing browsersmith directly |

## Limitations

- **No `http://` origins on the real dial.** browsersmith always negotiates TLS (real path: TCP → TLS → ALPN h2/http1.1). Plain-HTTP targets need the `transportFactory` test seam (see the options docs); the seam speaks HTTP/1.1 to whatever transport you inject.
- **`ignoreTlsErrors` is a typed error, not a silent downgrade.** A MITM proxy's certificate breaks the browser fingerprint the stack exists to produce. Use `ImpitHttpClient` if you need MITM support.
- **Multi-cookie responses deliver one `Set-Cookie`.** browsersmith 0.0.16's protocol decoders (`@browsercore/http1` response parsing, `@browsercore/http2` HEADERS assembly) collapse duplicate header names to the last value, so of several `Set-Cookie` headers only the final one reaches the session jar. This package forwards everything the stack preserves; when browsersmith gains duplicate-header fidelity, the harvesting picks it up with no change here. Single-cookie responses (the common case) are fully preserved.
- **HEAD over HTTP/1.1-only origins.** Over HTTP/2 HEAD is clean. On the real-TLS path an origin that negotiates HTTP/1.1 (and keep-alives after a HEAD with no `content-length`) trips a close-delimiting wait in `@browsercore/http1` — the request eventually resolves and the connection is recycled, but slowly. The `transportFactory` seam is exempt (the client detects seam mode and sends `Connection: close`, which the pool isolation below makes safe).
- **The browsersmith pool does not evict server-closed connections.** A server-initiated close (keep-alive timeout) leaves a dead pool entry until the next dial failure; the subsequent request surfaces a typed `FetchError` and Crawlee's retry policy re-dials. Retryable at the crawler level.
- **`safari-18`'s HTTP/2 SETTINGS draw GOAWAY/PROTOCOL_ERROR from common nginx deployments** (verified live against books.toscrape.com). `auto` never selects it; pinning it explicitly is at your own risk.
- **Supported methods**: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS — browsersmith's `FetchMethod` union; anything else throws `UnsupportedHttpMethodError` instead of sending an unvalidated wire method.

## Package dependencies

```
@browsercore/crawlee
├── browsersmith            (the full browser-identical networking stack)
│     └── @browsercore/transport, fetch, http1, http2, tls, proxy, cookies, profiles, …
├── @browsercore/transport  (typed Transport for the test seam)
└── @crawlee/http-client    (peer — BaseHttpClient contract)
```

Zero native dependencies — the TLS stack is pure TypeScript over Node's crypto primitives.

## Position in BrowserCore

```
Crawlee (CheerioCrawler / HttpCrawler / BasicCrawler)
      │  httpClient option
 @browsercore/crawlee   ← this package (BaseHttpClient adapter)
      │
 browsersmith (TLS + HTTP/2 + HTTP/1.1 + cookies + proxy tunnels)
      │
 TCP
```

## License

MIT
