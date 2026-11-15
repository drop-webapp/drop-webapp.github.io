"use strict";
(() => {
  const form = document.getElementById("permission-form");
  if (!form) return;
  const allow = document.getElementById("permission-allow");
  if (form.dataset.picker === "true") {
    const location = document.getElementById("permission-location");
    const sync = () => form.querySelectorAll("[data-location-field]").forEach(input => { input.disabled = !location.checked; });
    location.addEventListener("change", sync); sync();
    return;
  }
  const update = () => {
    if (allow) allow.disabled = !form.querySelector('input[name="entries"]:checked') || !form.querySelector('input[name="fields"]:checked');
  };
  form.addEventListener("change", update); update();
  const input = document.getElementById("permission-day");
  const panel = document.getElementById("permission-calendar");
  const trigger = document.getElementById("permission-date");
  const today = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai"}).format(new Date());
  let shown = new Date((input.value || today).slice(0,7) + "-01T12:00:00");
  function render() {
    const year = shown.getFullYear(), month = shown.getMonth();
    document.getElementById("permission-month").textContent = year + " 年 " + (month + 1) + " 月";
    const grid = document.getElementById("permission-days"); grid.replaceChildren();
    for (const day of "一二三四五六日") { const label = document.createElement("span"); label.textContent = day; grid.append(label); }
    for (let i = 0; i < (shown.getDay() + 6) % 7; i++) grid.append(document.createElement("span"));
    for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) {
      const key = `${year}-${String(month + 1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const cell = document.createElement("button"); cell.type = "button"; cell.textContent = day;
      cell.setAttribute("aria-label", key); cell.setAttribute("aria-pressed", String(key === input.value));
      if (key === today) cell.setAttribute("aria-current", "date");
      cell.addEventListener("click", () => { input.value = key; document.getElementById("permission-filter").requestSubmit(); });
      grid.append(cell);
    }
  }
  trigger.addEventListener("click", () => { panel.hidden = !panel.hidden; trigger.setAttribute("aria-expanded", String(!panel.hidden)); if (!panel.hidden) render(); });
  document.getElementById("permission-prev").addEventListener("click", () => { shown = new Date(shown.getFullYear(), shown.getMonth() - 1, 1, 12); render(); });
  document.getElementById("permission-next").addEventListener("click", () => { shown = new Date(shown.getFullYear(), shown.getMonth() + 1, 1, 12); render(); });
  document.getElementById("permission-recent").addEventListener("click", () => { input.value = ""; document.getElementById("permission-filter").requestSubmit(); });
  panel.addEventListener("keydown", event => { if (event.key === "Escape") { panel.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.focus(); } });
})();
