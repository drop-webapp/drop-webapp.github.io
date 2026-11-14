(function (root) {
  "use strict";
  const records = draft => draft.voiceTranscripts || [];
  function updateText(draft, text) {
    const old = draft.text || "";
    if (old === text) return;
    let start = 0, suffix = 0;
    while (start < old.length && start < text.length && old[start] === text[start]) start++;
    while (suffix < old.length - start && suffix < text.length - start && old[old.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
    const end = old.length - suffix, nextEnd = text.length - suffix, delta = text.length - old.length;
    const touched = records(draft).filter(row => row.bodyRange && start <= row.bodyRange.end && end >= row.bodyRange.start);
    for (const row of records(draft)) {
      const range = row.bodyRange;
      if (!range) continue;
      if (end < range.start || (end === range.start && start !== end)) {
        range.start += delta; range.end += delta;
      } else if (start <= range.end && end >= range.start) {
        row.bodyEdited = true;
        if (touched.length > 1 || start < range.start || end > range.end) row.rangeLost = true;
        range.start = range.start < start ? range.start : start;
        range.end = range.end > end ? range.end + delta : nextEnd;
      }
    }
    draft.text = text;
  }
  function needsConfirmation(draft, row) {
    return Boolean(row.selectedVersion && (row.bodyEdited || !row.bodyRange || (draft.text || "").slice(row.bodyRange.start, row.bodyRange.end) !== row.appliedText));
  }
  function apply(draft, row, version) {
    const text = version === "refined" ? row.refined_text : row.original_text;
    if (!text) throw Error("这个版本还没有准备好。");
    const old = draft.text || "";
    if (!row.selectedVersion) {
      const separator = old.length ? "\n\n" : "";
      row.bodyRange = {start: old.length + separator.length, end: old.length + separator.length + text.length};
      draft.text = old + separator + text;
    } else {
      if (!row.bodyRange || row.rangeLost) throw Error("这段已和其他正文一起修改过。为保留其他段落，请复制版本后手动调整。");
      const {start, end} = row.bodyRange;
      const delta = text.length - (end - start);
      for (const other of records(draft)) {
        if (other === row || !other.bodyRange) continue;
        if (other.bodyRange.start < end && other.bodyRange.end > start) throw Error("段落边界已改变，请复制版本后手动调整。");
      }
      for (const other of records(draft)) {
        if (other !== row && other.bodyRange && other.bodyRange.start >= end) { other.bodyRange.start += delta; other.bodyRange.end += delta; }
      }
      draft.text = old.slice(0, start) + text + old.slice(end);
      row.bodyRange.end = start + text.length;
    }
    row.appliedText = text; row.selectedVersion = version; row.bodyEdited = false;
    if (draft.pendingVersionID === row.id) delete draft.pendingVersionID;
  }
  const api = {updateText, needsConfirmation, apply};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DropVoiceVersions = api;
})(typeof window !== "undefined" ? window : globalThis);
