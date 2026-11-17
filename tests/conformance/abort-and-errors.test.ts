/**
 * Conformance: timeouts, aborts, and error surfacing — BrowsersmithHttpClient
 * vs crawlee's stock FetchHttpClient (undici), on the same fixtures.
 *
 * Scenario origins (Apache-2.0, apify/crawlee):
 * - "BaseHttpClient signal and timeoutMillis options"
 *   (test/core/base-http-client.test.ts): no-signal requests succeed;
 *   pre-aborted signals reject; signals aborted mid-request reject;
 *   `timeoutMillis` elapsing rejects; a signal racing a longer timeout wins.
 * - Retryability: crawlee's crawler machinery retries network-level request
 *   errors — a connection-refused failure must surface as a request error
 *   (not a silent success) so the retry path engages, for EITHER client.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheerioCrawler, RequestQueue } from "crawlee";
import { FetchHttpClient } from "@crawlee/http-client";
import * as http from "node:http";
import { CLIENT_KINDS, clientFor, freshCrawlerConfiguration, isolatedSessionPool, originOf, startConformanceServer } from "./support.js";
import { BrowsersmithHttpClient } from "../../src/index.js";
import type { TestServer } from "../helpers.js";

let server: TestServer;
/** A loopback port with nothing listening — connection-refused target. */
let deadPort: number;
/** Disambiguates the per-crawl queue names inside this file. */
let deadQueueCounter = 0;

beforeAll(async () => {
    server = await startConformanceServer();
    // Grab a port then close its listener: dialing it now refuses.
    const placeholder = http.createServer();
    await new Promise<void>((resolve) => placeholder.listen(0, "127.0.0.1", resolve));
    const address = placeholder.address();
    deadPort = address !== null && typeof address !== "string" ? address.port : 0;
    await new Promise<void>((resolve) => placeholder.close(() => resolve()));
});

afterAll(async () => {
    await server.close();
});

describe.for(CLIENT_KINDS)("timeouts, aborts, and errors (%s)", (kind) => {
    it("sends a request without any signal or timeout", async () => {
        const handle = clientFor(kind);
        try {
            const response = await handle.client.sendRequest(new Request(`${originOf(server)}/echo`));
            expect(response.status).toBe(200);
        } finally {
            await handle.close();
        }
    });

    it("rejects when a pre-aborted signal is passed", async () => {
        const handle = clientFor(kind);
        try {
            const controller = new AbortController();
            controller.abort();
            await expect(
                handle.client.sendRequest(new Request(`${originOf(server)}/echo`), {
                    signal: controller.signal,
                }),
            ).rejects.toThrow();
        } finally {
            await handle.close();
        }
    });

    it("rejects when the signal is aborted after the request starts", async () => {
        const handle = clientFor(kind);
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 50);
            await expect(
                handle.client.sendRequest(new Request(`${originOf(server)}/slow?ms=1000`), {
                    signal: controller.signal,
                }),
            ).rejects.toThrow();
        } finally {
            await handle.close();
        }
    });

    it("rejects when timeoutMillis elapses", async () => {
        const handle = clientFor(kind);
        try {
            await expect(
                handle.client.sendRequest(new Request(`${originOf(server)}/slow?ms=1000`), {
                    timeoutMillis: 50,
                }),
            ).rejects.toThrow();
        } finally {
            await handle.close();
        }
    });

    it("rejects with a connection error when the origin refuses the connection", async () => {
        const handle = clientFor(kind);
        try {
            await expect(
                handle.client.sendRequest(new Request(`http://127.0.0.1:${deadPort}/echo`)),
            ).rejects.toThrow();
        } finally {
            await handle.close();
        }
    });
});

describe.for(CLIENT_KINDS)("crawler-level error surfacing (%s)", (kind) => {
    it("a connection-refused crawl request fails and engages crawlee's retry path", async () => {
        // Real dial for both clients (no fixture factory): the dead port is
        // refused at TCP level, exactly like a real origin going down, and
        // the error wrapping stays identical to production.
        const client =
            kind === "undici" ? new FetchHttpClient() : new BrowsersmithHttpClient();
        const retryableErrors: string[] = [];
        const finalErrors: string[] = [];
        const requestManager = await RequestQueue.open(`conformance-dead-${deadPort}-${deadQueueCounter += 1}`, {
            configuration: freshCrawlerConfiguration(),
        });
        const crawler = new CheerioCrawler({
            configuration: freshCrawlerConfiguration(),
            // @ts-expect-error — crawlee 4.0.0-rc.2's own Session class is not
            // assignable to its own ISessionPool.getSession() return type under
            // exactOptionalPropertyTypes (Session.get proxyInfo(): ProxyInfo |
            // undefined vs ISession.proxyInfo?: ProxyInfo). crawlee's declaration
            // bug, not ours; SessionPool literally `implements ISessionPool`.
            sessionPool: isolatedSessionPool(),
            requestManager,
            httpClient: client,
            maxRequestRetries: 1,
            maxConcurrency: 1,
            navigationTimeoutSecs: 10,
            errorHandler(_context, error) {
                retryableErrors.push(error?.message ?? "unknown error");
            },
            failedRequestHandler(_context, error) {
                finalErrors.push(error?.message ?? "unknown error");
            },
            async requestHandler() {
                retryableErrors.push("unexpected success");
            },
        });
        try {
            await crawler.run([`http://127.0.0.1:${deadPort}/page`]);
        } finally {
            if (client instanceof BrowsersmithHttpClient) {
                await client.close().catch(() => undefined);
            }
        }
        // crawlee classified the connection error as RETRYABLE (errorHandler
        // fires only for attempts it will reclaim — see basic-crawler's
        // #canRequestBeRetried) and the request ultimately failed cleanly
        // (exactly one final failure, no silent success).
        expect(retryableErrors.length).toBeGreaterThanOrEqual(1);
        expect(retryableErrors).not.toContain("unexpected success");
        expect(finalErrors).toHaveLength(1);
    });
});
