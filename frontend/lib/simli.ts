/**
 * lib/simli.ts
 * Thin wrapper around simli-client SDK.
 */

import { SimliClient, generateSimliSessionToken, generateIceServers } from "simli-client";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8001";

export interface SimliConfig {
    apiKey: string;
    faceId: string;
}

/**
 * Fetches Simli API Key and Face ID from the backend.
 */
export async function fetchSimliConfig(): Promise<SimliConfig> {
    const res = await fetch(`${BACKEND_URL}/api/simli/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(`Simli config fetch failed: ${err.error || res.statusText}`);
    }
    return await res.json();
}

/**
 * Helper to prepare Simli session and ICE servers.
 */
export async function prepareSimliSession(config: SimliConfig) {
    const sessionRequest = {
        apiKey: config.apiKey,
        config: {
            faceId: config.faceId,
            handleSilence: true,
            maxSessionLength: 3600,
            maxIdleTime: 300,
        }
    };

    const [tokenData, iceServers] = await Promise.all([
        generateSimliSessionToken(sessionRequest),
        generateIceServers(config.apiKey)
    ]);

    return {
        sessionToken: tokenData.session_token,
        iceServers
    };
}

/**
 * Helper to convert base64 audio data to Uint8Array for Simli.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

export { SimliClient };
