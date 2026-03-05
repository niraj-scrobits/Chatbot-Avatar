"use client";

/**
 * AvatarStream.tsx
 * ----------------
 * Renders the Simli.ai WebRTC avatar video stream in the browser.
 * Handles SDK initialization and WebRTC peer connection.
 *
 * Props:
 *   onReady(simliClient) — called when the Simli session is established
 *   onError(err)         — called on any fatal error
 */

import React, { useEffect, useRef, useCallback } from "react";
import { SimliClient, fetchSimliConfig, prepareSimliSession } from "../lib/simli";

interface AvatarStreamProps {
    onReady: (simliClient: SimliClient) => void;
    onError: (err: Error) => void;
    className?: string;
}

export default function AvatarStream({
    onReady,
    onError,
    className = "",
}: AvatarStreamProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const simliClientRef = useRef<SimliClient | null>(null);
    const startedRef = useRef(false);
    const onReadyRef = useRef(onReady);
    const onErrorRef = useRef(onError);

    // Update refs to latest callbacks
    useEffect(() => {
        onReadyRef.current = onReady;
        onErrorRef.current = onError;
    }, [onReady, onError]);

    const initSimli = useCallback(async () => {
        if (startedRef.current) return;
        startedRef.current = true;

        try {
            const config = await fetchSimliConfig();
            const { sessionToken, iceServers } = await prepareSimliSession(config);

            if (!videoRef.current || !audioRef.current) {
                throw new Error("Video or Audio element not ready");
            }

            const client = new SimliClient(
                sessionToken,
                videoRef.current,
                audioRef.current,
                iceServers
            );

            simliClientRef.current = client;

            await client.start();
            console.log("[Simli] WebRTC connection established");

            onReadyRef.current(client);
        } catch (err) {
            console.error("[AvatarStream] Failed to initialise Simli:", err);
            startedRef.current = false;
            onErrorRef.current(err instanceof Error ? err : new Error(String(err)));
        }
    }, []); // Removed dependencies to prevent re-creation

    useEffect(() => {
        initSimli();
        return () => {
            if (simliClientRef.current) {
                simliClientRef.current.stop().catch(console.error);
                simliClientRef.current = null;
                startedRef.current = false;
            }
        };
    }, [initSimli]);

    return (
        <div className={`avatar-stream-container ${className}`} style={{ position: "relative", width: "100%", height: "100%" }}>
            <video
                ref={videoRef}
                autoPlay
                playsInline
                className="avatar-video"
                style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    borderRadius: "50%",
                    background: "#0a0a0a",
                }}
            />
            {/* Audio element for Simli's processed audio */}
            <audio ref={audioRef} autoPlay />
        </div>
    );
}
