class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions.targetSampleRate;
    this.chunkSamples = Math.round((this.targetSampleRate * options.processorOptions.chunkDurationMs) / 1000);
    this.ratio = sampleRate / this.targetSampleRate;
    this.position = 0;
    this.previousSample = 0;
    this.pending = [];
    this.debugCapture = options.processorOptions.debugCapture === true;
    this.reportedFirstInput = false;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    if (this.debugCapture && !this.reportedFirstInput) {
      this.reportedFirstInput = true;
      this.port.postMessage({ type: "capture.first-input", inputSampleRate: sampleRate, inputFrames: input.length });
    }

    const samples = new Float32Array(input.length + 1);
    samples[0] = this.previousSample;
    samples.set(input, 1);

    while (this.position < input.length - 1) {
      const index = Math.floor(this.position) + 1;
      const fraction = this.position - Math.floor(this.position);
      this.pending.push(samples[index] + (samples[index + 1] - samples[index]) * fraction);
      this.position += this.ratio;
      if (this.pending.length >= this.chunkSamples) this.flush();
    }

    this.position -= input.length;
    this.previousSample = input[input.length - 1];
    return true;
  }

  flush() {
    const pcm = new Int16Array(this.chunkSamples);
    for (let index = 0; index < this.chunkSamples; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.pending[index]));
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    this.pending = this.pending.slice(this.chunkSamples);
    this.port.postMessage({ type: "pcm", buffer: pcm.buffer }, [pcm.buffer]);
  }
}

registerProcessor("pcm-processor", PcmProcessor);
