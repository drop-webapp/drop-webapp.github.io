"use strict";

(() => {
  const sampleRate = 16000;
  const maxDuration = 60;
  const durationTolerance = 0.1;

  function encodeWav(samples) {
    const headerSize = 44;
    const dataSize = samples.length * 2;
    const bytes = new ArrayBuffer(headerSize + dataSize);
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
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(headerSize + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return new Blob([bytes], {type: "audio/wav"});
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
      throw new Error("录音超过 60 秒，请缩短后重新录音。");
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

  window.DropAudio = {prepare};
})();
