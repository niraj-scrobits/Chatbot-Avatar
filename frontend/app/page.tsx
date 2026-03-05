"use client";

/**
 * app/page.tsx — Main POC page (Gemini Live API + Simli 3D Avatar)
 * ──────────────────────────────────────────────────────────────
 * Full pipeline:
 *   1. User clicks "Start" → WebSocket connects to /ws/voice-live
 *   2. Browser streams raw mic PCM audio via binary WebSocket frames
 *   3. Backend resamples to 16kHz and forwards to Gemini Live API
 *   4. Gemini response audio streamed back as binary frames
 *   5. Browser sends binary frames to Simli SDK for 3D lip-sync & playback
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import AvatarStream from "../components/AvatarStream";
import type { SimliClient } from "../lib/simli";

const WS_LIVE_URL =
    process.env.NEXT_PUBLIC_BACKEND_WS_URL
    ?? "ws://localhost:8001/ws/voice-live";

// ── Types ──────────────────────────────────────────────────────────────────

type AppState =
    | "idle"
    | "connecting"
    | "ready"           // Listening for user speech
    | "ai_speaking"     // Gemini is responding
    | "error";

// ── Main Component ─────────────────────────────────────────────────────────

export default function AvatarPOCPage() {
    const [appState, setAppState] = useState<AppState>("idle");
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [logs, setLogs] = useState<{ msg: string; time: string; type: 'info' | 'error' | 'ws' }[]>([]);

    const wsRef = useRef<WebSocket | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const audioWorkletRef = useRef<AudioWorkletNode | null>(null);
    const micCtxRef = useRef<AudioContext | null>(null);

    // Track speaking state via ref to avoid React re-renders per audio frame
    const isSpeakingRef = useRef(false);

    // ── Simli Avatar Ref ───────────────────────────────────────────────
    const simliClientRef = useRef<SimliClient | null>(null);

    const addLog = useCallback((msg: string, type: 'info' | 'error' | 'ws' = 'info') => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [{ msg, time, type }, ...prev].slice(0, 15));
    }, []);

    const handleAvatarReady = useCallback((client: SimliClient) => {
        simliClientRef.current = client;
        addLog("Simli 3D Avatar Ready ✅", "info");
    }, [addLog]);

    const handleAvatarError = useCallback((err: Error) => {
        addLog(`Simli Error: ${err.message}`, "error");
        setAppState("error");
    }, [addLog]);

    // ── Start session ─────────────────────────────────────────────────────

    const startSession = useCallback(async () => {
        if (!simliClientRef.current) {
            addLog("Waiting for Simli to be ready...", "info");
            return;
        }

        setAppState("connecting");
        addLog("Connecting...", "info");

        try {
            // Initiate mic access and WebSocket connection concurrently
            const micPromise = navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                },
            });

            const ws = new WebSocket(WS_LIVE_URL);
            wsRef.current = ws;
            ws.binaryType = "arraybuffer";

            addLog("Initiating mic and connection...", "info");

            const [stream] = await Promise.all([
                micPromise,
                new Promise<void>((resolve, reject) => {
                    ws.onopen = () => {
                        addLog("WebSocket connected", "ws");
                        resolve();
                    };
                    ws.onerror = (err) => {
                        addLog("WebSocket failed to connect", "error");
                        reject(err);
                    };
                })
            ]);

            mediaStreamRef.current = stream;
            addLog("Mic access granted & Connection ready", "info");

            ws.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    // Binary frame: Gemini audio response (now 16kHz from backend)
                    const pcmData = new Uint8Array(event.data);

                    // Send to Simli for lip-sync and playback
                    if (simliClientRef.current) {
                        simliClientRef.current.sendAudioData(pcmData);
                    }

                    // Only update React state once per turn (not per frame)
                    if (!isSpeakingRef.current) {
                        isSpeakingRef.current = true;
                        setAppState("ai_speaking");
                        addLog("🔊 Receiving audio...", "info");
                    }
                } else {
                    // Text frame: control messages
                    try {
                        const msg = JSON.parse(event.data);
                        switch (msg.type) {
                            case "session_init":
                                addLog(`Session: ${msg.session_id.slice(0, 8)}...`, "ws");
                                break;
                            case "connected":
                                setAppState("ready");
                                addLog("Gemini Live connected! Speak now.", "ws");
                                // Start streaming mic audio
                                if (mediaStreamRef.current) {
                                    startMicStream(mediaStreamRef.current, ws);
                                }
                                break;
                            case "turn_done":
                                isSpeakingRef.current = false;
                                setAppState("ready");
                                addLog("✓ Turn complete", "info");
                                break;
                            case "interrupted":
                                isSpeakingRef.current = false;
                                setAppState("ready");
                                // Clear Simli's queued audio so avatar stops instantly
                                if (simliClientRef.current) {
                                    simliClientRef.current.ClearBuffer();
                                }
                                addLog("⚡ Interrupted — listening", "info");
                                break;
                            case "error":
                                addLog(`Error: ${msg.message}`, "error");
                                break;
                        }
                    } catch (e) {
                        console.error("[WS] Parse error:", e);
                    }
                }
            };

            ws.onerror = () => {
                addLog("WebSocket error", "error");
                setAppState("error");
            };

            ws.onclose = () => {
                addLog("WebSocket disconnected", "ws");
                stopMicStream();
            };

        } catch (err: any) {
            console.error("Start error:", err);
            setErrorMsg(err.message || "Failed to start");
            setAppState("error");
            addLog(`Error: ${err.message}`, "error");
        }
    }, [addLog]);

    // ── Mic streaming (PCM 16k → WebSocket binary via AudioWorklet) ─────────

    const startMicStream = useCallback(async (stream: MediaStream, ws: WebSocket) => {
        try {
            const ctx = new AudioContext({ sampleRate: 16000 });
            micCtxRef.current = ctx;

            // Load the AudioWorklet processor (runs on dedicated audio thread)
            await ctx.audioWorklet.addModule("/pcm-processor.js");

            const source = ctx.createMediaStreamSource(stream);
            const workletNode = new AudioWorkletNode(ctx, "pcm-processor");
            audioWorkletRef.current = workletNode;

            // Receive PCM data from the audio thread
            workletNode.port.onmessage = (e: MessageEvent) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(e.data);
                }
            };

            source.connect(workletNode);
            // AudioWorklet doesn't need to connect to destination for capture-only
            workletNode.connect(ctx.destination);

            addLog("🎙️ Streaming mic audio (AudioWorklet)", "info");
        } catch (err) {
            console.error("[AudioWorklet] Failed, falling back to ScriptProcessor:", err);
            // Fallback to ScriptProcessorNode for older browsers
            const ctx = micCtxRef.current || new AudioContext({ sampleRate: 16000 });
            micCtxRef.current = ctx;
            const source = ctx.createMediaStreamSource(stream);
            const processor = ctx.createScriptProcessor(2048, 1, 1);
            processor.onaudioprocess = (e) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                const float32 = e.inputBuffer.getChannelData(0);
                const pcm = new Int16Array(float32.length);
                for (let i = 0; i < float32.length; i++) {
                    const s = Math.max(-1, Math.min(1, float32[i]));
                    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                ws.send(pcm.buffer);
            };
            source.connect(processor);
            processor.connect(ctx.destination);
            addLog("🎙️ Streaming mic audio (fallback)", "info");
        }
    }, [addLog]);

    const stopMicStream = useCallback(() => {
        if (audioWorkletRef.current) {
            audioWorkletRef.current.port.close();
            audioWorkletRef.current.disconnect();
            audioWorkletRef.current = null;
        }
        micCtxRef.current?.close();
        micCtxRef.current = null;
        mediaStreamRef.current?.getTracks().forEach(t => t.stop());
        mediaStreamRef.current = null;
        isSpeakingRef.current = false;
    }, []);

    // ── Stop session ──────────────────────────────────────────────────────

    const stopSession = useCallback(() => {
        stopMicStream();
        wsRef.current?.close();
        wsRef.current = null;
        setAppState("idle");
        setLogs([]);
        addLog("Session ended", "info");
    }, [stopMicStream, addLog]);

    // ── WebSocket Keepalive ───────────────────────────────────────────────

    useEffect(() => {
        const iv = setInterval(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: "ping" }));
            }
        }, 20_000);
        return () => clearInterval(iv);
    }, []);

    // ── Cleanup ───────────────────────────────────────────────────────────

    useEffect(() => {
        return () => {
            stopMicStream();
            wsRef.current?.close();
        };
    }, [stopMicStream]);

    // ── Render ─────────────────────────────────────────────────────────────

    const isActive = appState !== "idle" && appState !== "error";

    return (
        <main style={styles.main}>
            <header style={styles.header}>
                <div style={styles.logo}>🤖 Gemini Live + 3D Avatar</div>
                <div style={styles.headerRight}>
                    <span
                        style={{
                            ...styles.statusDot,
                            background:
                                appState === "ready" ? "#22c55e"
                                    : appState === "ai_speaking" ? "#3b82f6"
                                        : appState === "connecting" ? "#f59e0b"
                                            : appState === "error" ? "#ef4444"
                                                : "#555",
                        }}
                    />
                    <span style={styles.statusText}>
                        {appState === "idle" && "Offline"}
                        {appState === "connecting" && "Connecting…"}
                        {appState === "ready" && "🎙️ Listening"}
                        {appState === "ai_speaking" && "🔊 Speaking"}
                        {appState === "error" && "Error"}
                    </span>
                </div>
            </header>

            <div style={styles.center}>
                <div style={styles.avatarContainer}>
                    <AvatarStream
                        onReady={handleAvatarReady}
                        onError={handleAvatarError}
                    />
                </div>

                {appState === "idle" && (
                    <div style={styles.overlay}>
                        <h2 style={styles.startTitle}>3D Avatar</h2>
                        <p style={styles.startDesc}>
                            Speak naturally to the avatar. Powered by Gemini Live API.
                        </p>
                        <button style={styles.startBtn} onClick={startSession}>
                            🎙️ Start Conversation
                        </button>
                    </div>
                )}

                {appState === "error" && (
                    <div style={styles.overlay}>
                        <p style={{ color: "#ef4444", fontWeight: 600 }}>Connection Error</p>
                        <p style={{ color: "#888", fontSize: 13 }}>{errorMsg}</p>
                        <button style={styles.startBtn} onClick={() => { setAppState("idle"); setErrorMsg(null); }}>
                            Retry
                        </button>
                    </div>
                )}

                {(appState === "ready" || appState === "ai_speaking") && (
                    <div style={styles.controlsOverlay}>
                        <div style={{
                            fontSize: 18,
                            fontWeight: 600,
                            color: appState === "ai_speaking" ? "#3b82f6" : "#22c55e",
                            marginBottom: 8,
                        }}>
                            {appState === "ai_speaking" ? "🔊 Speaking…" : "🎙️ Listening…"}
                        </div>
                        <button
                            onClick={stopSession}
                            style={{
                                ...styles.startBtn,
                                background: "linear-gradient(135deg, #ef4444, #dc2626)",
                            }}
                        >
                            ⏹ End Conversation
                        </button>
                    </div>
                )}

                {/* Status Log */}
                {isActive && (
                    <div style={styles.logPanel}>
                        <div style={{ opacity: 0.4, fontSize: 9, textTransform: "uppercase", marginBottom: 4 }}>Status Log</div>
                        {logs.map((log, i) => (
                            <div key={i} style={{
                                color: log.type === 'error' ? '#ef4444' : log.type === 'ws' ? '#3b82f6' : '#ccc',
                                lineHeight: 1.5,
                            }}>
                                <span style={{ color: "#555" }}>{log.time}</span> {log.msg}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <style jsx global>{`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { background: #000; color: #e5e5e5; font-family: 'Inter', sans-serif; overflow: hidden; }
            `}</style>
        </main>
    );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
    main: {
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#000",
    },
    header: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "14px 24px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(0,0,0,0.8)",
        zIndex: 10,
    },
    logo: { fontSize: 16, fontWeight: 700, color: "#fff" },
    headerRight: { display: "flex", alignItems: "center", gap: 10 },
    statusDot: { width: 8, height: 8, borderRadius: "50%" },
    statusText: { fontSize: 13, color: "#aaa" },
    center: {
        flex: 1,
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    },
    avatarContainer: {
        width: 280,
        height: 280,
        borderRadius: "50%",
        overflow: "hidden",
        border: "3px solid rgba(255,255,255,0.15)",
        background: "#050505",
        boxShadow: "0 0 40px rgba(99,102,241,0.15), 0 0 80px rgba(99,102,241,0.05)",
        flexShrink: 0,
    },
    overlay: {
        position: "absolute",
        textAlign: "center",
        zIndex: 20,
        background: "rgba(0,0,0,0.7)",
        padding: "32px",
        borderRadius: "24px",
        backdropFilter: "blur(10px)",
    },
    controlsOverlay: {
        position: "absolute",
        bottom: 80,
        zIndex: 20,
        textAlign: "center",
        background: "rgba(0,0,0,0.6)",
        padding: "12px 20px",
        borderRadius: "16px",
        backdropFilter: "blur(8px)",
    },
    startTitle: {
        fontSize: 32,
        fontWeight: 700,
        marginBottom: 12,
        color: "#fff",
    },
    startDesc: { color: "#aaa", fontSize: 16, marginBottom: 32 },
    startBtn: {
        background: "linear-gradient(135deg, #3b82f6, #6366f1)",
        color: "#fff",
        border: "none",
        borderRadius: "12px",
        padding: "14px 32px",
        fontSize: 16,
        fontWeight: 600,
        cursor: "pointer",
        boxShadow: "0 8px 32px rgba(99,102,241,0.3)",
    },
    logPanel: {
        position: "absolute",
        bottom: 20,
        left: 20,
        width: 320,
        maxHeight: 200,
        overflowY: "auto",
        fontSize: 11,
        fontFamily: "monospace",
        color: "#eee",
        background: "rgba(0,0,0,0.7)",
        padding: "12px",
        borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.1)",
        zIndex: 30,
    },
};
