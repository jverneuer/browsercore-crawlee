/**
 * Conformance: proxyUrl mapping — BrowsersmithHttpClient through local
 * in-process proxies.
 *
 * The proxyUrl scenarios are BrowsersmithHttpClient-only: crawlee's stock
 * `FetchHttpClient` documents itself as "does not support proxying"
 * (packages/http-client/src/fetch-http-client.ts) — proxy support is exactly
 * where this client offers MORE than the stock baseline, matching
 * GotScraping/impit behavior instead. Scenario origins (Apache-2.0,
 * apify/crawlee): impit-client's proxyUrl → proxy-option mapping and its
 * https-proxy limitation, which this package surfaces as a typed
 * `ProxyConfigError` naming the scheme (the @browsercore/proxy contract).
 *
 * The local proxies are real in-process servers: an HTTP CONNECT proxy
 * (browsersmith `examples/proxy-fetch.ts` pattern) and a SOCKS5 server
 * speaking the RFC 1928 no-auth DOMAINNAME shape ("socks5h" — remote DNS).
 * The transport seam is dialed at the PROXY endpoint and performs the real
 * handshake against it, so the path proven here is: proxyUrl → parseProxyUrl
 * → dial at the proxy endpoint → CONNECT/SOCKS5h handshake → request bytes
 * through the tunnel → fixture response. (The origin reaches the handshake
 * from the test closure because the seam's dial carries only the proxy
 * endpoint — on the real path openProxiedTransport reads it off the URL.)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowsersmithHttpClient } from "../../src/index.js";
import { ProxyConfigError } from "browsersmith";
import {
    originOf,
    startConformanceServer,
    startConnectProxy,
    startSocks5Server,
    tunnellingTransportFactory,
} from "./support.js";
import type { LocalProxy } from "./support.js";
import type { TestServer } from "../helpers.js";

let server: TestServer;
let connectProxy: LocalProxy;
let socksProxy: LocalProxy;

beforeAll(async () => {
    server = await startConformanceServer();
    connectProxy = await startConnectProxy();
    socksProxy = await startSocks5Server();
});

afterAll(async () => {
    await connectProxy.close();
    await socksProxy.close();
    await server.close();
});

describe("proxyUrl mapping — http CONNECT", () => {
    it("routes the request through the proxy and completes over the tunnel", async () => {
        const harness = tunnellingTransportFactory(connectProxy, "http", "127.0.0.1", server.port);
        const client = new BrowsersmithHttpClient({ transportFactory: harness.factory });
        try {
            const response = await client.sendRequest(new Request(`${originOf(server)}/echo`), {
                proxyUrl: `http://127.0.0.1:${connectProxy.port}`,
            });
            expect(response.status).toBe(200);
            const echoed = (await response.json()) as { url: string; method: string };
            expect(echoed.url).toBe("/echo");
            expect(echoed.method).toBe("GET");
        } finally {
            await client.close();
        }
        // The mapping observable: the dial went to the PROXY's endpoint…
        expect(harness.dialed).toEqual([{ host: "127.0.0.1", port: connectProxy.port }]);
        // …and the proxy tunnelled exactly the fixture origin, by host:port.
        expect(connectProxy.observations.connectTargets).toEqual([`127.0.0.1:${server.port}`]);
    });

    it("carries POST bodies and headers through the tunnel unchanged", async () => {
        const harness = tunnellingTransportFactory(connectProxy, "http", "127.0.0.1", server.port);
        const client = new BrowsersmithHttpClient({ transportFactory: harness.factory });
        try {
            const response = await client.sendRequest(
                new Request(`${originOf(server)}/echo`, {
                    method: "POST",
                    body: "tunnelled-payload",
                    headers: { "x-proxied": "yes" },
                }),
                { proxyUrl: `http://127.0.0.1:${connectProxy.port}` },
            );
            expect(response.status).toBe(200);
            const echoed = (await response.json()) as { method: string; body: string; headers: Record<string, string> };
            expect(echoed.method).toBe("POST");
            expect(echoed.body).toBe("tunnelled-payload");
            expect(echoed.headers["x-proxied"]).toBe("yes");
        } finally {
            await client.close();
        }
    });
});

describe("proxyUrl mapping — socks5h (remote DNS)", () => {
    it("relays through the SOCKS5 server with a DOMAINNAME request for the origin host", async () => {
        const harness = tunnellingTransportFactory(socksProxy, "socks5h", "127.0.0.1", server.port);
        const client = new BrowsersmithHttpClient({ transportFactory: harness.factory });
        try {
            const response = await client.sendRequest(new Request(`${originOf(server)}/echo`), {
                proxyUrl: `socks5h://127.0.0.1:${socksProxy.port}`,
            });
            expect(response.status).toBe(200);
            const echoed = (await response.json()) as { url: string };
            expect(echoed.url).toBe("/echo");
        } finally {
            await client.close();
        }
        expect(harness.dialed).toEqual([{ host: "127.0.0.1", port: socksProxy.port }]);
        // socks5h = the CLIENT hands the hostname to the proxy (remote DNS):
        // the DOMAINNAME request must name the fixture origin's host:port.
        expect(socksProxy.observations.domainTargets).toEqual([`127.0.0.1:${server.port}`]);
    });
});

describe("proxyUrl mapping — typed rejections", () => {
    it("rejects an https-scheme proxy with ProxyConfigError naming the scheme", async () => {
        const harness = tunnellingTransportFactory(connectProxy, "http", "127.0.0.1", server.port);
        const client = new BrowsersmithHttpClient({ transportFactory: harness.factory });
        try {
            await expect(
                client.sendRequest(new Request(`${originOf(server)}/echo`), {
                    proxyUrl: `https://127.0.0.1:${connectProxy.port}`,
                }),
            ).rejects.toThrow(ProxyConfigError);
            await expect(
                client.sendRequest(new Request(`${originOf(server)}/echo`), {
                    proxyUrl: `https://127.0.0.1:${connectProxy.port}`,
                }),
            ).rejects.toThrow(/https/);
        } finally {
            await client.close();
        }
    });

    it("rejects an unparseable proxy URL with ProxyConfigError", async () => {
        const harness = tunnellingTransportFactory(connectProxy, "http", "127.0.0.1", server.port);
        const client = new BrowsersmithHttpClient({ transportFactory: harness.factory });
        try {
            await expect(
                client.sendRequest(new Request(`${originOf(server)}/echo`), {
                    proxyUrl: "not-a-proxy-url",
                }),
            ).rejects.toThrow(ProxyConfigError);
        } finally {
            await client.close();
        }
    });
});
