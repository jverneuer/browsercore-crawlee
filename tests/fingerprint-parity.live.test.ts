/**
 * LIVE fingerprint parity gate — the offline goldens, asserted against a real
 * detector. ONE request per run to https://tls.peet.ws/api/all (the TLS/HTTP2
 * fingerprint oracle — an echo endpoint designed for exactly this), through a
 * REAL BrowsersmithHttpClient dial.
 *
 * Gated OFF by default so `npm test` stays offline-deterministic; CI runs it
 * as its own step after the unit suite:
 *
 * ```bash
 * FINGERPRINT_LIVE=1 npx vitest run tests/fingerprint-parity.live.test.ts
 * ```
 *
 * The assertions are EXACT (no prefix-matching, no tail drift):
 * - `tls.ja4` == `t13d1516h2_8daaf6152771_d8a2da3f94cd` — the same real-Chrome
 *   pin browsersmith's own suite and the offline parity test hold.
 * - `http2.akamai_fingerprint` ==
 *   `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p` — the chrome-131
 *   oracle (SETTINGS are unchanged 131→140).
 *
 * If either diverges, the wire is no longer browser-identical: fix the stack,
 * do not loosen these strings.
 */

import { describe, expect, it } from "vitest";
import { BrowsersmithHttpClient } from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/naming-convention -- env var style
const LIVE = process.env["FINGERPRINT_LIVE"] === "1" || process.env["BROWSERSMITH_CRAWLEE_LIVE"] === "1";

/** Real Chrome 146 JA4 (tls.browserleaks.com, 2026-10-31). */
const GOLD_JA4 = "t13d1516h2_8daaf6152771_d8a2da3f94cd" as const;
/** Chrome Akamai h2 fingerprint (chrome-131 oracle; SETTINGS unchanged 131→140). */
const GOLD_AKAMAI = "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p" as const;

/** The peet.ws oracle's response shape — only the fields under assertion. */
interface PeetAllReport {
    readonly tls: { readonly ja4?: unknown };
    readonly http2: { readonly akamai_fingerprint?: unknown };
}

/** Validate the oracle JSON before asserting on it (external data = unknown). */
function asPeetReport(raw: unknown): PeetAllReport {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("peet.ws oracle returned a non-object body");
    }
    const { tls, http2 } = raw as Record<string, unknown>;
    if (typeof tls !== "object" || tls === null || typeof http2 !== "object" || http2 === null) {
        throw new Error("peet.ws oracle body is missing the tls/http2 sections");
    }
    return { tls: tls as Record<string, unknown>, http2: http2 as Record<string, unknown> };
}

describe.skipIf(!LIVE)("fingerprint parity — LIVE oracle (tls.peet.ws, 1 request)", () => {
    it("reports the golden browser JA4 and Akamai h2 fingerprint for our dial", async () => {
        const client = new BrowsersmithHttpClient();
        try {
            const response = await client.sendRequest(new Request("https://tls.peet.ws/api/all"));
            expect(response.status).toBe(200);
            const report = asPeetReport(await response.json());

            const observedJa4 = report.tls.ja4;
            const observedAkamai = report.http2.akamai_fingerprint;
            // Surface the observed values in the failure message verbatim —
            // a divergence here is a reportable event, not a test detail.
            if (observedJa4 !== GOLD_JA4 || observedAkamai !== GOLD_AKAMAI) {
                throw new Error(
                    `LIVE fingerprint divergence — observed values:\n` +
                        `  tls.ja4                 = ${String(observedJa4)}\n` +
                        `  http2.akamai_fingerprint = ${String(observedAkamai)}\n` +
                        `expected:\n` +
                        `  tls.ja4                  = ${GOLD_JA4}\n` +
                        `  http2.akamai_fingerprint = ${GOLD_AKAMAI}`,
                );
            }
            expect(observedJa4).toBe(GOLD_JA4);
            expect(observedAkamai).toBe(GOLD_AKAMAI);
        } finally {
            await client.close();
        }
    }, 60_000);
});
