"use strict";

// A single stream produces both live PCM and the local WAV. Output stays silent.
class DropPCMRecorderProcessor extends AudioWorkletProcessor {
  constructor({processorOptions = {}} = {}) {
    super();
    this.targetRate = processorOptions.sampleRate || 16000;
    this.maxFrames = processorOptions.maxFrames || this.targetRate * 300;
    this.step = sampleRate / this.targetRate;
    this.chunkFrames = Math.round(this.targetRate / 10);
    this.chunk = new ArrayBuffer(this.chunkFrames * 2);
    this.view = new DataView(this.chunk);
    this.chunkLength = 0;
    this.frames = 0;
    this.inputFrames = 0;
    this.nextPosition = 0;
    this.previousSample = 0;
    this.state = "inactive";
    this.ended = false;
    this.port.onmessage = ({data}) => {
      if (this.ended) return;
      if (data.type === "start" && this.state === "inactive") this.state = "recording";
      if (data.type === "pause" && this.state === "recording") {
        this.state = "paused";
        this.flush();
      }
      if (data.type === "resume" && this.state === "paused") this.state = "recording";
      if (data.type === "stop") this.stop();
    };
  }

  flush() {
    if (!this.chunkLength) return;
    const buffer = this.chunkLength === this.chunkFrames ? this.chunk : this.chunk.slice(0, this.chunkLength * 2);
    this.port.postMessage({type: "pcm", buffer, frames: this.frames}, [buffer]);
    this.chunk = new ArrayBuffer(this.chunkFrames * 2);
    this.view = new DataView(this.chunk);
    this.chunkLength = 0;
  }

  stop() {
    if (this.ended) return;
    this.state = "inactive";
    this.ended = true;
    this.flush();
    this.port.postMessage({type: "stopped", frames: this.frames});
  }

  process(inputs) {
    if (this.ended) return false;
    const channels = inputs[0];
    if (this.state !== "recording" || !channels?.length) return true;
    for (let i = 0; i < channels[0].length; i += 1) {
      let current = 0;
      for (let c = 0; c < channels.length; c += 1) current += channels[c][i];
      current /= channels.length;
      // Absolute sample positions preserve the fractional resampling phase across
      // render blocks and pauses, including 44.1 kHz's non-integral conversion.
      while (this.nextPosition <= this.inputFrames) {
        const fraction = this.inputFrames ? this.nextPosition - (this.inputFrames - 1) : 1;
        const value = Math.max(-1, Math.min(1, this.previousSample + (current - this.previousSample) * fraction));
        this.view.setInt16(this.chunkLength * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
        this.chunkLength += 1;
        this.frames += 1;
        this.nextPosition += this.step;
        if (this.chunkLength === this.chunkFrames) this.flush();
        if (this.frames >= this.maxFrames) {
          this.stop();
          return false;
        }
      }
      this.previousSample = current;
      this.inputFrames += 1;
    }
    return true;
  }
}

registerProcessor("drop-pcm-recorder", DropPCMRecorderProcessor);
