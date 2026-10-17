// Plays one guest audio port from its PCM ring in the runtime's shared memory
// (threaded build; AudioRing in browser/src/hle_audio_null.cpp). The guest
// thread writes int16 frames and waits for room; this processor consumes
// them at the context's rate and wakes it, so the audio clock paces the game.
// Header words: write, read, capacity, channels, freq, generation, closed.
const WRITE = 0, READ = 1, CAPACITY = 2, CHANNELS = 3, FREQ = 4, GENERATION = 5, CLOSED = 6;

class Vita3kAudioRing extends AudioWorkletProcessor {
  constructor({ processorOptions: { buffer, offset, generation } }) {
    super();
    this.header = new Int32Array(buffer, offset, 8);
    this.capacity = this.header[CAPACITY];
    this.channels = this.header[CHANNELS];
    this.samples = new Int16Array(buffer, offset + 32, this.capacity * this.channels);
    this.generation = generation;
    // Source frames per output frame (port rate over the context rate).
    this.step = this.header[FREQ] / sampleRate;
    this.position = 0; // fractional source frame within the ring
    this.primed = false;
    // Reported to the page every few seconds: frames played, underruns, peak.
    this.played = 0; this.underruns = 0; this.peak = 0; this.reportAt = currentTime + 2;
    this.port.onmessage = ({ data }) => { if (data === 'stop') this.stopped = true; };
  }

  process(_inputs, outputs) {
    const header = this.header;
    if (this.stopped || Atomics.load(header, CLOSED) || Atomics.load(header, GENERATION) !== this.generation)
      return false;
    const output = outputs[0];
    const left = output[0], right = output[1] ?? output[0];
    const frames = left.length;
    const read = Atomics.load(header, READ) >>> 0;
    const available = ((Atomics.load(header, WRITE) >>> 0) - read) >>> 0;
    const needed = Math.ceil(frames * this.step + this.position) + 1;
    // Start, and restart after an underrun, with a few blocks in hand.
    if (!this.primed) {
      if (available < Math.max(this.capacity >>> 1, needed)) return true;
      this.primed = true;
    }
    if (available < needed) {
      this.primed = false;
      ++this.underruns;
      return true;
    }
    const mask = this.capacity - 1, samples = this.samples, channels = this.channels;
    let position = this.position;
    for (let i = 0; i < frames; ++i) {
      const whole = position | 0, fraction = position - whole;
      const a = ((read + whole) & mask) * channels, b = ((read + whole + 1) & mask) * channels;
      const l = samples[a] + (samples[b] - samples[a]) * fraction;
      const r = channels > 1 ? samples[a + 1] + (samples[b + 1] - samples[a + 1]) * fraction : l;
      const level = l < 0 ? -l : l;
      if (level > this.peak) this.peak = level;
      left[i] = l / 32768;
      if (right !== left) right[i] = r / 32768;
      position += this.step;
    }
    const consumed = position | 0;
    this.position = position - consumed;
    Atomics.store(header, READ, (read + consumed) | 0);
    Atomics.notify(header, READ);
    this.played += consumed;
    if (currentTime >= this.reportAt) {
      this.reportAt = currentTime + 5;
      this.port.postMessage({ played: this.played, underruns: this.underruns, peak: this.peak | 0 });
    }
    return true;
  }
}

registerProcessor('vita3k-audio-ring', Vita3kAudioRing);
