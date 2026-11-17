/**
 * Comparative blocking canary — NOT part of CI. A runnable comparison
 * artifact: what a real bot detector sees when the SAME endpoint is fetched
 * by Node's default client (undici `fetch`, the stack FetchHttpClient uses)
 * versus by BrowsersmithHttpClient.
 *
 * ONE request per client per run to https://tls.peet.ws/api/all (2 total) —
 * keep it that way; this is a polite, manually invoked canary:
 *
 * ```bash
 * npm run canary
 * # or directly:
 * CANARY=1 npx vitest run tests/blocking-canary.live.test.ts
 * ```
 *
 * How to read the output: the canary PRINTS both observed JA4 + Akamai h2
 * fingerprints side by side. The only hard assertion is that OUR dial reads
 * browser-grade (the exact golden values the parity suites pin). Undici's
 * fingerprints are DOCUMENTED, not asserted — a stock runtime's non-browser
 * JA4 (`t13d1515h2_5b57614c22b0_…`-era, cipher/extension sets owned by
 * Node's OpenSSL defaults) is the expected, stable observation; asserting on
 * it would couple this suite to Node's TLS build, which is exactly the kind
 * of flaky claim this canary exists to avoid.
 */

import { describe, expect, it } from "vitest";
import { BrowsersmithHttpClient } from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/naming-convention -- env var style
const CANARY = process.env.CANARY === "1";

/** The oracle's response shape — only the fingerprint fields we read. */
interface PeetFingerprints {
    readonly ja4: string;
    readonly akamaiHttp2: string;
}

/** Real Chrome 146 JA4 (tls.browserleaks.com, 2026-10-31). */
const GOLD_JA4 = "t13d1516h2_8daaf6152771_d8a2da3f94cd" as const;
/** Chrome Akamai h2 fingerprint (chrome-131 oracle; SETTINGS unchanged 131→140). */
const GOLD_AKAMAI = "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p" as const;

/** Read the fingerprint fields off one oracle response. */
async function readFingerprints(response: Response): Promise<PeetFingerprints> {
    const raw: unknown = await response.json();
    if (typeof raw !== "object" || raw === null) {
        throw new Error("peet.ws oracle returned a non-object body");
    }
    const { tls, http2 } = raw as Record<string, unknown>;
    if (typeof tls !== "object" || tls === null || typeof http2 !== "object" || http2 === null) {
        throw new Error("peet.ws oracle body is missing the tls/http2 sections");
    }
    const ja4 = (tls as Record<string, unknown>).ja4;
    const akamaiHttp2 = (http2 as Record<string, unknown>).akamai_fingerprint;
    if (typeof ja4 !== "string" || typeof akamaiHttp2 !== "string") {
        throw new Error("peet.ws oracle body is missing ja4/akamai_fingerprint");
    }
    return { ja4, akamaiHttp2 };
}

describe.skipIf(!CANARY)("blocking canary — undici vs browsersmith (tls.peet.ws, 2 requests)", () => {
    it("our dial reads browser-grade while Node's default client does not", async () => {
        // 1. Node's default client stand-in (what crawlee's FetchHttpClient uses).
        const undiciResponse = await fetch("https://tls.peet.ws/api/all");
        expect(undiciResponse.status).toBe(200);
        const undici = await readFingerprints(undiciResponse);

        // 2. Our stack.
        const client = new BrowsersmithHttpClient();
        let ours: PeetFingerprints;
        try {
            const response = await client.sendRequest(new Request("https://tls.peet.ws/api/all"));
            expect(response.status).toBe(200);
            ours = await readFingerprints(response);
        } finally {
            await client.close();
        }

        // The comparison artifact — this table is the canary's output.
        const table = [
            ["", "undici (Node default)", "browsersmith (chrome-140)"],
            ["ja4", undici.ja4, ours.ja4],
            ["akamai h2", undici.akamaiHttp2, ours.akamaiHttp2],
        ];
        // eslint-disable-next-line no-console -- the canary's whole point is printing this table.
        console.info(
            table.map((row) => row.map((cell) => cell.padEnd(34)).join(" | ")).join("\n"),
        );

        // Hard assertions: OUR side only, exact goldens.
        expect(ours.ja4).toBe(GOLD_JA4);
        expect(ours.akamaiHttp2).toBe(GOLD_AKAMAI);
        // Documented (not asserted): undici's JA4 differs — a non-browser
        // fingerprint is the expected observation for a stock runtime.
        expect(undici.ja4).toMatch(/^t\d{2}d\d{4}h2_/);
        expect(undici.ja4 === ours.ja4).toBe(false);
    }, 60_000);
});
