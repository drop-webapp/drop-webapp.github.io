"use strict";

// Only a short-lived, one-use Drop ticket is sent here, never a provider key.
window.DropLiveAudio = {
  connect(grant, {onText, onStatus}) {
    const socket = new WebSocket(grant.stream_url);
    let ready = false, ended = false, stopping = false, paused = false, pendingBytes = 0;
    let queue = [], finishTimer, resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const settle = (result) => {
      if (ended) return;
      ended = true; clearTimeout(startTimer); clearTimeout(finishTimer); queue = [];
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      resolveDone(result);
      if (!result.ok && !result.cancelled) onStatus("unavailable");
    };
    const startTimer = setTimeout(() => settle({ok: false}), 15000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ticket: grant.stream_ticket})));
    socket.addEventListener("message", event => {
      if (ended) return;
      let message;
      try { message = JSON.parse(event.data); } catch { settle({ok: false}); return; }
      if (message.type === "ready") {
        ready = true; clearTimeout(startTimer);
        for (const chunk of queue) socket.send(chunk);
        queue = []; pendingBytes = 0;
        if (paused) socket.send(JSON.stringify({type: "pause"}));
        if (stopping) socket.send(JSON.stringify({type: "finish"}));
        else onStatus("listening");
      } else if (message.type === "transcript") {
        onText(message);
      } else if (message.type === "done") {
        onText({text: message.text, final_text: message.text, partial_text: ""});
        settle({ok: true, text: message.text});
      } else if (message.type === "error") { settle({ok: false}); }
    });
    socket.addEventListener("error", () => settle({ok: false}));
    socket.addEventListener("close", () => { if (!ended) settle({ok: false}); });
    return {
      push(chunk) {
        if (ended || stopping) return;
        if (!ready) {
          pendingBytes += chunk.byteLength;
          if (pendingBytes > 1024 * 1024) { settle({ok: false}); return; }
          queue.push(chunk);
        } else if (socket.bufferedAmount > 256 * 1024) { settle({ok: false}); }
        else { socket.send(chunk); }
      },
      pause() { paused = true; if (ready && !ended) socket.send(JSON.stringify({type: "pause"})); },
      resume() { paused = false; if (ready && !ended) socket.send(JSON.stringify({type: "resume"})); },
      finish() {
        if (!stopping && !ended) {
          stopping = true;
          if (ready) socket.send(JSON.stringify({type: "finish"}));
          finishTimer = setTimeout(() => settle({ok: false}), 25000);
        }
        return done;
      },
      cancel() { settle({ok: false, cancelled: true}); },
    };
  },
};
