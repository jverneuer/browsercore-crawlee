/**
 * Fingerprint parity gate (offline, deterministic) — the wire fingerprint
 * stays browser-identical through THIS package's stack.
 *
 * Two layers, both asserting ORACLE ground truth (never self-computed
 * constants):
 *
 * 1. TLS ClientHello — captured off the REAL dial: a BrowsersmithHttpClient
 *    (chrome-140) runs against a Platform whose TCP adapter is a recording
 *    sink, so the ClientHello the real `createClient` dial puts on the wire
 *    is captured verbatim and hashed with @browsercore/testing's computeJa4.
 *    Gold: JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd` — a REAL Chrome 146
 *    (Electron 41) reading of tls.browserleaks.com/json, 2026-10-31; the
 *    same pin browsersmith's own suite holds itself to.
 *
 * 2. HTTP/2 prelude — mirrors @browsercore-testing's emission-h2-prelude
 *    technique (the scenario's origin): the REAL `connectHttp2` over an
 *    in-memory capture transport, wired from the REAL chrome-140 profile
 *    exactly as @browsercore/fetch wires it. Gold: the chrome-131
 *    oracle_capture.reference.json values (identical 131→140):
 *    SETTINGS `1:65536;2:0;4:6291456;6:262144` (order-sensitive, 24-byte
 *    payload), connection WINDOW_UPDATE 15663105, request HEADERS flags
 *    0x25 + the 5-byte priority block, pseudo-header order m,a,s.p →
 *    (m,a,s,p), NO `host` field (RFC 9113 §8.3.6 — a live-confirmed WAF
 *    trigger), `priority: u=0, i`, and the profile-driven accept-encoding.
 *
 * The LIVE counterpart (one tls.peet.ws request asserting the same goldens
 * against a real detector) lives in tests/fingerprint-parity.live.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectHttp2, FrameType, HpackDecoder, Http2Settings } from "@browsercore/http2";
import type { HeaderField, Http2Connection, Http2SettingsMap } from "@browsercore/http2";
import {
    createPlatform,
    getProfile,
    nodeCryptoProvider,
    nodeEventProvider,
    PROFILES,
} from "browsersmith";
import type { BrowserProfile } from "browsersmith";
import type { ConnectOptions, DnsResolver, IPAddress, Net, Socket } from "@browsercore/contracts";
import { BrowsersmithHttpClient } from "../src/index.js";

// ─── oracle ground truth ─────────────────────────────────────────────────────

/** Real Chrome 146 JA4 (tls.browserleaks.com, 2026-10-31) — asserted EXACTLY. */
const GOLD_JA4 = "t13d1516h2_8daaf6152771_d8a2da3f94cd" as const;
/** The JA4 `a` segment alone: TLS1.3 + SNI + 15 ciphers + 16 extensions + ALPN h2. */
const GOLD_JA4_PREFIX = "t13d1516h2" as const;
/**
 * Real Chrome 146 extension SET (ja3n extension list; sorted here — the
 * shipped profile's wire ORDER differs from Chrome 146's, which affects
 * order-sensitive JA3 only, never JA4).
 */
const GOLD_JA3N_EXTENSIONS = "0-5-10-11-13-16-18-23-27-35-43-45-51-17613-65037-65281" as const;
/** Published Chrome Akamai h2 SETTINGS segment — order-sensitive. */
const GOLD_AKAMAI_SETTINGS = "1:65536;2:0;4:6291456;6:262144" as const;
/** Published connection-level WINDOW_UPDATE increment (akamai segment 2). */
const GOLD_WINDOW_UPDATE_INCREMENT = 15_663_105;
/** Published pseudo-header order segment: m,a,s,p. */
const GOLD_PSEUDO_ORDER = [":method", ":authority", ":scheme", ":path"] as const;
/** Wire bytes of the oracle's HEADERS priority block (excl bit + dep 0 + weight 0xff). */
const GOLD_PRIORITY_BLOCK = Uint8Array.from([0x80, 0x00, 0x00, 0x00, 0xff]);
/** RFC 7540 §3.5 client connection preface. */
const CLIENT_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

// ─── layer 1: ClientHello captured off the real dial ────────────────────────

/**
 * A TCP socket that records every client write and never speaks back — the
 * TLS handshake stalls after the first flight, which is exactly the moment
 * the ClientHello (the fingerprintable bytes) has been written.
 */
class CapturingSocket implements Socket {
    readonly #connectListeners: Array<() => void> = [];
    readonly #listeners = new Map<string, Set<(arg?: unknown) => void>>();
    #destroyed = false;
    /** Every client write, in call order. */
    readonly writes: Uint8Array[] = [];

    get destroyed(): boolean {
        return this.#destroyed;
    }

    constructor() {
        // The transport awaits the TCP connect before writing; a loopback
        // sink is "connected" immediately.
        queueMicrotask(() => {
            for (const listener of this.#connectListeners.splice(0)) {
                listener();
            }
        });
    }

    write(data: Uint8Array, cb?: (err?: Error | null) => void): boolean {
        this.writes.push(new Uint8Array(data));
        cb?.(null);
        return true;
    }

    end(): void {
        this.destroy(new Error("socket ended"));
    }

    destroy(error?: Error): void {
        if (this.#destroyed) {
            return;
        }
        this.#destroyed = true;
        for (const listener of this.#listeners.get("close") ?? []) {
            listener(true);
        }
        for (const listener of this.#listeners.get("error") ?? []) {
            listener(error ?? new Error("socket destroyed"));
        }
    }

    once(event: "connect" | "close", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: string, listener: (arg?: unknown) => void): void {
        const wrapped = (arg?: unknown): void => {
            this.#listeners.get(event)?.delete(wrapped);
            listener(arg);
        };
        this.#addListener(event, wrapped);
        if (event === "connect") {
            this.#connectListeners.push(() => wrapped());
        }
    }

    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "drain" | "end", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "close", listener: (hadError: boolean) => void): void;
    on(event: string, listener: (arg?: unknown) => void): void {
        this.#addListener(event, listener);
    }

    #addListener(event: string, listener: (arg?: unknown) => void): void {
        const set = this.#listeners.get(event) ?? new Set();
        set.add(listener);
        this.#listeners.set(event, set);
    }
}

/** A Net adapter whose every socket is a {@link CapturingSocket}. */
function capturingNet(sockets: CapturingSocket[]): Net {
    return {
        connect(_options: ConnectOptions): Socket {
            const socket = new CapturingSocket();
            sockets.push(socket);
            return socket;
        },
    };
}

/** A DNS resolver that resolves any name to the loopback sink. */
const loopbackDns: DnsResolver = {
    lookup: async (hostname: string, family: 4 | 6): Promise<readonly IPAddress[]> => [
        { address: family === 6 ? "::1" : "127.0.0.1", family },
    ],
};

/** Concatenate captured writes into one buffer. */
function concatenate(writes: readonly Uint8Array[]): Uint8Array {
    const total = writes.reduce((sum, chunk) => sum + chunk.length, 0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of writes) {
        buffer.set(chunk, offset);
        offset += chunk.length;
    }
    return buffer;
}

/**
 * Slice the first complete TLS record off the captured bytes. The record
 * header is `type(1) version(2) length(2)`; the ClientHello with the
 * post-quantum key share is ~1.8 KB and may span multiple writes.
 */
function firstTlsRecord(captured: Uint8Array): Uint8Array {
    expect(captured.length).toBeGreaterThan(5);
    expect(captured[0]).toBe(0x16); // ContentType handshake
    const recordLength = (captured[3]! << 8) | captured[4]!;
    expect(captured.length).toBeGreaterThanOrEqual(5 + recordLength);
    return captured.subarray(0, 5 + recordLength);
}

describe("fingerprint parity — TLS ClientHello through the real client dial (chrome-140)", () => {
    const sockets: CapturingSocket[] = [];
    const parityHost = "fingerprint-parity.example";
    let client: BrowsersmithHttpClient | undefined;
    let pending: Promise<unknown> | undefined;

    beforeAll(async () => {
        const platform = createPlatform({ network: { tcp: capturingNet(sockets), dns: loopbackDns } });
        client = new BrowsersmithHttpClient({ profile: "chrome-140", platform });
        // Fire the request but do not await it: the handshake parks on the
        // silent sink right after the ClientHello flight — the bytes under
        // test are already on the capture by then.
        pending = client
            .sendRequest(new Request(`https://${parityHost}/`))
            .then((response) => `unexpected response ${response.status}`)
            .catch((error: Error) => `expected dial stall: ${error.message}`);
        await vi.waitFor(() => {
            expect(sockets.length).toBeGreaterThanOrEqual(1);
            const captured = concatenate(sockets[0]!.writes);
            expect(captured.length).toBeGreaterThan(5);
            // The ClientHello (~1.8 KB with the PQ key share) arrives in
            // several writes — wait until the first record is complete.
            const recordLength = (captured[3]! << 8) | captured[4]!;
            expect(captured.length).toBeGreaterThanOrEqual(5 + recordLength);
        });
    });

    afterAll(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await client?.close().catch(() => undefined);
        await pending;
    });

    it("puts a single handshake record carrying a ClientHello on the wire", () => {
        const record = firstTlsRecord(concatenate(sockets[0]!.writes));
        // HandshakeType 0x01 at the top of the record body.
        expect(record[5]).toBe(0x01);
    });

    it("hashes to the REAL-Chrome golden JA4 EXACTLY (t13d1516h2_8daaf6152771_d8a2da3f94cd)", async () => {
        const { computeJa4 } = await import("@browsercore/testing");
        const record = firstTlsRecord(concatenate(sockets[0]!.writes));
        expect(computeJa4(record)).toBe(GOLD_JA4);
    });

    it("carries the JA4 shape a detector keys on: TLS 1.3, SNI, 15 ciphers, 16 extensions, ALPN h2", async () => {
        const { computeJa4 } = await import("@browsercore/testing");
        const record = firstTlsRecord(concatenate(sockets[0]!.writes));
        expect(computeJa4(record).split("_")[0]).toBe(GOLD_JA4_PREFIX);
    });

    it("advertises exactly real Chrome 146's TLS extension set and the h2 ALPN", async () => {
        const { parseAlpnProtocols, parseClientHello, parseClientHelloWire, parseSniHostname } =
            await import("@browsercore/testing");
        const record = firstTlsRecord(concatenate(sockets[0]!.writes));

        // Extension SET equality (sorted): the ja3n list from the same gold.
        const isGrease = (code: string): boolean => {
            const n = Number(code);
            return n >= 0x0a0a && n <= 0xfafa && (n >> 8) === (n & 0xff);
        };
        const parsed = parseClientHello(record);
        const extensionsSorted = parsed.extensions
            .split("-")
            .filter((code) => !isGrease(code))
            .map(Number)
            .sort((a, b) => a - b)
            .join("-");
        expect(extensionsSorted).toBe(GOLD_JA3N_EXTENSIONS);

        // ALPN negotiates h2 first — the JA4 'h2' segment's input.
        const wire = parseClientHelloWire(record);
        expect(parseAlpnProtocols(wire)).toContain("h2");
        // SNI names the request host — a mismatch would be a WAF giveaway.
        expect(parseSniHostname(wire)).toBe(parityHost);
    });
});

// ─── layer 2: HTTP/2 prelude off the real h2 connection ─────────────────────

/** Translate the profile's named settings to the numeric SETTINGS map (RFC 9113 §6.5.1). */
function profileSettingsMap(profile: BrowserProfile): Http2SettingsMap {
    const named = profile.http2.settings;
    const wire: Http2SettingsMap = {};
    if (named.headerTableSize !== undefined) {
        wire[Http2Settings.HEADER_TABLE_SIZE] = named.headerTableSize;
    }
    if (named.enablePush !== undefined) {
        wire[Http2Settings.ENABLE_PUSH] = named.enablePush ? 1 : 0;
    }
    if (named.maxConcurrentStreams !== undefined) {
        wire[Http2Settings.MAX_CONCURRENT_STREAMS] = named.maxConcurrentStreams;
    }
    if (named.initialWindowSize !== undefined) {
        wire[Http2Settings.INITIAL_WINDOW_SIZE] = named.initialWindowSize;
    }
    if (named.maxFrameSize !== undefined) {
        wire[Http2Settings.MAX_FRAME_SIZE] = named.maxFrameSize;
    }
    if (named.maxHeaderListSize !== undefined) {
        wire[Http2Settings.MAX_HEADER_LIST_SIZE] = named.maxHeaderListSize;
    }
    return wire;
}

/** One captured client write, parsed as an HTTP/2 frame. */
interface CapturedFrame {
    readonly type: number;
    readonly flags: number;
    readonly streamId: number;
    readonly payload: Uint8Array;
}

function parseCapturedFrame(raw: Uint8Array): CapturedFrame {
    const length = (raw[0]! << 16) | (raw[1]! << 8) | raw[2]!;
    return {
        type: raw[3]!,
        flags: raw[4]!,
        streamId: ((raw[5]! << 24) | (raw[6]! << 16) | (raw[7]! << 8) | raw[8]!) >>> 0,
        payload: raw.subarray(9, 9 + length),
    };
}

/** Render a SETTINGS payload as the Akamai order-sensitive segment string. */
function akamaiSettingsSegment(payload: Uint8Array): string {
    const entries: string[] = [];
    for (let i = 0; i + 5 < payload.length; i += 6) {
        const id = (payload[i]! << 8) | payload[i + 1]!;
        const value =
            (payload[i + 2]! << 24) | (payload[i + 3]! << 16) | (payload[i + 4]! << 8) | payload[i + 5]!;
        entries.push(`${id}:${value >>> 0}`);
    }
    return entries.join(";");
}

/**
 * In-memory duplex transport (mirrors @browsercore/testing's emission-test
 * fake): captures every client write verbatim; `feed()` serves server bytes.
 */
class CaptureTransport {
    readonly writes: Uint8Array[] = [];
    readonly #serverQueue: Uint8Array[] = [];
    #pendingRead: ((chunk: Uint8Array) => void) | null = null;

    write(data: Uint8Array): Promise<void> {
        this.writes.push(new Uint8Array(data));
        return Promise.resolve();
    }

    read(): Promise<Uint8Array> {
        const chunk = this.#serverQueue.shift();
        if (chunk !== undefined) {
            return Promise.resolve(chunk);
        }
        return new Promise<Uint8Array>((resolve) => {
            this.#pendingRead = resolve;
        });
    }

    close(): Promise<void> {
        return Promise.resolve();
    }

    /** Feed server → client bytes into the read path. */
    feed(chunk: Uint8Array): void {
        if (this.#pendingRead !== null) {
            const resolve = this.#pendingRead;
            this.#pendingRead = null;
            resolve(chunk);
        } else {
            this.#serverQueue.push(chunk);
        }
    }
}

describe("fingerprint parity — HTTP/2 prelude off the real connection stack (chrome-140)", () => {
    const SERVER_NAME = "tls.peet.ws";
    const profile = getProfile(PROFILES["chrome-140"]);

    let transport: CaptureTransport;
    let conn: Http2Connection;

    beforeAll(async () => {
        transport = new CaptureTransport();
        conn = await connectHttp2({
            // Handed a transport that only LOOKS like the contracts Transport
            // to the type checker — the connection uses write/read/close only,
            // exactly the surface the fake implements.
            transport: transport as unknown as Parameters<typeof connectHttp2>[0]["transport"],
            events: nodeEventProvider,
            crypto: nodeCryptoProvider,
            // Wired exactly as @browsercore/fetch's establishConnection h2
            // branch wires it from the profile:
            initialSettings: profileSettingsMap(profile),
            settingsOrder: profile.http2.settingsOrder,
            settingsGrease: profile.http2.grease,
            connectionWindowUpdate: profile.http2.connectionWindowUpdate,
            pseudoHeaderOrder: profile.http2.pseudoHeaderOrder,
            initialPriority: { exclusive: true, streamDependency: 0, weight: 0xff },
        });
        // Server-side half of the settings exchange: empty SETTINGS + ACK.
        transport.feed(
            Uint8Array.from([
                0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // SETTINGS (empty)
                0x00, 0x00, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, // SETTINGS ACK
            ]),
        );
        // Fire a request shaped like @browsercore/fetch's dispatch: profile
        // default headers, accept-encoding from the profile, priority from
        // http2DefaultHeaders, and NO host (authority lives in :authority).
        void conn
            .request({
                method: "GET",
                scheme: "https",
                authority: SERVER_NAME,
                path: "/api/all",
                headers: new Map<string, string>([
                    ["user-agent", profile.http1.defaultHeaders["user-agent"] ?? ""],
                    ["accept", profile.http1.defaultHeaders["accept"] ?? ""],
                    ["accept-encoding", profile.http1.acceptEncoding],
                    ["priority", profile.http2.http2DefaultHeaders?.priority ?? ""],
                ]),
                body: undefined,
            })
            .catch(() => undefined);
        // preface + SETTINGS + WINDOW_UPDATE (+ maybe ACK) + HEADERS.
        await vi.waitFor(() => {
            expect(transport.writes.length).toBeGreaterThanOrEqual(4);
        });
    });

    afterAll(async () => {
        await conn.close().catch(() => undefined);
    });

    /** All captured writes after the connection preface, parsed as frames. */
    function frames(): CapturedFrame[] {
        return transport.writes.slice(1).map(parseCapturedFrame);
    }

    it("opens with the RFC 7540 §3.5 client connection preface", () => {
        expect(new TextDecoder().decode(transport.writes[0]!)).toBe(CLIENT_PREFACE);
    });

    it("advertises the oracle's SETTINGS in order (Akamai segment 1:65536;2:0;4:6291456;6:262144)", () => {
        const settings = frames().find(
            (frame) => frame.type === FrameType.SETTINGS && (frame.flags & 0x1) === 0,
        );
        expect(settings).toBeDefined();
        expect(settings!.payload.length).toBe(24);
        expect(akamaiSettingsSegment(settings!.payload)).toBe(GOLD_AKAMAI_SETTINGS);
    });

    it("sends the oracle's connection WINDOW_UPDATE (15663105) on stream 0", () => {
        const windowUpdate = frames().find((frame) => frame.type === FrameType.WINDOW_UPDATE);
        expect(windowUpdate).toBeDefined();
        expect(windowUpdate!.streamId).toBe(0);
        const increment =
            (windowUpdate!.payload[0]! << 24) |
            (windowUpdate!.payload[1]! << 16) |
            (windowUpdate!.payload[2]! << 8) |
            windowUpdate!.payload[3]!;
        expect(increment >>> 0).toBe(GOLD_WINDOW_UPDATE_INCREMENT);
    });

    it("sends request HEADERS on stream 1 with flags 0x25 + the 5-byte priority block", () => {
        const headers = frames().find((frame) => frame.type === FrameType.HEADERS);
        expect(headers).toBeDefined();
        expect(headers!.streamId).toBe(1);
        expect(headers!.flags).toBe(0x25);
        expect(headers!.payload.subarray(0, 5)).toEqual(GOLD_PRIORITY_BLOCK);
    });

    it("serializes pseudo-headers in the oracle's order m,a,s,p with NO host field", () => {
        const headers = frames().find((frame) => frame.type === FrameType.HEADERS);
        expect(headers).toBeDefined();

        const decoder = new HpackDecoder();
        const block: readonly HeaderField[] = decoder.decode(headers!.payload.subarray(5));
        const names = block.map((field) => field.name);

        expect(names.slice(0, 4)).toEqual([...GOLD_PSEUDO_ORDER]);
        // RFC 9113 §8.3.6: authority is carried by :authority — a `host`
        // field on an h2 request is a live-confirmed WAF trigger.
        expect(names).not.toContain("host");
        expect(names).not.toContain(":host");

        // The chrome-140 profile's h2 default header reaches the wire.
        const priority = block.find((field) => field.name === "priority");
        expect(priority?.value).toBe("u=0, i");

        // And the profile-driven accept-encoding default.
        const acceptEncoding = block.find((field) => field.name === "accept-encoding");
        expect(acceptEncoding?.value).toBe(profile.http1.acceptEncoding);
    });
});
