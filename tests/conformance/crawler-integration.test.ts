/**
 * Conformance: real CheerioCrawler end-to-end — BrowsersmithHttpClient vs
 * crawlee's stock FetchHttpClient (undici).
 *
 * The unit twins above drive `sendRequest` directly; these scenarios drive a
 * REAL `CheerioCrawler` (`httpClient: …`) the way embedding applications do,
 * proving the conformance holds through crawlee's full machinery — request
 * queue, session pool with its cookie jar, response parsing. Scenario origin
 * (Apache-2.0, apify/crawlee): the cheerio-crawler integration tests'
 * redirect-and-cookie fixture patterns, run once per client kind on the SAME
 * fixture with the SAME crawler shape so the observations are directly
 * comparable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlWith, originOf, startConformanceServer } from "./support.js";
import type { TestServer } from "../helpers.js";

let server: TestServer;

beforeAll(async () => {
    server = await startConformanceServer();
});

afterAll(async () => {
    await server.close();
});

describe.for(["browsersmith", "undici"] as const)("CheerioCrawler end-to-end (%s)", (kind) => {
    it("crawls a redirect chain to the final page with parsed HTML", async () => {
        const entry = `${originOf(server)}/redirect?status=301&to=/page`;
        const observation = await crawlWith(kind, [entry]);
        expect(observation.statuses).toEqual([200]);
        expect(observation.loadedUrls).toEqual([`${originOf(server)}/page`]);
        expect(observation.titles).toEqual(["conformance landing"]);
    });

    it("harvests session cookies set by one page and sends them to the next", async () => {
        // /cookie-drop serves HTML AND sets two cookies; /cookie-echo renders
        // the cookie header it received into the page body. A working session
        // jar interop means the second request carries the first's cookies.
        const observation = await crawlWith(kind, [`${originOf(server)}/cookie-drop`, `${originOf(server)}/cookie-echo`]);
        expect(observation.statuses).toEqual([200, 200]);
        expect(observation.cookieEchoes[1]).toContain("dropped=a");
        expect(observation.cookieEchoes[1]).toContain("dropped2=b");
    });
});

describe("CheerioCrawler end-to-end — cross-client equivalence", () => {
    it("both clients produce identical crawler observations for the same crawl", async () => {
        const urls = [
            `${originOf(server)}/redirect?status=302&to=/page`,
            `${originOf(server)}/cookie-drop`,
            `${originOf(server)}/cookie-echo`,
        ];
        const smith = await crawlWith("browsersmith", urls);
        const stock = await crawlWith("undici", urls);
        expect(smith.statuses).toEqual(stock.statuses);
        expect(smith.loadedUrls).toEqual(stock.loadedUrls);
        expect(smith.titles).toEqual(stock.titles);
    });
});
