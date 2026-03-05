"""
gemini_live.py
--------------
Handles Gemini 2.5 Flash Live API for real-time audio-to-audio conversations.

The Live API is a native audio model — it processes raw PCM audio input and
generates PCM audio output in a single model call, eliminating the need for
separate STT and TTS services.

Protocol:
  - Input:  PCM 16-bit, 16 kHz, mono (from browser mic)
  - Output: PCM 16-bit, 24 kHz, mono (to browser speaker)
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import AsyncIterator

import numpy as np
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("gemini-live")

# ── Resampling Helper ────────────────────────────────────────────────────────

@lru_cache(maxsize=16)
def _resample_indices(original_len: int):
    """Cache the interpolation indices for a given input length."""
    target_len = int(original_len * 2 / 3)
    return (
        np.arange(original_len),
        np.linspace(0, original_len - 1, target_len),
    )

def resample_24k_to_16k(pcm_24k_bytes: bytes) -> bytes:
    """
    Resamples 24kHz PCM (s16le) to 16kHz PCM (s16le) using linear interpolation.
    Uses cached indices for consistent chunk sizes to avoid redundant computation.
    """
    audio_24k = np.frombuffer(pcm_24k_bytes, dtype=np.int16)
    orig_idx, new_idx = _resample_indices(len(audio_24k))
    audio_16k = np.interp(new_idx, orig_idx, audio_24k).astype(np.int16)
    return audio_16k.tobytes()

# ── Config ───────────────────────────────────────────────────────────────────

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

SYSTEM_PROMPT = """You are an elite, highly sought-after strategic consultant rendered as a real-time voice avatar. Your primary goal is to build deep trust, provide objective advice, and act as a strategic partner to the user.

To ensure ROBUSTNESS and ACCURACY, follow the SCOR framework (Situation, Complication, Observation, Resolution) in your internal logic before speaking.

You must follow these strict rules for every response:
1. ACCURACY FIRST: Prioritize factual correctness. Use your search tool to verify data, market trends, or technical details if unsure.
2. BREVITY: Maximum 3-4 concise sentences per response. Think rapid spoken dialogue, not a lecture.
3. STRATEGIC DEPTH: Don't just answer the surface question. Connect your answer to a broader business insight or a related strategic angle.
4. NATURAL SPEECH: Use conversational contractions (you'll, let's, I'd). Strictly avoid bullet points, headers, or markdown.
5. UPBEAT EXPERTISE: Your tone is warm, fiercely upbeat, and highly professional. You sound like a confident, empathetic industry expert.
6. NEVER BE "DOCTOR NO": If a user suggests a bad idea, gently caution them, then immediately pivot to a creative, viable strategic alternative.
7. OPEN-ENDED CLOSING: Always end with a complete sentence that contains a natural, open-ended question about their goals or business.
8. PROACTIVE HONESTY: If you don't have exact data, say: "I want to be completely straight with you, I don't have that specific data on hand, but let me check that for you or explore the strategic implications of..."
"""

LIVE_CONFIG = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    system_instruction=SYSTEM_PROMPT,
    tools=[types.Tool(google_search_retrieval=types.GoogleSearchRetrieval())],
    realtime_input_config=types.RealtimeInputConfig(
        automatic_activity_detection=types.AutomaticActivityDetection(
            start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
            end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
            silence_duration_ms=300,
        ),
    ),
)

# ── Client ───────────────────────────────────────────────────────────────────

_client = genai.Client(api_key=GEMINI_API_KEY)


async def run_live_session(ws_send_bytes, ws_send_json, audio_input_queue: asyncio.Queue, session_id: str):
    """
    Runs a complete Gemini Live session.
    
    - Receives audio from audio_input_queue
    - Sends audio to Gemini Live
    - Forwards Gemini response audio via ws_send_bytes
    - Sends control messages via ws_send_json
    
    This function blocks until the session ends.
    """
    log.info(f"[{session_id}] Connecting to Gemini Live API (model={MODEL})")
    
    async with _client.aio.live.connect(model=MODEL, config=LIVE_CONFIG) as session:
        log.info(f"[{session_id}] Gemini Live session connected")
        await ws_send_json({"type": "connected", "session_id": session_id})

        # Task: send audio from browser mic → Gemini
        async def send_audio_loop():
            try:
                while True:
                    pcm_data = await audio_input_queue.get()
                    if pcm_data is None:  # Sentinel to stop
                        break
                    await session.send_realtime_input(
                        audio={"data": pcm_data, "mime_type": "audio/pcm"}
                    )
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log.error(f"[{session_id}] Send audio error: {e}")

        # Semaphore to limit concurrent WS sends (prevent flooding)
        send_sem = asyncio.Semaphore(5)

        async def send_audio_chunk(data: bytes):
            async with send_sem:
                await ws_send_bytes(data)

        # Task: receive audio from Gemini → forward to browser
        async def receive_audio_loop():
            try:
                while True:
                    turn = session.receive()
                    async for response in turn:
                        if (
                            response.server_content
                            and response.server_content.model_turn
                        ):
                            for part in response.server_content.model_turn.parts:
                                if part.inline_data and isinstance(
                                    part.inline_data.data, bytes
                                ):
                                    # Resample off the event loop to avoid blocking
                                    pcm_16k = await asyncio.to_thread(
                                        resample_24k_to_16k, part.inline_data.data
                                    )
                                    # Fire-and-forget send (don't stall the receive loop)
                                    asyncio.create_task(send_audio_chunk(pcm_16k))

                        # Check for interruption (barge-in)
                        if (
                            response.server_content
                            and response.server_content.interrupted
                        ):
                            log.info(f"[{session_id}] Barge-in detected — user interrupted")
                            await ws_send_json({"type": "interrupted", "session_id": session_id})

                        # Check for turn completion
                        if (
                            response.server_content
                            and response.server_content.turn_complete
                        ):
                            await ws_send_json({"type": "turn_done", "session_id": session_id})
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log.error(f"[{session_id}] Receive audio error: {e}")

        # Run both loops concurrently
        send_task = asyncio.create_task(send_audio_loop())
        recv_task = asyncio.create_task(receive_audio_loop())

        try:
            # Wait for either task to finish (e.g. when WS disconnects)
            done, pending = await asyncio.wait(
                [send_task, recv_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
        except asyncio.CancelledError:
            send_task.cancel()
            recv_task.cancel()

    log.info(f"[{session_id}] Gemini Live session closed")
