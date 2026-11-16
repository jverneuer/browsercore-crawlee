/**
 * toCrawleeResponse — FetchResponse → ResponseWithUrl wrapping fidelity.
 */

import { describe, expect, it } from "vitest";
import { ResponseWithUrl } from "@crawlee/http-client";
import { toCrawleeResponse } from "../src/response.js";
import type { FetchResponse } from "browsersmith";

/** Fabricate a FetchResponse-shaped object without going over the wire. */
function fakeFetchResponse(overrides: Partial<FetchResponse> = {}): FetchResponse {
    return {
        url: "https://example.com/final",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain", "x-custom": "v" },
        bodyUsed: false,
        body: () => Promise.resolve(new TextEncoder().encode("hello")),
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("hello"),
        clone() {
            return fakeFetchResponse(overrides);
        },
        ...overrides,
    } as FetchResponse;
}

describe("toCrawleeResponse", () => {
    it("returns a ResponseWithUrl preserving url, status, statusText, headers, body", async () => {
        const response = await toCrawleeResponse(fakeFetchResponse(), []);
        expect(response instanceof ResponseWithUrl).toBe(true);
        expect(response.url).toBe("https://example.com/final");
        expect(response.status).toBe(200);
        expect(response.statusText).toBe("OK");
        expect(response.headers.get("content-type")).toBe("text/plain");
        expect(response.headers.get("x-custom")).toBe("v");
        expect(await response.text()).toBe("hello");
    });

    it("re-emits every captured Set-Cookie value for getSetCookie()", async () => {
        const response = await toCrawleeResponse(fakeFetchResponse(), [
            "a=1; Path=/",
            "b=2; Path=/; Secure",
        ]);
        expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/; Secure"]);
    });

    it("drops HTTP/2 pseudo-headers the h2 decoder leaves in the record", async () => {
        const response = await toCrawleeResponse(
            fakeFetchResponse({ headers: { ":status": "200", "content-type": "text/html" } }),
            [],
        );
        const names = [...response.headers.keys()];
        expect(names.some((name) => name.startsWith(":"))).toBe(false);
        expect(response.headers.get("content-type")).toBe("text/html");
        expect(response.status).toBe(200);
    });

    it("skips the record's collapsed set-cookie entry — captured values are the source of truth", async () => {
        const response = await toCrawleeResponse(
            fakeFetchResponse({ headers: { "set-cookie": "last=1; Path=/" } }),
            ["captured=1; Path=/"],
        );
        expect(response.headers.getSetCookie()).toEqual(["captured=1; Path=/"]);
    });

    it("produces no set-cookie header when neither the record nor captures carry one", async () => {
        const response = await toCrawleeResponse(fakeFetchResponse(), []);
        expect(response.headers.getSetCookie()).toEqual([]);
    });

    it("maps null-body statuses to a null body (ResponseWithUrl contract)", async () => {
        const response = await toCrawleeResponse(
            fakeFetchResponse({ status: 204, statusText: "No Content" }),
            [],
        );
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
    });
});
