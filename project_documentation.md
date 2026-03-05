#End-to-End Project Documentation

## 1. Project Overview
**Amrut** is a real-time AI chatbot that integrates a 3D Avatar for a lifecycle-like human interaction. It leverages the **Gemini Live API** for low-latency voice-to-voice communication and **Simli.ai** for high-fidelity 3D avatar rendering and lip-syncing.

The system is designed for minimal latency, ensuring a natural conversation flow where the user can speak and receive synchronized visual and audio feedback from the avatar in near real-time.

---

## 2. Technical Architecture

The project follows a decoupled Frontend-Backend architecture designed for streaming data.

### 2.1 Communication Flow
```mermaid
graph TD
    User((User)) <--> |Audio Input/Output| Browser[Next.js 14 Frontend]
    Browser <--> |WebSocket (PCM 16kHz)| Backend[FastAPI Backend]
    Backend <--> |gRPC / WebSockets| Gemini[Gemini 2.5 Flash]
    Backend --> |Resample 24k -> 16k| Browser
    Browser --> |PCM 16k| Simli[Simli SDK / WebRTC]
    Simli --> |Video/Audio Stream| Browser
```

### 2.2 Sequence of Operations
1. **User Interaction**: User clicks "Start Conversation" and begins speaking.
2. **Audio Capture**: The frontend captures raw microphone audio as PCM 16-bit, 16kHz mono.
3. **Backend Proxy**: The audio moves via WebSocket to the FastAPI backend, which forwards it immediately to Gemini Live API.
4. **AI Generation**: Gemini processes the audio and begins streaming native 24kHz audio responses back to the backend.
5. **Resampling Logic**: Since the Simli Avatar SDK requires exactly 16kHz audio for the WebRTC data channel, the backend resamples the incoming 24kHz audio to 16kHz using linear interpolation (numpy).
6. **Avatar Sync**: The 16kHz audio is sent to the browser, which pipes it into the Simli SDK. Simli generates the corresponding lip-sync movements (visemes) and renders the 3D avatar video stream over WebRTC.

---

## 3. Technology Stack

### 3.1 Backend
- **Framework**: FastAPI (Python)
- **Real-time API**: Gemini Live (google-genai)
- **Audio Processing**: NumPy (Resampling logic)
- **Environment**: python-dotenv, Uvicorn

### 3.2 Frontend
- **Framework**: Next.js 14 (React)
- **Avatar SDK**: `simli-client`
- **Real-time Streaming**: WebRTC (for avatar video/audio), WebSockets (for control & PCM)
- **Styling**: Vanilla CSS-in-JS (React objects)

---

## 4. Key Implementation Details

### 4.1 Backend Audio Resampling (`gemini_live.py`)
To bridge the gap between Gemini's 24kHz output and Simli's 16kHz input requirement, a linear interpolation method is used.
```python
def resample_24k_to_16k(audio_bytes: bytes) -> bytes:
    data = np.frombuffer(audio_bytes, dtype=np.int16)
    orig_indices = np.arange(len(data))
    new_indices = np.linspace(0, len(data) - 1, int(len(data) * (16000 / 24000)))
    resampled_data = np.interp(new_indices, orig_indices, data).astype(np.int16)
    return resampled_data.tobytes()
```

### 4.2 WebRTC Session Stability (`AvatarStream.tsx`)
Because WebRTC connections are sensitive to re-renders, the `AvatarStream` component uses a combination of `useCallback` and `useRef` to store callback handles. This prevents the Simli connection from being prematurely stopped or restarted when the parent component updates its state.

### 4.3 High-Performance PCM Streaming (`page.tsx`)
The frontend uses `ScriptProcessorNode` (or `AudioWorklet`) to capture audio in 4096-sample chunks, converting them to 16-bit integers before sending them down the wire.
```javascript
processor.onaudioprocess = (e) => {
    const float32 = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    ws.send(pcm.buffer);
};
```

---

## 5. Directory Structure

```text
poc-avatar/
├── backend/
│   ├── main.py           # FastAPI entry point, WebSocket management
│   ├── gemini_live.py    # Live session handler & Resampling logic
│   ├── requirements.txt  # Python dependencies (google-genai, numpy, etc.)
│   └── .env              # API Keys (GEMINI, SIMLI)
│
└── frontend/
    ├── app/
    │   ├── page.tsx      # Application UI and audio capture logic
    │   └── layout.tsx    # Root layout
    ├── components/
    │   └── AvatarStream.tsx # Simli WebRTC rendering component
    ├── lib/
    │   └── simli.ts      # Simli SDK wrappers
    └── .env.local        # Environment variables (Backend URLs)
```

---

## 6. Setup and Execution

### 6.1 Backend Setup
1. `cd backend`
2. Create virtual environment: `python -m venv .venv && source .venv/bin/activate`
3. Install dependencies: `pip install -r requirements.txt`
4. Configure `.env` with `GEMINI_API_KEY`, `SIMLI_API_KEY`, and `SIMLI_FACE_ID`.
5. Start: `uvicorn main:app --port 8001 --reload`

### 6.2 Frontend Setup
1. `cd frontend`
2. Install dependencies: `npm install`
3. Configure `.env.local`: `NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:8001/ws/voice-live`
4. Start: `npm run dev`

---

## 8. Official Documentation & References
- **Gemini Multimodal Live API**: [Official Overview & Guide](https://ai.google.dev/gemini-api/docs/multimodal-live)
- **Google GenAI Python SDK**: [SDK Documentation](https://googleapis.github.io/google-genai-python/)
- **Simli.ai Documentation**: [Avatar SDK Reference](https://docs.simli.ai/)
- **Next.js Documentation**: [Next.js Docs](https://nextjs.org/docs)
