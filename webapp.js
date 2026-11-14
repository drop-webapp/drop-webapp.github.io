"use strict";

// Match Frienden's app gestures without taking over one-finger scrolling,
// text editing, keyboard navigation or the browser's zoom keyboard shortcuts.
(() => {
  const preventZoom = event => { if (event.cancelable) event.preventDefault(); };
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, preventZoom, {passive: false});
  }
  document.addEventListener("touchmove", event => {
    if (event.touches.length > 1) preventZoom(event);
  }, {passive: false});
  window.addEventListener("wheel", event => {
    if (event.ctrlKey) preventZoom(event);
  }, {passive: false});
  document.addEventListener("dragstart", event => {
    if (event.target.closest?.("img")) event.preventDefault();
  });

  let installPrompt = null, installed = false;
  const standalone = window.matchMedia("(display-mode: standalone)");
  const isStandalone = () => standalone.matches || navigator.standalone === true;
  function sync() {
    document.documentElement.dataset.appMode = isStandalone() ? "standalone" : "browser";
    window.dispatchEvent(new Event("drop:install-state"));
  }
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault(); installPrompt = event; sync();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null; installed = true; sync();
  });
  standalone.addEventListener?.("change", sync);
  window.addEventListener("pageshow", sync);

  window.DropWebApp = {
    isStandalone,
    isInstalled: () => installed || isStandalone(),
    canInstall: () => Boolean(installPrompt) && !installed && !isStandalone(),
    async install() {
      if (!installPrompt) return "unavailable";
      const prompt = installPrompt;
      installPrompt = null;
      try {
        // Called directly inside the user's click, preserving user activation.
        await prompt.prompt();
        const {outcome} = await prompt.userChoice;
        if (outcome === "accepted") installed = true;
        return outcome;
      } finally { sync(); }
    },
    async copy(text) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch { return false; }
    },
    installSteps() {
      const ua = navigator.userAgent;
      const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      if (ios) return ["在浏览器中轻点“分享”。", "选择“添加到主屏幕”，再轻点“添加”。", "以后从主屏幕上的一滴图标打开。"];
      if (/Android/i.test(ua)) return ["打开浏览器右上角的菜单。", "选择“安装应用”或“添加到主屏幕”。", "按提示确认，以后从一滴图标打开。"];
      if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return ["在 Safari 的“文件”菜单中选择“添加到程序坞”。", "确认名称为“一滴”，再轻点“添加”。"];
      return ["点击地址栏的安装图标，或打开浏览器菜单。", "选择“安装一滴”或“将此网页安装为应用”。", "如果没有安装选项，可以先将一滴加入书签。"];
    },
  };
  sync();
})();
