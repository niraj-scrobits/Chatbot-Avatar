"""
main.py — FastAPI backend for the WebRTC Avatar POC (Gemini Live API)
---------------------------------------------------------------------
Primary endpoint:
  /ws/voice-live
    Real-time audio-to-audio via Gemini Live API.
    Browser sends raw PCM audio, receives PCM audio back.

WebSocket Protocol for /ws/voice-live:
  BROWSER → BACKEND:
    Binary frames: raw PCM 16-bit, 16 kHz, mono audio chunks
    Text frames (JSON): { "type": "ping" }

  BACKEND → BROWSER:
    Binary frames: raw PCM 16-bit, 16 kHz, mono audio (resampled from Gemini)
    Text frames (JSON):
      { "type": "session_init", "session_id": "..." }
      { "type": "turn_done" }
      { "type": "error", "message": "..." }
"""

import asyncio
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState

from gemini_live import run_live_session

# ── Setup ────────────────────────────────────────────────────────────────────

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("avatar-simli")

SIMLI_API_KEY = os.getenv("SIMLI_API_KEY", "")
SIMLI_FACE_ID = os.getenv("SIMLI_FACE_ID", "")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split('#')[0].strip().split(",")

# ── App lifecycle ────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(f"🚀 Avatar POC backend starting (Gemini Live API + Simli)")
    log.info(f"Config: SIMLI_FACE_ID={SIMLI_FACE_ID}")
    yield
    log.info("🛑 Shutting down")

app = FastAPI(title="Avatar POC", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Health check ─────────────────────────────────────────────────────────────

@app.get("/")
async def health():
    return {"status": "ok", "service": "avatar-simli-backend"}

# ── REST: Provide Simli Config ───────────────────────────────────────────────

@app.post("/api/simli/session")
async def get_simli_config():
    if not SIMLI_API_KEY:
        log.error("SIMLI_API_KEY is missing")
        return {"error": "SIMLI_API_KEY not configured"}, 500
    
    return {
        "apiKey": SIMLI_API_KEY,
        "faceId": SIMLI_FACE_ID,
    }

# ── WebSocket: Gemini Live API (audio-to-audio) ─────────────────────────────

@app.websocket("/ws/voice-live")
async def voice_live_ws(ws: WebSocket):
    """
    Real-time audio pipeline using Gemini Live API.
    Browser streams mic audio (PCM 16k) via binary WebSocket frames.
    Backend streams Gemini response audio (PCM 24k resampled to 16k) back.
    """
    await ws.accept()
    session_id = str(uuid.uuid4())
    log.info(f"[{session_id}] Live WebSocket connected")

    await ws.send_json({"type": "session_init", "session_id": session_id})

    # Queue for browser audio → Gemini (bounded to prevent stale audio buildup)
    audio_input_queue: asyncio.Queue = asyncio.Queue(maxsize=20)

    # Callbacks for Gemini → browser
    async def ws_send_bytes(data: bytes):
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_bytes(data)

    async def ws_send_json(data: dict):
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_json(data)

    # Run Gemini Live session in background
    live_task = asyncio.create_task(
        run_live_session(ws_send_bytes, ws_send_json, audio_input_queue, session_id)
    )

    try:
        # Main loop: receive browser messages → route to queue
        while True:
            message = await ws.receive()

            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                # Binary frame: raw PCM audio from browser mic
                # Drop oldest if queue is full to keep audio fresh
                if audio_input_queue.full():
                    try:
                        audio_input_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                await audio_input_queue.put(message["bytes"])

            elif "text" in message and message["text"]:
                try:
                    msg = json.loads(message["text"])
                    if msg.get("type") == "ping":
                        await ws.send_json({"type": "pong"})
                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        log.info(f"[{session_id}] WebSocket disconnected")
    except Exception as e:
        log.error(f"[{session_id}] WS error: {e}")
    finally:
        # Signal the send loop to stop
        await audio_input_queue.put(None)
        live_task.cancel()
        try:
            await live_task
        except (asyncio.CancelledError, Exception):
            pass
        log.info(f"[{session_id}] Live session cleaned up")
