/**
 * pcm-processor.js — AudioWorklet processor for low-latency PCM capture.
 *
 * Runs on a dedicated audio rendering thread (off main thread).
 * Batches 4 frames (512 samples = 32ms at 16kHz) before posting,
 * reducing WebSocket sends from ~125/sec to ~31/sec while keeping
 * latency at a Gemini-recommended 32ms.
 */

class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buffer = new Int16Array(512); // 4 frames × 128 samples
        this._offset = 0;
    }

    process(inputs) {
        const input = inputs[0]?.[0]; // first input, first (mono) channel
        if (!input || input.length === 0) return true;

        // Convert float32 → int16 and accumulate into buffer
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Flush when buffer is full (every ~32ms)
        if (this._offset >= this._buffer.length) {
            const out = this._buffer.slice().buffer;
            this.port.postMessage(out, [out]);
            this._offset = 0;
        }

        return true;
    }
}

registerProcessor("pcm-processor", PCMProcessor);
