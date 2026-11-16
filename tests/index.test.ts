/**
 * Barrel test — the public API surface is re-exported and nameable.
 */

import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("@browsercore/crawlee public API", () => {
    it("exports the documented surface", () => {
        expect(typeof api.BrowsersmithHttpClient).toBe("function");
        expect(typeof api.SetCookieCaptureJar).toBe("function");
        expect(typeof api.resolveProfileId).toBe("function");
        expect(typeof api.toCrawleeResponse).toBe("function");
        for (const errorClass of [
            api.BrowsersmithHttpClientError,
            api.IgnoreTlsErrorsUnsupportedError,
            api.UnsupportedHttpMethodError,
            // Re-exported underlying-stack errors for matching without importing
            // browsersmith directly.
            api.FetchError,
            api.FetchProxyError,
            api.FetchTimeoutError,
            api.RedirectError,
            api.ProtocolError,
            api.ProxyConfigError,
            api.UnknownProfileError,
        ]) {
            expect(typeof errorClass).toBe("function");
        }
    });
});
