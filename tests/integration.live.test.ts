/**
 * LIVE integration: a real CheerioCrawler fetching through
 * BrowsersmithHttpClient over browsersmith's real TLS stack.
 *
 * Gated like crawlee gates its live tests — it only runs when the explicit
 * environment variable is set (CI runs the offline suite; this file runs
 * locally to prove the integration end-to-end):
 *
 * ```bash
 * BROWSERSMITH_CRAWLEE_LIVE=1 npx vitest run tests/integration.live.test.ts
 * ```
 */

import { describe, expect, it } from "vitest";
import { CheerioCrawler } from "crawlee";
import { BrowsersmithHttpClient } from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/naming-convention -- env var style
const LIVE = process.env.BROWSERSMITH_CRAWLEE_LIVE === "1";

const CATEGORY_URLS = [
    "https://books.toscrape.com/catalogue/category/books/travel_2/index.html",
    "https://books.toscrape.com/catalogue/category/books/mystery_3/index.html",
    "https://books.toscrape.com/catalogue/category/books/fantasy_19/index.html",
];

describe.skipIf(!LIVE)("CheerioCrawler through BrowsersmithHttpClient (live)", () => {
    it("crawls books.toscrape.com — 3 requests, 3 successes, real titles", async () => {
        const statuses: number[] = [];
        const titles: string[] = [];

        const crawler = new CheerioCrawler({
            httpClient: new BrowsersmithHttpClient(),
            maxRequestRetries: 0,
            maxConcurrency: 1,
            maxRequestsPerCrawl: 3,
            requestHandlerTimeoutSecs: 60,
            navigationTimeoutSecs: 60,
            async requestHandler({ request, response, $ }) {
                statuses.push(response?.status ?? 0);
                titles.push($("title").first().text().trim());
                expect(request.url).toContain("books.toscrape.com");
            },
        });

        await crawler.run(CATEGORY_URLS);

        expect(statuses).toHaveLength(3);
        expect(statuses.every((status) => status === 200)).toBe(true);
        // Real page titles prove the HTML arrived through the TLS stack and
        // Cheerio parsed it — not stubs.
        expect(titles.every((title) => title.length > 0)).toBe(true);
        expect(titles.some((title) => /books/i.test(title))).toBe(true);
    }, 180_000);

    it("crawls books.toscrape.com with the safari-18 profile — 3 requests, 3 successes", async () => {
        // safari-18's HTTP/2 framing previously drew GOAWAY/PROTOCOL_ERROR
        // from this nginx edge; profiles 0.2.5 fixed it — this is the
        // regression guard: safari must crawl, not just resolve.
        const statuses: number[] = [];
        const titles: string[] = [];

        const crawler = new CheerioCrawler({
            httpClient: new BrowsersmithHttpClient({ profile: "safari-18" }),
            maxRequestRetries: 0,
            maxConcurrency: 1,
            maxRequestsPerCrawl: 3,
            requestHandlerTimeoutSecs: 60,
            navigationTimeoutSecs: 60,
            async requestHandler({ response, $ }) {
                statuses.push(response?.status ?? 0);
                titles.push($("title").first().text().trim());
            },
        });

        await crawler.run(CATEGORY_URLS);

        expect(statuses).toHaveLength(3);
        expect(statuses.every((status) => status === 200)).toBe(true);
        expect(titles.every((title) => title.length > 0)).toBe(true);
    }, 180_000);
});
