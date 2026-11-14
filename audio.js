"use strict";

(() => {
  const sampleRate = 16000;
  const maxDuration = 300;
  const durationTolerance = 0.1;
  const script = document.currentScript;
  const workletUrl = new URL(script?.dataset.workletUrl || "pcm-recorder.js", script?.dataset.workletUrl ? document.baseURI : (script?.src || document.baseURI)).href;
  const workletModules = new WeakMap();

  function wavHeader(frames) {
    const headerSize = 44;
    const dataSize = frames * 2;
    const bytes = new ArrayBuffer(headerSize);
    const view = new DataView(bytes);
    const writeTag = (offset, value) => {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset + i, value.charCodeAt(i));
      }
    };
    writeTag(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeTag(8, "WAVE");
    writeTag(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeTag(36, "data");
    view.setUint32(40, dataSize, true);
    return bytes;
  }

  function encodeWav(samples) {
    const bytes = new ArrayBuffer(samples.length * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return new Blob([wavHeader(samples.length), bytes], {type: "audio/wav"});
  }

  async function prepare(blob) {
    if (!(blob instanceof Blob) || !blob.size) throw new Error("没有录到声音，请重新录音。");
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const OfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AudioContext || !OfflineAudioContext) throw new Error("当前浏览器无法处理录音，可以改用文字记录。");

    let context;
    let decoded;
    try {
      context = new AudioContext();
      decoded = await context.decodeAudioData(await blob.arrayBuffer());
    } catch {
      throw new Error("无法读取这段录音，请重新录音。");
    } finally {
      if (context) await context.close().catch(() => {});
    }

    if (decoded.duration > maxDuration + durationTolerance) {
      throw new Error("录音超过 300 秒，请缩短后重新录音。");
    }
    const frames = Math.min(Math.round(decoded.duration * sampleRate), maxDuration * sampleRate);
    if (!frames) throw new Error("没有录到声音，请重新录音。");

    try {
      const offline = new OfflineAudioContext(1, frames, sampleRate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const normalized = await offline.startRendering();
      return {blob: encodeWav(normalized.getChannelData(0)), extension: "wav"};
    } catch {
      throw new Error("无法转换这段录音，可以重试或改用文字记录。");
    }
  }

  function invalidState() {
    return new DOMException("录音状态已改变，请重新开始录音。", "InvalidStateError");
  }

  // The context and microphone belong to the caller (and may also power a meter).
  // Only nodes created here are disconnected when this recorder finishes.
  class PCMRecorder extends EventTarget {
    constructor(context, stream) {
      super();
      this.mimeType = "audio/wav";
      this.state = "inactive";
      this._frames = 0;
      this._chunks = [];
      this._finished = false;
      this._started = false;
      this._stopping = false;
      try {
        this._source = context.createMediaStreamSource(stream);
        this._node = new AudioWorkletNode(context, "drop-pcm-recorder", {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 1, channelCountMode: "explicit",
          processorOptions: {sampleRate, maxFrames: sampleRate * maxDuration},
        });
        this._mute = context.createGain();
        this._mute.gain.value = 0;
        this._source.connect(this._node);
        this._node.connect(this._mute);
        this._mute.connect(context.destination);
        this._node.port.onmessage = ({data}) => {
          if (this._finished) return;
          if (data.type === "pcm") {
            this._frames = data.frames;
            // Retain a copy so a live-transcription consumer can transfer its buffer.
            this._chunks.push(data.buffer.slice(0));
            this.dispatchEvent(new CustomEvent("pcm", {detail: data.buffer}));
          } else if (data.type === "stopped") {
            this._frames = data.frames;
            this._finish();
          }
        };
        this._node.onprocessorerror = () => {
          const event = new Event("error");
          event.error = new Error("录音处理意外中断，请重试。");
          this.dispatchEvent(event);
          this._finish();
        };
      } catch (error) {
        this._disconnect();
        throw error;
      }
    }

    get duration() { return this._frames / sampleRate; }

    start() {
      if (this.state !== "inactive" || this._started || this._finished) throw invalidState();
      this._started = true;
      this.state = "recording";
      this._node.port.postMessage({type: "start"});
    }

    pause() {
      if (this.state === "inactive") throw invalidState();
      if (this.state === "paused") return;
      this.state = "paused";
      this._node.port.postMessage({type: "pause"});
    }

    resume() {
      if (this.state === "inactive") throw invalidState();
      if (this.state === "recording") return;
      this.state = "recording";
      this._node.port.postMessage({type: "resume"});
    }

    stop() {
      if (!this._started || this._finished || this._stopping) return;
      this._stopping = true;
      this.state = "inactive";
      this._node.port.postMessage({type: "stop"});
    }

    _disconnect() {
      for (const node of [this._source, this._node, this._mute]) {
        try { node?.disconnect(); } catch { /* A failed setup may be only partly connected. */ }
      }
      if (this._node) {
        this._node.port.onmessage = null;
        this._node.onprocessorerror = null;
        this._node.port.close();
      }
    }

    _finish() {
      if (this._finished) return;
      this._finished = true;
      this.state = "inactive";
      this._disconnect();
      const event = new Event("dataavailable");
      event.data = new Blob([wavHeader(this._frames), ...this._chunks], {type: this.mimeType});
      this._chunks = [];
      this.dispatchEvent(event);
      this.dispatchEvent(new Event("stop"));
    }
  }

  async function createRecorder(context, stream) {
    if (!context?.audioWorklet || typeof AudioWorkletNode === "undefined" || context.state === "closed") {
      throw new Error("当前浏览器不支持实时录音。");
    }
    let loaded = workletModules.get(context);
    if (!loaded) {
      loaded = context.audioWorklet.addModule(workletUrl);
      workletModules.set(context, loaded);
      loaded.catch(() => workletModules.delete(context));
    }
    await loaded;
    return new PCMRecorder(context, stream);
  }

  window.DropAudio = {prepare, createRecorder, maxDuration};
})();
