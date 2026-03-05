# 🤖 Amrut — Gemini Live + 3D Avatar (Simli)

> **Goal:** A minimal, high-performance real-time voice pipeline integrating Gemini Live API with a 3D avatar (Simli) for lip-synced visual responses.

---

## Architecture

```mermaid
graph TD
    User((User)) <--> Browser[Next.js 14 Frontend]
    Browser <--> |WebSocket (PCM 16kHz)| Backend[FastAPI Backend]
    Backend <--> |Gemini Realtime SDK| Gemini[Gemini 2.5 Flash]
    Backend --> |Resample 24k -> 16k| Browser
    Browser --> |PCM 16k| Simli[Simli SDK / WebRTC]
    Simli --> |Video/Audio| Browser
```

1. **User Speaks**: Browser captures raw mic audio (PCM 16kHz).
2. **Audio Streaming**: Audio is sent via WebSocket to the FastAPI backend.
3. **Gemini Live API**: Backend forwards audio to Gemini; Gemini responds with real-time streaming audio (24kHz).
4. **Resampling**: Backend resamples Gemini's 24kHz audio to 16kHz (Simli requirement).
5. **Lip-Sync**: Browser receives resampled audio and pipes it directly into the Simli SDK.
6. **Visualization**: Simli renders the 3D avatar with perfect lip-syncing over WebRTC.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Python 3.10+ | Backend runtime |
| Node.js 18+ | Frontend runtime |
| [Gemini API Key](https://aistudio.google.com/) | For AI responses |
| [Simli API Key & FaceID](https://www.simli.ai/) | For 3D Avatar rendering |

---

## Quick Start

### 1. Configure Backend
```bash
cd backend
cp .env.example .env
# Add GEMINI_API_KEY, SIMLI_API_KEY, and SIMLI_FACE_ID
```

### 2. Start Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

### 3. Start Frontend
```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:3000** and click **🎙️ Start Conversation**.

---

## File Structure

```
poc-avatar/
├── backend/
│   ├── main.py           # FastAPI server & WebSocket management
│   ├── gemini_live.py    # Gemini Live session & Audio Resampling
│   └── requirements.txt
│
└── frontend/
    ├── app/
    │   ├── page.tsx      # Main UI & WebSocket wiring
    │   └── layout.tsx
    ├── components/
    │   └── AvatarStream.tsx # Simli WebRTC rendering component
    ├── lib/
    │   └── simli.ts      # Simli SDK helper & config fetcher
    └── package.json
```
