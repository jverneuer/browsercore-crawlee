/**
 * Conformance: request/response payload handling — BrowsersmithHttpClient vs
 * crawlee's stock FetchHttpClient (undici), on the same fixtures.
 *
 * Scenario origins (Apache-2.0, apify/crawlee + this polyrepo):
 * - HEAD requests: impit-client's response-body semantics (a HEAD resolves
 *   with headers only, no body) — the pooled-HEAD path is a regression the
 *   repo already guards; here it must also match the stock client exactly.
 * - gzip/brotli content-encoding round-trip: browsersmith's e2e compression
 *   scenarios (`e2e-redirect-compress.test.ts` in the browsersmith repo) —
 *   the body the caller reads is the DECOMPRESSED payload, and the request
 *   advertises an accept-encoding that covers it.
 * - keep-alive reuse: connection pooling across sequential requests — both
 *   stacks hold one TCP connection per origin per client.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import { CLIENT_KINDS, clientFor, originOf, startConformanceServer } from "./support.js";
import type { ClientKind } from "./support.js";
import type { TestServer } from "../helpers.js";

let server: TestServer;

beforeAll(async () => {
    server = await startConformanceServer();
});

afterAll(async () => {
    await server.close();
});

describe.for(CLIENT_KINDS)("payload handling (%s)", (kind) => {
    it("serves a HEAD request with headers and an empty body", async () => {
        const handle = clientFor(kind, server);
        try {
            const response = await handle.client.sendRequest(
                new Request(`${originOf(server)}/echo`, { method: "HEAD" }),
            );
            expect(response.status).toBe(200);
            // Node suppresses the body on the wire for HEAD; the client must
            // surface an empty body exactly like the stock client does.
            expect(await response.text()).toBe("");
        } finally {
            await handle.close();
        }
    });

    // Both kinds take these through their full response path: for browsersmith
    // that includes the transport-seam h1 dial, which threads the platform
    // decompression provider since @browsercore/fetch 0.2.22 (fetch#76) —
    // before that, a compressed response through the seam failed with a typed
    // ContentEncodingError instead of yielding the decoded body.
    it("round-trips a gzip content-encoding response as the decompressed body", async () => {
        const handle = clientFor(kind, server);
        try {
            const response = await handle.client.sendRequest(new Request(`${originOf(server)}/compressed?enc=gzip`));
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("compressed fixture body — round-trips through content-encoding");
        } finally {
            await handle.close();
        }
    });

    it("round-trips a brotli content-encoding response as the decompressed body", async () => {
        const handle = clientFor(kind, server);
        try {
            const response = await handle.client.sendRequest(new Request(`${originOf(server)}/compressed?enc=br`));
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("compressed fixture body — round-trips through content-encoding");
        } finally {
            await handle.close();
        }
    });

    it("advertises an accept-encoding that covers gzip on content-bearing requests", async () => {
        const handle = clientFor(kind, server);
        try {
            const response = await handle.client.sendRequest(new Request(`${originOf(server)}/echo`));
            expect(response.status).toBe(200);
            const seen = server.seenRequests.at(-1);
            expect(seen?.headers["accept-encoding"] ?? "").toContain("gzip");
        } finally {
            await handle.close();
        }
    });
});

/**
 * A TCP-connection-counting reverse proxy in front of a fresh fixture — the
 * keep-alive observable is how many TCP connections the CLIENT opens for two
 * sequential requests to the same origin.
 */
async function startCountingProxy(upstreamPort: number): Promise<{
    readonly port: number;
    readonly connectionCount: () => number;
    close(): Promise<void>;
}> {
    let connections = 0;
    const proxy = http.createServer((req, res) => {
        const upstream = http.request(
            {
                host: "127.0.0.1",
                port: upstreamPort,
                path: req.url,
                method: req.method,
                headers: req.headers,
            },
            (upstreamRes) => {
                res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
                upstreamRes.pipe(res);
            },
        );
        upstream.on("error", () => {
            if (!res.headersSent) {
                res.writeHead(502);
            }
            res.end();
        });
        req.pipe(upstream);
    });
    proxy.on("connection", () => {
        connections += 1;
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    const port = address !== null && typeof address !== "string" ? address.port : 0;
    return {
        port,
        connectionCount: () => connections,
        close: async () => {
            proxy.closeIdleConnections();
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
        },
    };
}

describe.for(CLIENT_KINDS)("connection reuse (%s)", (kind: ClientKind) => {
    it("serves two sequential requests over one keep-alive connection", async () => {
        const reuseFixture = await startConformanceServer();
        const proxy = await startCountingProxy(reuseFixture.port);
        const handle = clientFor(kind, reuseFixture);
        try {
            // Warm-up ×2: undici's global pool opens a spare socket for the
            // first two requests of a cold origin; the reuse property under
            // test is the steady state once connections exist.
            const firstWarmUp = await handle.client.sendRequest(new Request(`http://127.0.0.1:${proxy.port}/echo`));
            expect(firstWarmUp.status).toBe(200);
            const secondWarmUp = await handle.client.sendRequest(new Request(`http://127.0.0.1:${proxy.port}/echo`));
            expect(secondWarmUp.status).toBe(200);
            const baseline = proxy.connectionCount();
            const first = await handle.client.sendRequest(new Request(`http://127.0.0.1:${proxy.port}/echo`));
            expect(first.status).toBe(200);
            const second = await handle.client.sendRequest(new Request(`http://127.0.0.1:${proxy.port}/echo`));
            expect(second.status).toBe(200);
            expect(proxy.connectionCount()).toBe(baseline);
        } finally {
            await handle.close();
            await proxy.close();
            await reuseFixture.close();
        }
    });
});
