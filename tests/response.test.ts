/**
 * toCrawleeResponse — FetchResponse → ResponseWithUrl wrapping fidelity.
 */

import { describe, expect, it } from "vitest";
import { ResponseWithUrl } from "@crawlee/http-client";
import { toCrawleeResponse } from "../src/response.js";
import type { FetchResponse } from "browsersmith";

/** Fabricate a FetchResponse-shaped object without going over the wire. */
function fakeFetchResponse(overrides: Partial<FetchResponse> = {}, setCookie: string[] = []): FetchResponse {
    return {
        url: "https://example.com/final",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain", "x-custom": "v" },
        bodyUsed: false,
        getHeaderValues: (name: string) => (name === "set-cookie" ? setCookie : []),
        getSetCookie: () => setCookie,
        body: () => Promise.resolve(new TextEncoder().encode("hello")),
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("hello"),
        clone() {
            return fakeFetchResponse(overrides, setCookie);
        },
        ...overrides,
    } as unknown as FetchResponse;
}

describe("toCrawleeResponse", () => {
    it("returns a ResponseWithUrl preserving url, status, statusText, headers, body", async () => {
        const response = await toCrawleeResponse(fakeFetchResponse());
        expect(response instanceof ResponseWithUrl).toBe(true);
        expect(response.url).toBe("https://example.com/final");
        expect(response.status).toBe(200);
        expect(response.statusText).toBe("OK");
        expect(response.headers.get("content-type")).toBe("text/plain");
        expect(response.headers.get("x-custom")).toBe("v");
        expect(await response.text()).toBe("hello");
    });

    it("exposes every Set-Cookie value through getSetCookie() — wire order, verbatim", async () => {
        const response = await toCrawleeResponse(
            fakeFetchResponse({}, ["a=1; Path=/", "b=2; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "c=3; Path=/; Secure"]),
        );
        // WHATWG Headers built from a sequence of pairs preserves duplicate
        // set-cookie entries — the base class harvests them all into the
        // session jar.
        expect(response.headers.getSetCookie()).toEqual([
            "a=1; Path=/",
            "b=2; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
            "c=3; Path=/; Secure",
        ]);
    });

    it("carries a single Set-Cookie through unchanged", async () => {
        const response = await toCrawleeResponse(fakeFetchResponse({}, ["sid=xyz; Path=/; HttpOnly"]));
        expect(response.headers.getSetCookie()).toEqual(["sid=xyz; Path=/; HttpOnly"]);
    });

    it("produces no set-cookie header when the response carried none", async () => {
        const response = await toCrawleeResponse(fakeFetchResponse());
        expect(response.headers.getSetCookie()).toEqual([]);
    });

    it("drops HTTP/2 pseudo-headers the h2 decoder leaves in the record", async () => {
        const response = await toCrawleeResponse(
            fakeFetchResponse({ headers: { ":status": "200", "content-type": "text/html" } }),
        );
        const names = [...response.headers.keys()];
        expect(names.some((name) => name.startsWith(":"))).toBe(false);
        expect(response.headers.get("content-type")).toBe("text/html");
        expect(response.status).toBe(200);
    });

    it("maps null-body statuses to a null body (ResponseWithUrl contract)", async () => {
        const response = await toCrawleeResponse(
            fakeFetchResponse({ status: 204, statusText: "No Content" }),
        );
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
    });
});
