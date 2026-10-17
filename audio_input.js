// M7 block audio and queued input bridge. Browser adapters consume these APIs.
export function createAudioInputBridge() {
  const input = [];
  let audioContext = null;
  return Object.freeze({
    enqueue(event) { input.push(event); },
    drainInput() { return input.splice(0, input.length); },
    async startAudio() {
      if (typeof AudioContext === 'undefined') return null;
      audioContext ||= new AudioContext();
      await audioContext.resume();
      return audioContext.sampleRate;
    },
    pushAudioBlock(samples) {
      if (!(samples instanceof Float32Array)) throw new TypeError('audio block must be Float32Array');
      if (samples.length === 0) throw new RangeError('audio block must not be empty');
    },
  });
}
