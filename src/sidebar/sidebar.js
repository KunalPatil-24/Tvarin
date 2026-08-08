/*
 * Tvarin right sidebar — Jobright-style in-page panel (Shadow DOM).
 * Auto-opens on detected job application pages; toolbar icon toggles it.
 * When open, pushes the host page left (margin/width) so form CTAs stay visible.
 * Shares the content-script isolated world with content.js (TvarinAPI).
 */
(() => {
  "use strict";

  // Sidebar only belongs on the top frame (ATS forms may live in iframes).
  if (window !== window.top) return;
  // Prevent double-inject (toolbar fallback) from breaking a live sidebar.
  if (globalThis.__tvarinSidebarLoaded) return;
  globalThis.__tvarinSidebarLoaded = true;

  const HOST_ID = "tvarin-sidebar-host";
  const PUSH_STYLE_ID = "tvarin-page-push";
  const PANEL_WIDTH = 398;
  const PANEL_MAX_VW = 0.92;
  const PANEL_TRANSITION = "0.34s cubic-bezier(0.22, 1, 0.36, 1)";
  const STORAGE_KEYS = {
    profile: "tvarin.profile",
    applications: "tvarin.applications",
    bookmarks: "tvarin.bookmarks",
    resume: "tvarin.resume",
    settings: "tvarin.settings",
    // Small UI state: { tabTopFraction } — where the user dragged the bubble.
    ui: "tvarin.ui",
    // Hostnames the user chose to hide the bubble on ("Hide on this site").
    hiddenSites: "tvarin.hiddenSites",
    session: "tvarin.session",
  };

  let host = null;
  let root = null;
  let open = false;
  let autoOpenedForUrl = "";
  let signedIn = false;
  let pushClearTimer = null;

  function getPanelWidth() {
    return Math.min(PANEL_WIDTH, Math.round(window.innerWidth * PANEL_MAX_VW));
  }

  /** Reserve right-side space so the host page reflows instead of sitting under the panel. */
  function applyPagePush() {
    if (pushClearTimer) {
      clearTimeout(pushClearTimer);
      pushClearTimer = null;
    }
    const w = getPanelWidth();
    let el = document.getElementById(PUSH_STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = PUSH_STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = `
      html {
        width: calc(100% - ${w}px) !important;
        max-width: calc(100vw - ${w}px) !important;
        margin-right: ${w}px !important;
        box-sizing: border-box !important;
        transition: margin-right ${PANEL_TRANSITION}, width ${PANEL_TRANSITION}, max-width ${PANEL_TRANSITION} !important;
      }
    `;
  }

  function clearPagePush({ immediate = false } = {}) {
    const el = document.getElementById(PUSH_STYLE_ID);
    if (!el) return;
    if (immediate) {
      if (pushClearTimer) {
        clearTimeout(pushClearTimer);
        pushClearTimer = null;
      }
      el.remove();
      return;
    }
    el.textContent = `
      html {
        width: 100% !important;
        max-width: 100vw !important;
        margin-right: 0 !important;
        box-sizing: border-box !important;
        transition: margin-right ${PANEL_TRANSITION}, width ${PANEL_TRANSITION}, max-width ${PANEL_TRANSITION} !important;
      }
    `;
    if (pushClearTimer) clearTimeout(pushClearTimer);
    pushClearTimer = setTimeout(() => {
      pushClearTimer = null;
      if (!open) {
        const still = document.getElementById(PUSH_STYLE_ID);
        if (still) still.remove();
      }
    }, 360);
  }

  function onViewportResize() {
    if (open) applyPagePush();
    const tabEl = root && root.querySelector(".tab");
    if (tabEl) placeTab(tabEl);
  }

  function get(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function fontFaceCss() {
    const weights = [400, 500, 600, 700, 800];
    return weights
      .map(
        (w) => `@font-face {
      font-family: "Inter";
      font-style: normal;
      font-weight: ${w};
      font-display: swap;
      src: url("${chrome.runtime.getURL(`src/shared/fonts/Inter-${w}.woff2`)}") format("woff2");
    }`
      )
      .join("\n");
  }

  function buildCss() {
    return `
    ${fontFaceCss()}
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed;
      z-index: 2147483645;
      top: 0;
      right: 0;
      left: auto;
      width: 48px;
      height: 100vh;
      height: 100dvh;
      pointer-events: none;
      visibility: visible !important;
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #12151a;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .wrap.is-open { width: min(398px, 92vw); }
    .tab {
      pointer-events: auto;
      position: absolute;
      top: 28%;
      right: 0;
      left: auto;
      width: 48px;
      height: 58px;
      border: none;
      border-radius: 12px 0 0 12px;
      background: #2f6fed;
      color: #ffffff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: -2px 4px 16px rgba(17, 24, 39, 0.12);
      transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
      opacity: 1;
      touch-action: none;
    }
    .tab:hover { filter: brightness(1.05); }
    .tab:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
    .tab.tab--dragging { cursor: grabbing; transition: opacity 0.2s ease; }
    .tab__mark { display: grid; place-items: center; pointer-events: none; }
    .tab .tab__mark svg { width: 18px; height: 18px; }
    /* Dedicated drag handle — only this strip moves the bubble. Appears on hover
       on the right (screen-edge) side; the rest of the tab stays click-to-open. */
    .tab__grip {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 13px;
      display: grid;
      place-items: center;
      color: rgba(255, 255, 255, 0.9);
      cursor: grab;
      opacity: 0;
      transition: opacity 0.14s ease;
      pointer-events: none;
    }
    .tab:hover .tab__grip,
    .tab:focus-within .tab__grip {
      opacity: 1;
      pointer-events: auto;
    }
    .tab__grip:active,
    .tab.tab--dragging .tab__grip { cursor: grabbing; }
    .tab__close {
      position: absolute;
      top: -9px;
      left: -9px;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: #ffffff;
      color: #6b7280;
      display: grid;
      place-items: center;
      cursor: pointer;
      box-shadow: 0 1px 5px rgba(17, 24, 39, 0.3);
      opacity: 0;
      transform: scale(0.5);
      transition: opacity 0.14s ease, transform 0.14s ease;
      pointer-events: none;
    }
    .tab:hover .tab__close,
    .tab:focus-within .tab__close {
      opacity: 1;
      transform: scale(1);
      pointer-events: auto;
    }
    .tab__close:hover { color: #b42318; }
    .tab__close svg { width: 11px; height: 11px; }
    .tab-menu {
      position: absolute;
      top: -6px;
      right: calc(100% + 10px);
      width: 200px;
      background: #ffffff;
      color: #1f2937;
      border: 1px solid #e8eaed;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(17, 24, 39, 0.18);
      padding: 6px;
      z-index: 5;
      cursor: default;
    }
    .tab-menu[hidden] { display: none; }
    .tab-menu__item {
      display: block;
      width: 100%;
      text-align: left;
      border: none;
      background: transparent;
      padding: 9px 10px;
      border-radius: 8px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      color: #1f2937;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tab-menu__item:hover { background: #f3f4f6; }
    .wrap.is-open .tab {
      transform: translateX(-398px);
      opacity: 0;
      pointer-events: none;
    }
    .panel {
      pointer-events: auto;
      position: absolute;
      top: 0;
      right: 0;
      left: auto;
      width: 398px;
      max-width: min(398px, 92vw);
      height: 100%;
      background: #ffffff;
      border-left: 1px solid #e8eaed;
      box-shadow: none;
      transform: translateX(105%);
      transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .wrap.is-open .panel { transform: translateX(0); }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 16px 12px;
      flex-shrink: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      font-size: 18px;
      letter-spacing: -0.03em;
      color: #111111;
    }
    .brand__mark {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: #2f6fed;
      display: grid;
      place-items: center;
      color: #ffffff;
    }
    .brand__mark svg { width: 16px; height: 16px; }
    .icon-btn {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      border: 1px solid #ebebeb;
      background: #fff;
      color: #6b7280;
      cursor: pointer;
      display: grid;
      place-items: center;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .icon-btn:hover { background: #eaf2ff; color: #2f6fed; }
    .icon-btn svg { width: 16px; height: 16px; }
    .head__actions { display: flex; gap: 6px; }
    .body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px 14px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #ebebeb;
      border-radius: 14px;
      padding: 14px;
      box-shadow: none;
    }
    .btn-fill {
      width: 100%;
      border: none;
      border-radius: 12px;
      padding: 14px 16px;
      background: #2f6fed;
      color: #ffffff;
      font-family: inherit;
      font-size: 15px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.01em;
      cursor: pointer;
      transition: transform 0.15s ease, filter 0.15s ease, background 0.15s ease;
    }
    .btn-fill:hover { filter: brightness(1.05); }
    .btn-fill:active { transform: scale(0.985); }
    .btn-fill:disabled { opacity: 0.65; cursor: default; transform: none; }
    .login-gate[hidden], .fill-ready[hidden] { display: none !important; }
    .login-gate { display: flex; flex-direction: column; gap: 8px; }
    .login-gate__title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: #111827;
      letter-spacing: -0.01em;
    }
    .login-gate__sub {
      margin: 0 0 4px;
      font-size: 12.5px;
      line-height: 1.45;
      color: #6b7280;
    }
    .btn-login {
      width: 100%;
      border: none;
      border-radius: 12px;
      padding: 14px 16px;
      background: #2f6fed;
      color: #ffffff;
      font-family: inherit;
      font-size: 15px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.01em;
      cursor: pointer;
      transition: transform 0.15s ease, filter 0.15s ease;
    }
    .btn-login:hover { filter: brightness(1.05); }
    .btn-login:active { transform: scale(0.985); }
    .btn-login:disabled { opacity: 0.65; cursor: default; transform: none; }
    .login-status {
      margin: 0;
      min-height: 1.2em;
      font-size: 12px;
      color: #6b7280;
    }
    .login-status--err { color: #dc2626; }
    .btn-match {
      width: 100%;
      margin-top: 10px;
      border: 1px solid #cdddfb;
      border-radius: 12px;
      padding: 10px 16px;
      background: #ffffff;
      color: #2f6fed;
      font-family: inherit;
      font-size: 13.5px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .btn-match:hover { background: #eaf2ff; border-color: #2f6fed; }
    .btn-match:disabled { opacity: 0.6; cursor: default; }
    .match { margin-top: 12px; }
    .match[hidden] { display: none !important; }
    .match__msg { margin: 4px 0 0; font-size: 12.5px; color: #6b7280; text-align: center; }
    .match__msg--warn { color: #b45309; }
    .match__head {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-bottom: 10px;
    }
    .score {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-width: 74px;
      padding: 8px 10px;
      border-radius: 12px;
      background: #f3f4f6;
      color: #374151;
    }
    .score--strong { background: #e7f6ee; color: #067647; }
    .score--partial { background: #fdf1dd; color: #b45309; }
    .score--stretch { background: #fdecec; color: #b42318; }
    .score__num { font-size: 24px; font-weight: 800; line-height: 1; letter-spacing: -0.02em; }
    .score__pct { font-size: 13px; font-weight: 700; }
    .score__band { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; margin-top: 3px; }
    .score__meta { font-size: 12.5px; font-weight: 500; color: #6b7280; line-height: 1.35; }
    .match__summary {
      margin: 0 0 10px;
      font-size: 13px;
      font-weight: 400;
      color: #374151;
      line-height: 1.45;
    }
    .match__label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: #9ca3af;
      margin: 8px 0 4px;
    }
    .reqs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
    .req { display: flex; align-items: baseline; gap: 8px; font-size: 13px; line-height: 1.4; }
    .req__mark { flex-shrink: 0; font-weight: 800; width: 12px; text-align: center; }
    .req--met .req__mark { color: #067647; }
    .req--partial .req__mark { color: #b45309; }
    .req--missing .req__mark { color: #b42318; }
    .req__text { color: #111111; }
    .req--missing .req__text { color: #4b5563; }
    .stage-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .stage-chip {
      font-size: 12px;
      font-weight: 500;
      color: #374151;
      background: #f3f4f6;
      border-radius: 999px;
      padding: 5px 10px;
    }
    .stage-chip b { font-weight: 800; }
    .stage-chip--applied { background: #eaf2ff; color: #1e40af; }
    .stage-chip--interviewing { background: #fdf1dd; color: #b45309; }
    .stage-chip--offer { background: #e7f6ee; color: #067647; }
    .stage-chip--rejected { background: #fdecec; color: #b42318; }
    .tracker-rate { font-size: 12.5px; color: #6b7280; margin-bottom: 12px; }
    .tracker-rate b { color: #111; }
    .tracker-rate__sub { color: #9ca3af; }
    .tracker-empty {
      padding: 18px 14px;
      text-align: center;
      border: 1px dashed #d1d5db;
      border-radius: 12px;
      color: #6b7280;
      font-size: 13px;
      line-height: 1.5;
    }
    .tracker-list { display: flex; flex-direction: column; gap: 8px; }
    .app {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 12px;
      border: 1px solid #ebebeb;
      border-radius: 12px;
      background: #fff;
    }
    .app__main { flex: 1; min-width: 0; }
    .app__title {
      display: block;
      font-size: 13.5px;
      font-weight: 600;
      color: #111;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .app__meta {
      display: block;
      font-size: 11.5px;
      color: #6b7280;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .app__actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .app-status {
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      color: #374151;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 5px 6px;
      background: #fff;
      cursor: pointer;
    }
    .app__remove {
      width: 24px;
      height: 24px;
      border: none;
      background: transparent;
      color: #9ca3af;
      font-size: 18px;
      line-height: 1;
      border-radius: 6px;
      cursor: pointer;
    }
    .app__remove:hover { background: #fef2f2; color: #b42318; }
    .card__sub {
      margin: 10px 0 0;
      font-size: 13px;
      font-weight: 400;
      line-height: 1.4;
      color: #6b7280;
      text-align: center;
    }
    .result {
      min-height: 0;
      margin: 8px 0 0;
      font-size: 12px;
      font-weight: 500;
      color: #6b7280;
      text-align: center;
    }
    .icon-btn--bookmark.is-saved {
      background: #fff7ed;
      border-color: #f5b301;
      color: #b45309;
    }
    .icon-btn--bookmark.is-saved:hover { background: #ffedd5; color: #b45309; }
    .bmk-list { display: flex; flex-direction: column; gap: 8px; }
    .bmk {
      border: 1px solid #ebebeb;
      border-radius: 12px;
      background: #fff;
      padding: 11px 12px;
    }
    .bmk__top { display: flex; align-items: flex-start; gap: 10px; }
    .bmk__main { flex: 1; min-width: 0; }
    .bmk__title {
      display: block;
      font-size: 13.5px;
      font-weight: 600;
      color: #111;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bmk__meta {
      display: block;
      font-size: 11.5px;
      color: #6b7280;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bmk__wait {
      display: inline-block;
      margin-top: 7px;
      font-size: 11px;
      font-weight: 700;
      color: #b45309;
      background: #fff7ed;
      border-radius: 999px;
      padding: 2px 8px;
    }
    .bmk__actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .bmk__open, .bmk__remove {
      width: 26px;
      height: 26px;
      border: none;
      background: transparent;
      color: #9ca3af;
      border-radius: 6px;
      cursor: pointer;
      display: grid;
      place-items: center;
    }
    .bmk__open:hover { background: #eff6ff; color: #2f6fed; }
    .bmk__remove { font-size: 18px; line-height: 1; }
    .bmk__remove:hover { background: #fef2f2; color: #b42318; }
    .bmk__note {
      width: 100%;
      margin-top: 9px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 7px 9px;
      font-family: inherit;
      font-size: 12px;
      line-height: 1.4;
      color: #374151;
      background: #fff;
      resize: vertical;
      min-height: 34px;
      box-sizing: border-box;
    }
    .bmk__note::placeholder { color: #9ca3af; }
    .bmk__note:focus { outline: none; border-color: #2f6fed; box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.14); }
    .set-group-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #9ca3af;
      margin: 18px 0 0;
    }
    .set-group-label:first-of-type { margin-top: 6px; }
    .set-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      padding: 13px 2px;
      border-top: 1px solid #f0f0f0;
      cursor: pointer;
    }
    .set-row__text { flex: 1; min-width: 0; }
    .set-row__title { display: block; font-size: 14px; font-weight: 600; color: #111; }
    .set-row__desc {
      display: block;
      font-size: 12px;
      color: #6b7280;
      margin-top: 3px;
      line-height: 1.45;
    }
    .switch {
      -webkit-appearance: none;
      appearance: none;
      flex-shrink: 0;
      width: 40px;
      height: 23px;
      margin: 1px 0 0;
      border-radius: 999px;
      background: #d5d7dd;
      position: relative;
      cursor: pointer;
      transition: background 0.18s ease;
    }
    .switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 19px;
      height: 19px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
      transition: transform 0.18s ease;
    }
    .switch:checked { background: #2f6fed; }
    .switch:checked::after { transform: translateX(17px); }
    .switch:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.25); }
    .set-hidden { margin-top: 2px; }
    .set-empty { font-size: 12px; color: #9ca3af; padding: 10px 2px; line-height: 1.5; }
    .hidden-site {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 2px;
      border-top: 1px solid #f0f0f0;
      font-size: 13px;
      color: #374151;
    }
    .hidden-site__host { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hidden-site__remove {
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: #9ca3af;
      font-size: 17px;
      line-height: 1;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      cursor: pointer;
    }
    .hidden-site__remove:hover { background: #eef2ff; color: #2f6fed; }
    .stats {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #eaf2ff;
      color: #1e3a8a;
      font-size: 13px;
      font-weight: 600;
    }
    .stats__dot { opacity: 0.45; font-weight: 400; }
    .list {
      background: #ffffff;
      border: 1px solid #ebebeb;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: none;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 13px 14px;
      border: none;
      border-bottom: 1px solid #f0f0f0;
      background: transparent;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
      color: inherit;
    }
    .row:last-child { border-bottom: none; }
    .row:hover { background: #f8faff; }
    .row__icon {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      background: #f5f6f8;
      color: #374151;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .row__icon svg { width: 16px; height: 16px; }
    .row__text { flex: 1; min-width: 0; }
    .row__title {
      display: block;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #111111;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row__meta {
      display: block;
      font-size: 12px;
      font-weight: 400;
      color: #6b7280;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row__meta--warn { color: #b45309; font-weight: 500; }
    .row__chev { color: #9ca3af; flex-shrink: 0; }
    .view[hidden] { display: none !important; }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: none;
      background: transparent;
      color: #2f6fed;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 0 0 4px;
      margin-bottom: 4px;
    }
    .back:hover { text-decoration: underline; }
    .resume-title {
      margin: 0 0 6px;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #111111;
    }
    .resume-note {
      margin: 0 0 14px;
      font-size: 13px;
      font-weight: 400;
      color: #6b7280;
      line-height: 1.4;
    }
    .resume-file {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      border-radius: 12px;
      background: #f8faff;
      border: 1px solid #ebebeb;
      margin-bottom: 14px;
    }
    .resume-file__icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: #eaf2ff;
      color: #2f6fed;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .resume-file__icon svg { width: 18px; height: 18px; }
    .resume-file__name {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: #111111;
      word-break: break-word;
    }
    .resume-file__meta {
      display: block;
      font-size: 12px;
      font-weight: 400;
      color: #6b7280;
      margin-top: 3px;
    }
    .resume-empty {
      padding: 16px 12px;
      text-align: center;
      border: 1px dashed #d1d5db;
      border-radius: 12px;
      color: #6b7280;
      font-size: 13px;
      margin-bottom: 14px;
    }
    .resume-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .btn-secondary {
      width: 100%;
      border: 1px solid #ebebeb;
      border-radius: 12px;
      padding: 12px 14px;
      background: #ffffff;
      color: #111111;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
    }
    .btn-secondary:hover { background: #f8faff; }
    .btn-secondary:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .btn-danger {
      width: 100%;
      border: 1px solid #fecaca;
      border-radius: 12px;
      padding: 12px 14px;
      background: #fff;
      color: #b91c1c;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-danger:hover { background: #fef2f2; }
    .btn-danger[hidden] { display: none !important; }
    .file-btn {
      position: relative;
      overflow: hidden;
    }
    .file-btn input {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      font-size: 0;
    }
    .resume-msg {
      min-height: 16px;
      margin: 10px 0 0;
      font-size: 12px;
      font-weight: 500;
      color: #6b7280;
      text-align: center;
    }
    .resume-msg--ok { color: #059669; }
    .resume-msg--err { color: #b91c1c; }

    /* Fill progress footer */
    .progress {
      flex-shrink: 0;
      border-top: 1px solid #ebebeb;
      background: #ffffff;
      padding: 10px 14px 14px;
    }
    .progress[hidden] { display: none !important; }
    .progress__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      border: none;
      background: transparent;
      padding: 0;
      margin: 0;
      cursor: pointer;
      font-family: inherit;
      text-align: left;
      color: inherit;
    }
    .progress__summary {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #111111;
      line-height: 1.3;
    }
    .progress__chev {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      color: #6b7280;
      transition: transform 0.2s ease, background 0.15s ease;
    }
    .progress__chev svg { width: 14px; height: 14px; }
    .progress__head:hover .progress__chev { background: #f5f6f8; color: #2f6fed; }
    .progress.is-expanded .progress__chev { transform: rotate(180deg); }
    .progress__bar {
      margin-top: 10px;
      height: 7px;
      border-radius: 999px;
      background: #e8eef9;
      overflow: hidden;
    }
    .progress__bar-fill {
      height: 100%;
      width: 0%;
      border-radius: inherit;
      background: #2f6fed;
      transition: width 0.28s ease;
    }
    .progress__list {
      display: none;
      margin-top: 12px;
      max-height: min(42vh, 360px);
      overflow-y: auto;
      padding-right: 2px;
    }
    .progress.is-expanded .progress__list { display: block; }
    .progress__section {
      font-size: 12px;
      font-weight: 700;
      color: #111111;
      margin: 0 0 6px 2px;
    }
    .progress__items {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .progress__item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      width: 100%;
      border: none;
      background: transparent;
      padding: 8px 6px;
      margin: 0;
      border-radius: 10px;
      cursor: pointer;
      font-family: inherit;
      text-align: left;
      color: inherit;
    }
    .progress__item:hover { background: #f8faff; }
    .progress__check {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      margin-top: 1px;
      border-radius: 50%;
      border: 2px solid #d1d5db;
      background: #fff;
      display: grid;
      place-items: center;
      color: #fff;
    }
    .progress__check svg { width: 10px; height: 10px; opacity: 0; }
    .progress__item.is-filled .progress__check {
      border-color: #16a34a;
      background: #16a34a;
    }
    .progress__item.is-filled .progress__check svg { opacity: 1; }
    .progress__label {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.35;
      color: #1f2937;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .progress__empty {
      font-size: 12px;
      color: #6b7280;
      padding: 8px 4px;
      margin: 0;
    }
  `;
  }

  const MARK_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h7l-2.5 8L20 8h-7l2.5-8L4 12z" fill="currentColor"/></svg>`;
  const X_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  const GRIP_SVG = `<svg viewBox="0 0 8 18" width="6" height="14" fill="currentColor" aria-hidden="true"><circle cx="2" cy="3" r="1"/><circle cx="6" cy="3" r="1"/><circle cx="2" cy="9" r="1"/><circle cx="6" cy="9" r="1"/><circle cx="2" cy="15" r="1"/><circle cx="6" cy="15" r="1"/></svg>`;
  const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  const COLLAPSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
  const USER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 19c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/></svg>`;
  const DOC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 3h7l4 4v14H7V3z"/><path d="M14 3v5h5"/></svg>`;
  const CHEV_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
  const CHEV_UP_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg>`;
  const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5L19 7"/></svg>`;
  const BACK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>`;
  const BOOKMARK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12a1 1 0 0 1 1 1v15.4a.6.6 0 0 1-.9.5L12 18l-6.1 3.4a.6.6 0 0 1-.9-.5V5a1 1 0 0 1 1-1z"/></svg>`;
  const BOOKMARK_FILL_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v16.4a.6.6 0 0 1-.9.5L12 18l-6.1 3.9A.6.6 0 0 1 5 21.4V4a1 1 0 0 1 1-1z"/></svg>`;
  const EXT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>`;
  const MAX_RESUME_BYTES = 2 * 1024 * 1024;

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function set(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  function removeKeys(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  function showView(name) {
    ensure();
    root.querySelectorAll("[data-view]").forEach((el) => {
      el.hidden = el.getAttribute("data-view") !== name;
    });
  }

  function ensure() {
    if (root && host && host.isConnected) return root;
    // Host gone (page rewrite / other extension) — full rebuild.
    root = null;
    host = null;
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${buildCss()}</style>
      <div class="wrap" part="wrap">
        <div class="tab" role="button" tabindex="0" title="Open Tvarin — drag the handle to move" aria-label="Open Tvarin">
          <span class="tab__mark">${MARK_SVG}</span>
          <span class="tab__grip" title="Drag to move" aria-hidden="true">${GRIP_SVG}</span>
          <button class="tab__close" type="button" tabindex="0" title="Hide" aria-label="Hide Tvarin" aria-haspopup="menu">${X_SVG}</button>
          <div class="tab-menu" data-el="tab-menu" role="menu" hidden>
            <button type="button" class="tab-menu__item" data-menu="hide-visit" role="menuitem">Hide until next visit</button>
            <button type="button" class="tab-menu__item" data-menu="hide-site" role="menuitem">Hide on this domain</button>
          </div>
        </div>
        <aside class="panel" role="complementary" aria-label="Tvarin">
          <header class="head">
            <div class="brand">
              <span class="brand__mark">${MARK_SVG}</span>
              <span>Tvarin</span>
            </div>
            <div class="head__actions">
              <button class="icon-btn icon-btn--bookmark" type="button" data-action="bookmark-toggle" data-el="bookmark-btn" title="Bookmark this job" aria-label="Bookmark this job" aria-pressed="false">${BOOKMARK_SVG}</button>
              <button class="icon-btn" type="button" data-action="settings" title="Settings" aria-label="Settings">${GEAR_SVG}</button>
              <button class="icon-btn" type="button" data-action="close" title="Minimize" aria-label="Minimize sidebar">${COLLAPSE_SVG}</button>
            </div>
          </header>
          <div class="body view" data-view="home">
            <div class="card">
              <div class="login-gate" data-el="login-gate">
                <p class="login-gate__title">Sign in to continue</p>
                <p class="login-gate__sub">Use Google to unlock autofill, job match, and AI drafts.</p>
                <button class="btn-login" type="button" data-action="signin" data-el="signin-btn">
                  Continue with Google
                </button>
                <p class="login-status" data-el="login-status" aria-live="polite"></p>
              </div>
              <div class="fill-ready" data-el="fill-ready" hidden>
                <button class="btn-fill" type="button" data-action="fill">Fill this page</button>
                <p class="result" data-el="result" aria-live="polite"></p>
                <button class="btn-match" type="button" data-action="match" data-el="match-btn">Check job match</button>
                <div class="match" data-el="match-result" hidden></div>
              </div>
            </div>
            <div class="stats" data-el="stats">
              <span><span data-el="stat-total">0</span> applied</span>
              <span class="stats__dot">·</span>
              <span><span data-el="stat-week">0</span> this week</span>
            </div>
            <div class="list">
              <button class="row" type="button" data-action="profile">
                <span class="row__icon">${USER_SVG}</span>
                <span class="row__text">
                  <span class="row__title">Your profile</span>
                  <span class="row__meta" data-el="profile-status">Loading…</span>
                </span>
                <span class="row__chev">${CHEV_SVG}</span>
              </button>
              <button class="row" type="button" data-action="resume">
                <span class="row__icon">${DOC_SVG}</span>
                <span class="row__text">
                  <span class="row__title">Resume</span>
                  <span class="row__meta" data-el="resume-status">No resume uploaded</span>
                </span>
                <span class="row__chev">${CHEV_SVG}</span>
              </button>
              <button class="row" type="button" data-action="tracker">
                <span class="row__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></span>
                <span class="row__text">
                  <span class="row__title">Applications</span>
                  <span class="row__meta" data-el="tracker-status">Track your applications</span>
                </span>
                <span class="row__chev">${CHEV_SVG}</span>
              </button>
              <button class="row" type="button" data-action="bookmarks">
                <span class="row__icon">${BOOKMARK_SVG}</span>
                <span class="row__text">
                  <span class="row__title">Bookmarks</span>
                  <span class="row__meta" data-el="bookmarks-status">Jobs you saved for later</span>
                </span>
                <span class="row__chev">${CHEV_SVG}</span>
              </button>
            </div>
          </div>
          <div class="body view" data-view="resume" hidden>
            <button class="back" type="button" data-action="home">${BACK_SVG} Back</button>
            <div class="card">
              <h2 class="resume-title">Resume</h2>
              <p class="resume-note">Stored on this device. Tvarin attaches it when you fill a form. PDF or Word, up to 2&nbsp;MB.</p>
              <div data-el="resume-detail"></div>
              <div class="resume-actions">
                <button class="btn-secondary" type="button" data-action="resume-view" data-el="resume-view-btn" disabled>
                  View resume
                </button>
                <label class="btn-secondary file-btn">
                  <span data-el="resume-replace-label">Upload resume</span>
                  <input data-el="resume-input" type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
                </label>
                <button class="btn-danger" type="button" data-action="resume-remove" data-el="resume-remove-btn" hidden>
                  Remove resume
                </button>
              </div>
              <p class="resume-msg" data-el="resume-msg" aria-live="polite"></p>
            </div>
          </div>
          <div class="body view" data-view="tracker" hidden>
            <button class="back" type="button" data-action="home">${BACK_SVG} Back</button>
            <h2 class="resume-title">Applications</h2>
            <p class="resume-note">Filled forms log automatically. Move each one through the stages as you hear back — Tvarin can't see your email, so you set the status.</p>
            <div class="tracker-summary" data-el="tracker-summary"></div>
            <div class="tracker-list" data-el="tracker-list"></div>
          </div>
          <div class="body view" data-view="bookmarks" hidden>
            <button class="back" type="button" data-action="home">${BACK_SVG} Back</button>
            <h2 class="resume-title">Bookmarks</h2>
            <p class="resume-note">Jobs you saved by hand to decide on later. Nothing here expires — perfect for the ones where you're waiting on a referral. Add a note to remember what you're waiting for.</p>
            <div class="bmk-list" data-el="bookmarks-list"></div>
          </div>
          <div class="body view" data-view="settings" hidden>
            <button class="back" type="button" data-action="home">${BACK_SVG} Back</button>
            <h2 class="resume-title">Settings</h2>
            <p class="resume-note">How Tvarin behaves on job pages. Changes save automatically.</p>
            <div class="set-group-label">Panel</div>
            <label class="set-row">
              <span class="set-row__text">
                <span class="set-row__title">Open automatically on job pages</span>
                <span class="set-row__desc">The panel slides open when a job application is detected. Off — it waits as a tab until you click it.</span>
              </span>
              <input type="checkbox" class="switch" data-el="set-autoOpen" data-key="autoOpen" aria-label="Open automatically on job pages" />
            </label>
            <div class="set-group-label">Autofill</div>
            <label class="set-row">
              <span class="set-row__text">
                <span class="set-row__title">Attach my resume when filling</span>
                <span class="set-row__desc">Drop your saved resume into the application's upload box. Off — you'll attach a file yourself.</span>
              </span>
              <input type="checkbox" class="switch" data-el="set-attachResume" data-key="attachResume" aria-label="Attach my resume when filling" />
            </label>
            <label class="set-row">
              <span class="set-row__text">
                <span class="set-row__title">Auto-decline diversity questions</span>
                <span class="set-row__desc">Answer “prefer not to say” on optional gender, race, veteran, and disability questions. Off by default.</span>
              </span>
              <input type="checkbox" class="switch" data-el="set-autoDeclineEEO" data-key="autoDeclineEEO" aria-label="Auto-decline diversity questions" />
            </label>
            <div class="set-group-label">Hidden sites</div>
            <div class="set-hidden" data-el="hidden-sites"></div>
          </div>
          <footer class="progress" data-el="progress" hidden>
            <button class="progress__head" type="button" data-action="toggle-progress" aria-expanded="false">
              <span class="progress__summary" data-el="progress-summary">Scanning fields…</span>
              <span class="progress__chev" aria-hidden="true">${CHEV_UP_SVG}</span>
            </button>
            <div class="progress__bar" aria-hidden="true">
              <div class="progress__bar-fill" data-el="progress-bar"></div>
            </div>
            <div class="progress__list" data-el="progress-list">
              <div class="progress__section">Required</div>
              <ul class="progress__items" data-el="progress-items"></ul>
            </div>
          </footer>
        </aside>
      </div>
    `;

    setupTab(root.querySelector(".tab"));
    root.querySelector(".panel").addEventListener("click", async (e) => {
      const el = e.target.closest("[data-action]");
      if (!el || !root.contains(el)) return;
      const action = el.getAttribute("data-action");
      if (action === "close") setOpen(false);
      else if (action === "home") showView("home");
      else if (action === "profile") {
        if (globalThis.TvarinProfileModal && globalThis.TvarinProfileModal.open) {
          globalThis.TvarinProfileModal.open();
        } else {
          chrome.runtime.sendMessage({ type: "TVARIN_OPEN_OPTIONS" });
        }
      } else if (action === "settings") {
        showView("settings");
        await renderSettings();
      } else if (action === "options") {
        chrome.runtime.sendMessage({ type: "TVARIN_OPEN_OPTIONS" });
      } else if (action === "resume") {
        showView("resume");
        await render();
      }       else if (action === "signin") await onSignIn(el);
      else if (action === "fill") await onFill(el);
      else if (action === "match") await onMatch(el);
      else if (action === "tracker") {
        // Full tracking/analysis lives on the hosted dashboard, not the sidebar.
        chrome.runtime.sendMessage({ type: "TVARIN_OPEN_DASHBOARD" });
      } else if (action === "app-remove") {
        await removeApp(el.getAttribute("data-app-ts"));
      } else if (action === "bookmark-toggle") {
        await onBookmarkToggle(el);
      } else if (action === "bookmarks") {
        showView("bookmarks");
        await renderBookmarks();
      } else if (action === "bookmark-remove") {
        await removeBookmark(el.getAttribute("data-bmk-id"));
      } else if (action === "unhide-site") {
        await unhideSite(el.getAttribute("data-host"));
      } else if (action === "toggle-progress") toggleProgressExpanded();
      else if (action === "focus-field") {
        const id = el.getAttribute("data-field-id");
        const api = globalThis.TvarinAPI;
        if (id && api && typeof api.focusField === "function") api.focusField(id);
      } else if (action === "resume-view") {
        chrome.runtime.sendMessage({ type: "TVARIN_OPEN_RESUME" });
      } else if (action === "resume-remove") await removeResume();
    });

    const resumeInput = root.querySelector('[data-el="resume-input"]');
    resumeInput.addEventListener("change", () => onResumeFile(resumeInput));

    // Status dropdowns in the tracker + bookmark notes (change doesn't bubble
    // through the click handler above; it fires on commit/blur).
    root.querySelector(".panel").addEventListener("change", async (e) => {
      const sel = e.target.closest("select.app-status");
      if (sel) {
        await setAppStatus(sel.getAttribute("data-app-ts"), sel.value);
        return;
      }
      const note = e.target.closest("textarea.bmk__note");
      if (note) {
        await setBookmarkNote(note.getAttribute("data-bmk-id"), note.value);
        return;
      }
      const sw = e.target.closest("input.switch[data-key]");
      if (sw) {
        await setSetting(sw.getAttribute("data-key"), sw.checked);
      }
    });

    return root;
  }

  function setOpen(next) {
    ensure();
    open = !!next;
    const wrap = root.querySelector(".wrap");
    wrap.classList.toggle("is-open", open);
    if (open) {
      applyPagePush();
      startProgressPolling();
    } else {
      clearPagePush();
      stopProgressPolling();
    }
  }

  function toggle() {
    ensure();
    setOpen(!open);
  }

  async function refreshSession() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "TVARIN_GET_SESSION" });
      const session = resp && resp.session;
      signedIn = !!(session && session.signedIn);
    } catch (_) {
      signedIn = false;
    }
  }

  // One card, two faces: the login gate (signed out) XOR the Fill + Match
  // actions (signed in). Fill and Match now live together in .fill-ready, so a
  // single toggle can't leave them out of sync with the gate.
  function applyAuthUi() {
    if (!root) return;
    const gate = root.querySelector('[data-el="login-gate"]');
    const ready = root.querySelector('[data-el="fill-ready"]');
    if (gate) gate.hidden = signedIn;
    if (ready) ready.hidden = !signedIn;
  }

  function setLoginStatus(text, isErr) {
    const el = root && root.querySelector('[data-el="login-status"]');
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("login-status--err", !!isErr);
  }

  async function onSignIn(btn) {
    setLoginStatus("Opening Google sign-in…");
    btn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "TVARIN_SIGN_IN" });
      if (!resp || !resp.ok) {
        setLoginStatus((resp && resp.error) || "Sign-in was cancelled.", true);
        return;
      }
      signedIn = true;
      setLoginStatus("");
      applyAuthUi();
      await render();
    } catch (e) {
      setLoginStatus((e && e.message) || "Sign-in failed.", true);
    } finally {
      btn.disabled = false;
    }
  }

  async function render() {
    ensure();
    await refreshSession();
    applyAuthUi();
    const data = await get([
      STORAGE_KEYS.profile,
      STORAGE_KEYS.applications,
      STORAGE_KEYS.bookmarks,
      STORAGE_KEYS.resume,
    ]);
    const profile = data[STORAGE_KEYS.profile];
    const apps = data[STORAGE_KEYS.applications] || [];
    const bookmarks = data[STORAGE_KEYS.bookmarks] || [];
    const resume = data[STORAGE_KEYS.resume];

    const statusEl = root.querySelector('[data-el="profile-status"]');
    if (profile && (profile.firstName || profile.email)) {
      const who = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
      statusEl.textContent = who || profile.email || "Profile ready";
      statusEl.classList.remove("row__meta--warn");
    } else {
      statusEl.textContent = "Set up your profile to fill forms";
      statusEl.classList.add("row__meta--warn");
    }

    const resumeEl = root.querySelector('[data-el="resume-status"]');
    resumeEl.textContent = resume && resume.name ? resume.name : "No resume uploaded";

    const detail = root.querySelector('[data-el="resume-detail"]');
    const viewBtn = root.querySelector('[data-el="resume-view-btn"]');
    const removeBtn = root.querySelector('[data-el="resume-remove-btn"]');
    const replaceLabel = root.querySelector('[data-el="resume-replace-label"]');
    if (resume && resume.name) {
      const when = resume.addedAt ? ` · added ${timeAgo(resume.addedAt)}` : "";
      detail.innerHTML = `
        <div class="resume-file">
          <span class="resume-file__icon">${DOC_SVG}</span>
          <span>
            <span class="resume-file__name">${escapeHtml(resume.name)}</span>
            <span class="resume-file__meta">${formatSize(resume.size)}${when}</span>
          </span>
        </div>`;
      viewBtn.disabled = !resume.dataUrl;
      removeBtn.hidden = false;
      replaceLabel.textContent = "Replace resume";
    } else {
      detail.innerHTML = `<div class="resume-empty">No resume uploaded yet.</div>`;
      viewBtn.disabled = true;
      removeBtn.hidden = true;
      replaceLabel.textContent = "Upload resume";
    }

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const applied = apps.filter((a) => a.status === "applied");
    root.querySelector('[data-el="stat-total"]').textContent = String(applied.length);
    root.querySelector('[data-el="stat-week"]').textContent = String(
      applied.filter((a) => (a.appliedAt || a.timestamp) >= weekAgo).length
    );

    const trackerStatus = root.querySelector('[data-el="tracker-status"]');
    if (trackerStatus) {
      trackerStatus.textContent = apps.length
        ? `${apps.length} tracked · ${applied.length} applied`
        : "Track your applications";
    }

    const bookmarksStatus = root.querySelector('[data-el="bookmarks-status"]');
    if (bookmarksStatus) {
      bookmarksStatus.textContent = bookmarks.length
        ? `${bookmarks.length} saved`
        : "Jobs you saved for later";
    }
    await refreshBookmarkButton();

    renderProgress();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setResumeMsg(text, kind) {
    const el = root.querySelector('[data-el="resume-msg"]');
    el.textContent = text || "";
    el.classList.remove("resume-msg--ok", "resume-msg--err");
    if (kind === "ok") el.classList.add("resume-msg--ok");
    if (kind === "err") el.classList.add("resume-msg--err");
  }

  async function onResumeFile(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    if (file.size > MAX_RESUME_BYTES) {
      setResumeMsg(`Too large (${formatSize(file.size)}). Max 2 MB.`, "err");
      return;
    }
    setResumeMsg("Saving…");
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const resume = {
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        dataUrl,
        addedAt: Date.now(),
      };
      await set({ [STORAGE_KEYS.resume]: resume });
      setResumeMsg("Resume saved.", "ok");
      await render();
      setTimeout(() => setResumeMsg(""), 2000);
    } catch (_) {
      setResumeMsg("Couldn't save that file. Try again.", "err");
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  async function removeResume() {
    await removeKeys([STORAGE_KEYS.resume]);
    setResumeMsg("Resume removed.", "ok");
    await render();
    setTimeout(() => setResumeMsg(""), 2000);
  }

  let progressExpanded = false;
  let progressTimer = null;

  function toggleProgressExpanded() {
    progressExpanded = !progressExpanded;
    const foot = root && root.querySelector('[data-el="progress"]');
    if (!foot) return;
    foot.classList.toggle("is-expanded", progressExpanded);
    const head = foot.querySelector(".progress__head");
    if (head) head.setAttribute("aria-expanded", progressExpanded ? "true" : "false");
  }

  function renderProgress() {
    if (!root) return;
    const foot = root.querySelector('[data-el="progress"]');
    const summary = root.querySelector('[data-el="progress-summary"]');
    const bar = root.querySelector('[data-el="progress-bar"]');
    const itemsEl = root.querySelector('[data-el="progress-items"]');
    if (!foot || !summary || !bar || !itemsEl) return;

    const api = globalThis.TvarinAPI;
    if (!api || typeof api.scanProgress !== "function") {
      foot.hidden = true;
      return;
    }

    let snap;
    try {
      snap = api.scanProgress();
    } catch (_) {
      foot.hidden = true;
      return;
    }

    if (!snap || !snap.total) {
      foot.hidden = true;
      return;
    }

    foot.hidden = false;
    foot.classList.toggle("is-expanded", progressExpanded);
    summary.textContent = `${snap.filled}/${snap.total} required fields filled | ${snap.percent}%`;
    bar.style.width = `${snap.percent}%`;

    itemsEl.innerHTML = "";
    if (!snap.fields.length) {
      itemsEl.innerHTML = `<li><p class="progress__empty">No fields detected on this step.</p></li>`;
      return;
    }

    for (const f of snap.fields) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "progress__item" + (f.filled ? " is-filled" : "");
      btn.setAttribute("data-action", "focus-field");
      btn.setAttribute("data-field-id", f.id);
      btn.innerHTML = `
        <span class="progress__check">${CHECK_SVG}</span>
        <span class="progress__label"></span>
      `;
      btn.querySelector(".progress__label").textContent = f.label;
      li.appendChild(btn);
      itemsEl.appendChild(li);
    }
  }

  function startProgressPolling() {
    stopProgressPolling();
    renderProgress();
    progressTimer = setInterval(() => {
      if (!open) return;
      renderProgress();
    }, 1200);
  }

  function stopProgressPolling() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  async function onFill(btn) {
    if (!signedIn) {
      setLoginStatus("Log in to autofill this page.", true);
      return;
    }
    const resultEl = root.querySelector('[data-el="result"]');
    resultEl.textContent = "Filling…";
    btn.disabled = true;
    try {
      const api = globalThis.TvarinAPI;
      if (!api || typeof api.fill !== "function") {
        resultEl.textContent = "Reload this page to enable filling.";
        return;
      }
      const response = await api.fill();

      // Also ask same-tab iframes (Greenhouse embeds, etc.) to fill.
      document.querySelectorAll("iframe").forEach((iframe) => {
        try {
          iframe.contentWindow.postMessage(
            { type: "TVARIN_FILL_FRAME", source: "tvarin" },
            "*"
          );
        } catch (_) {
          /* cross-origin access can throw on contentWindow in rare cases */
        }
      });

      if (!response) {
        resultEl.textContent = "No response.";
      } else if (response.needsProfile) {
        resultEl.textContent = "Set up your profile first →";
      } else {
        resultEl.textContent = `Filled ${response.filled} field(s).`;
      }
      await render();
      renderProgress();
    } catch (_) {
      resultEl.textContent = "Something went wrong — try again.";
    } finally {
      btn.disabled = false;
    }
  }

  async function onMatch(btn) {
    if (!signedIn) {
      setLoginStatus("Log in to check your job match.", true);
      return;
    }
    const out = root.querySelector('[data-el="match-result"]');
    const api = globalThis.TvarinAPI;
    if (!api || typeof api.jobInfo !== "function") {
      out.hidden = false;
      out.innerHTML = `<p class="match__msg">Reload this page to check the match.</p>`;
      return;
    }
    const info = api.jobInfo();
    btn.disabled = true;
    btn.textContent = "Analyzing…";
    out.hidden = false;
    out.innerHTML = `<p class="match__msg">Reading the job and your resume…</p>`;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "TVARIN_MATCH",
        jobTitle: info.title,
        jobDescription: info.description,
      });
      if (!resp || resp.error) {
        out.innerHTML = `<p class="match__msg match__msg--warn">${escapeHtml(
          (resp && resp.error) || "No response — try again."
        )}</p>`;
        return;
      }
      renderMatch(out, resp);
    } catch (_) {
      out.innerHTML = `<p class="match__msg match__msg--warn">Something went wrong — try again.</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Check job match";
    }
  }

  function renderMatch(out, r) {
    const band = (r.band || "").toLowerCase(); // strong | partial | stretch
    const reqs = Array.isArray(r.requirements) ? r.requirements : [];
    const chip = (req) => {
      const s = req.status; // met | partial | missing
      const mark = s === "met" ? "✓" : s === "partial" ? "~" : "✗";
      return `<li class="req req--${s}"><span class="req__mark">${mark}</span><span class="req__text">${escapeHtml(
        req.text
      )}</span></li>`;
    };
    const have = reqs.filter((q) => q.status === "met" || q.status === "partial");
    const missing = reqs.filter((q) => q.status === "missing");

    out.innerHTML = `
      <div class="match__head">
        <div class="score score--${band}">
          <span class="score__num">${Number(r.score) || 0}<span class="score__pct">%</span></span>
          <span class="score__band">${escapeHtml(r.band || "")} fit</span>
        </div>
        <div class="score__meta">${r.metCount || 0}/${r.total || reqs.length} key requirements covered</div>
      </div>
      ${r.summary ? `<p class="match__summary">${escapeHtml(r.summary)}</p>` : ""}
      ${have.length ? `<div class="match__label">You have</div><ul class="reqs">${have.map(chip).join("")}</ul>` : ""}
      ${missing.length ? `<div class="match__label">Missing — add if true</div><ul class="reqs">${missing.map(chip).join("")}</ul>` : ""}
    `;
  }

  /* ----- Application tracker ----- */

  const STAGES = [
    ["started", "Saved"],
    ["applied", "Applied"],
    ["interviewing", "Interviewing"],
    ["offer", "Offer"],
    ["rejected", "Rejected"],
  ];

  async function renderTracker() {
    ensure();
    const data = await get([STORAGE_KEYS.applications]);
    const apps = (data[STORAGE_KEYS.applications] || []).slice();
    const summary = root.querySelector('[data-el="tracker-summary"]');
    const listEl = root.querySelector('[data-el="tracker-list"]');

    if (!apps.length) {
      summary.innerHTML = "";
      listEl.innerHTML =
        `<div class="tracker-empty">No applications yet. Fill and submit a job form and it'll show up here — then move it through the stages as you hear back.</div>`;
      return;
    }

    const count = (k) => apps.filter((a) => (a.status || "started") === k).length;
    const submitted = apps.filter((a) => (a.status || "started") !== "started").length;
    const responses = apps.filter((a) => a.status === "interviewing" || a.status === "offer").length;
    const rate = submitted ? Math.round((100 * responses) / submitted) : 0;

    summary.innerHTML = `
      <div class="stage-chips">
        ${STAGES.map(
          ([k, label]) =>
            `<span class="stage-chip stage-chip--${k}"><b>${count(k)}</b> ${escapeHtml(label)}</span>`
        ).join("")}
      </div>
      ${submitted ? `<div class="tracker-rate">Response rate: <b>${rate}%</b> <span class="tracker-rate__sub">(${responses}/${submitted} replied)</span></div>` : ""}
    `;

    apps.sort(
      (a, b) =>
        (b.updatedAt || b.appliedAt || b.timestamp || 0) -
        (a.updatedAt || a.appliedAt || a.timestamp || 0)
    );

    listEl.innerHTML = apps
      .map((a) => {
        const status = a.status || "started";
        const when = timeAgo(a.updatedAt || a.appliedAt || a.timestamp || Date.now());
        const opts = STAGES.map(
          ([k, label]) => `<option value="${k}"${k === status ? " selected" : ""}>${escapeHtml(label)}</option>`
        ).join("");
        const ts = a.timestamp || "";
        return `
          <div class="app app--${status}">
            <div class="app__main">
              <span class="app__title">${escapeHtml(a.jobTitle || a.hostname || "Application")}</span>
              <span class="app__meta">${escapeHtml(a.company || a.hostname || "")} · ${when}</span>
            </div>
            <div class="app__actions">
              <select class="app-status" data-app-ts="${ts}" aria-label="Application status">${opts}</select>
              <button class="app__remove" type="button" data-action="app-remove" data-app-ts="${ts}" title="Remove" aria-label="Remove">×</button>
            </div>
          </div>`;
      })
      .join("");
  }

  async function setAppStatus(ts, status) {
    const data = await get([STORAGE_KEYS.applications]);
    const list = data[STORAGE_KEYS.applications] || [];
    const i = list.findIndex((a) => String(a.timestamp) === String(ts));
    if (i < 0) return;
    list[i] = { ...list[i], status, updatedAt: Date.now() };
    await set({ [STORAGE_KEYS.applications]: list });
    await renderTracker();
    await render();
  }

  async function removeApp(ts) {
    const data = await get([STORAGE_KEYS.applications]);
    const list = (data[STORAGE_KEYS.applications] || []).filter(
      (a) => String(a.timestamp) !== String(ts)
    );
    await set({ [STORAGE_KEYS.applications]: list });
    await renderTracker();
    await render();
  }

  /* ----- Bookmarks ----- */

  // Paint the header bookmark icon for the current page: amber + filled when
  // this job is saved, plain outline when not. The actual save/dedup lives in
  // content.js (TvarinAPI) so it shares one job identity with applications.
  async function refreshBookmarkButton() {
    if (!root) return;
    const btn = root.querySelector('[data-el="bookmark-btn"]');
    if (!btn) return;
    const api = globalThis.TvarinAPI;
    let saved = false;
    if (api && typeof api.isBookmarked === "function") {
      try {
        saved = await api.isBookmarked();
      } catch (_) {}
    }
    btn.classList.toggle("is-saved", saved);
    btn.setAttribute("aria-pressed", saved ? "true" : "false");
    const label = saved ? "Saved — remove bookmark" : "Bookmark this job";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = saved ? BOOKMARK_FILL_SVG : BOOKMARK_SVG;
  }

  let bookmarkBusy = false;
  async function onBookmarkToggle(btn) {
    const api = globalThis.TvarinAPI;
    if (!api || typeof api.toggleBookmark !== "function") return;
    if (bookmarkBusy) return; // ignore double-taps mid-write (would duplicate/flip)
    bookmarkBusy = true;
    let res = null;
    try {
      res = await api.toggleBookmark();
    } catch (_) {}
    bookmarkBusy = false;
    await refreshBookmarkButton();
    await render();
    // Confirm the action — the button is just an icon now, so a brief toast
    // makes the save/remove unmistakable (and teaches where bookmarks live).
    if (res && typeof api.toast === "function") {
      api.toast(res.bookmarked ? "Saved to Bookmarks" : "Removed from Bookmarks", 2200);
    }
  }

  async function renderBookmarks() {
    ensure();
    const data = await get([STORAGE_KEYS.bookmarks]);
    const list = (data[STORAGE_KEYS.bookmarks] || []).slice();
    const listEl = root.querySelector('[data-el="bookmarks-list"]');
    if (!listEl) return;

    if (!list.length) {
      listEl.innerHTML =
        `<div class="tracker-empty">No bookmarks yet. On any job page, hit <b>Bookmark this page</b> and it'll wait for you here — as long as you need.</div>`;
      return;
    }

    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    listEl.innerHTML = list
      .map((b) => {
        const id = escapeHtml(b.id || "");
        const title = escapeHtml(b.jobTitle || b.hostname || "Saved job");
        const company = b.company || b.hostname || "";
        const meta = escapeHtml(company);
        const wait = b.createdAt ? `Saved ${timeAgo(b.createdAt)}` : "";
        const url = b.url ? escapeHtml(b.url) : "";
        const open = url
          ? `<a class="bmk__open" href="${url}" target="_blank" rel="noopener noreferrer" title="Open job" aria-label="Open job">${EXT_SVG}</a>`
          : "";
        return `
          <div class="bmk">
            <div class="bmk__top">
              <div class="bmk__main">
                <span class="bmk__title">${title}</span>
                <span class="bmk__meta">${meta}</span>
                ${wait ? `<span class="bmk__wait">${escapeHtml(wait)}</span>` : ""}
              </div>
              <div class="bmk__actions">
                ${open}
                <button class="bmk__remove" type="button" data-action="bookmark-remove" data-bmk-id="${id}" title="Remove" aria-label="Remove">×</button>
              </div>
            </div>
            <textarea class="bmk__note" data-bmk-id="${id}" rows="1" placeholder="Add a note — e.g. waiting on referral from…">${escapeHtml(b.note || "")}</textarea>
          </div>`;
      })
      .join("");
  }

  async function setBookmarkNote(id, note) {
    const data = await get([STORAGE_KEYS.bookmarks]);
    const list = data[STORAGE_KEYS.bookmarks] || [];
    const i = list.findIndex((b) => String(b.id) === String(id));
    if (i < 0) return;
    // Save in place — don't re-render, or we'd yank the textarea out from under
    // the user mid-edit.
    list[i] = { ...list[i], note: String(note || "").slice(0, 500), updatedAt: Date.now() };
    await set({ [STORAGE_KEYS.bookmarks]: list });
  }

  async function removeBookmark(id) {
    const data = await get([STORAGE_KEYS.bookmarks]);
    const list = (data[STORAGE_KEYS.bookmarks] || []).filter(
      (b) => String(b.id) !== String(id)
    );
    await set({ [STORAGE_KEYS.bookmarks]: list });
    await renderBookmarks();
    await render();
  }

  /* ----- Settings ----- */

  // Paint each switch from stored settings. Defaults: auto-open ON, attach
  // resume ON, auto-decline EEO OFF (sensitive — opt-in).
  async function renderSettings() {
    ensure();
    const data = await get([STORAGE_KEYS.settings, STORAGE_KEYS.hiddenSites]);
    const s = data[STORAGE_KEYS.settings] || {};
    const q = (el) => root.querySelector(`[data-el="${el}"]`);
    const autoOpen = q("set-autoOpen");
    const attachResume = q("set-attachResume");
    const eeo = q("set-autoDeclineEEO");
    if (autoOpen) autoOpen.checked = s.autoOpen !== false;
    if (attachResume) attachResume.checked = s.attachResume !== false;
    if (eeo) eeo.checked = !!s.autoDeclineEEO;

    const list = Array.isArray(data[STORAGE_KEYS.hiddenSites])
      ? data[STORAGE_KEYS.hiddenSites]
      : [];
    hiddenSites = list; // keep the cache in sync with what's on screen
    const hiddenEl = q("hidden-sites");
    if (hiddenEl) {
      hiddenEl.innerHTML = list.length
        ? list
            .map(
              (h) =>
                `<div class="hidden-site"><span class="hidden-site__host">${escapeHtml(h)}</span><button class="hidden-site__remove" type="button" data-action="unhide-site" data-host="${escapeHtml(h)}" title="Show here again" aria-label="Un-hide ${escapeHtml(h)}">×</button></div>`
            )
            .join("")
        : `<p class="set-empty">None. Use the × on the bubble → “Hide on this domain” to add one.</p>`;
    }
  }

  // Merge one key into settings — never replace the whole object, or one screen
  // would wipe another's switches. Takes effect on the next fill / page load.
  async function setSetting(key, value) {
    const data = await get([STORAGE_KEYS.settings]);
    const s = data[STORAGE_KEYS.settings] || {};
    s[key] = value;
    await set({ [STORAGE_KEYS.settings]: s });
  }

  function isJobApplicationPage() {
    if (globalThis.TvarinAPI && typeof globalThis.TvarinAPI.isJobPage === "function") {
      return globalThis.TvarinAPI.isJobPage();
    }
    return false;
  }

  async function maybeAutoOpen() {
    if (!isJobApplicationPage()) return;
    const url = location.href.split("#")[0];
    if (autoOpenedForUrl === url) return;
    autoOpenedForUrl = url;
    ensure();
    render();
    // Respect the "Open automatically on job pages" setting (default on). When
    // off, the edge tab still mounts above — it just doesn't slide open.
    const data = await get([STORAGE_KEYS.settings]);
    if ((data[STORAGE_KEYS.settings] || {}).autoOpen === false) return;
    // Slight delay so the page paints first, then slide in.
    setTimeout(() => setOpen(true), 420);
  }

  /* ----- Edge tab (the "bubble"): dismiss on this page + drag to reposition ----- */

  let bubbleDismissed = false; // hidden by the × for this page load (not global)
  let tabTopFraction = null; // remembered vertical position, as a fraction of vh
  let tabPosLoaded = false; // whether we've read tvarin.ui yet this session
  let tabDragMoved = false; // set during a drag, to suppress the open-on-click
  let hiddenSites = []; // cached tvarin.hiddenSites — sites the bubble stays hidden on
  let tabMenuOpen = false; // the little × dropdown (hide options)

  function currentHost() {
    return location.hostname.replace(/^www\./, "");
  }

  function setupTab(tabEl) {
    if (!tabEl) return;
    tabEl.addEventListener("click", () => {
      if (tabDragMoved) return; // a drag just ended — don't also open
      setOpen(true);
    });
    tabEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
    });
    const closeBtn = tabEl.querySelector(".tab__close");
    const menuEl = tabEl.querySelector(".tab-menu");
    if (closeBtn) {
      // A press on × must neither start a drag nor open the panel.
      closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (tabMenuOpen) closeTabMenu();
        else openTabMenu(menuEl);
      });
    }
    if (menuEl) {
      menuEl.addEventListener("mousedown", (e) => e.stopPropagation());
      menuEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const btn = e.target.closest("[data-menu]");
        if (!btn) return;
        const which = btn.getAttribute("data-menu");
        closeTabMenu();
        if (which === "hide-visit") dismissBubble();
        else if (which === "hide-site") hideOnThisSite();
      });
    }
    initTabDrag(tabEl);
    positionTab(tabEl);
  }

  function initTabDrag(tabEl) {
    let startY = 0;
    let startTop = 0;
    let dragging = false;
    const onMove = (e) => {
      const dy = e.clientY - startY;
      if (!dragging && Math.abs(dy) < 4) return; // tolerate a jittery click
      dragging = true;
      tabDragMoved = true;
      tabEl.classList.add("tab--dragging");
      const h = tabEl.offsetHeight || 58;
      const vh = window.innerHeight || 800;
      const top = Math.max(8, Math.min(vh - h - 8, startTop + dy));
      tabEl.style.top = `${top}px`;
      e.preventDefault(); // stop the page selecting text mid-drag
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      tabEl.classList.remove("tab--dragging");
      if (dragging) {
        saveTabPosition(tabEl);
        // The click that fires right after mouseup must still see
        // tabDragMoved=true; clear it next tick so the next real click opens.
        setTimeout(() => {
          tabDragMoved = false;
        }, 0);
      } else {
        tabDragMoved = false;
      }
      dragging = false;
    };
    tabEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // Only the grip drags — the rest of the tab is click-to-open.
      if (!e.target.closest(".tab__grip")) return;
      startY = e.clientY;
      startTop = tabEl.getBoundingClientRect().top;
      dragging = false;
      tabDragMoved = false;
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
  }

  // Place the tab at its remembered vertical position (reads tvarin.ui once).
  function positionTab(tabEl) {
    if (!tabPosLoaded) {
      get([STORAGE_KEYS.ui]).then((data) => {
        tabPosLoaded = true;
        const ui = data[STORAGE_KEYS.ui] || {};
        if (typeof ui.tabTopFraction === "number") tabTopFraction = ui.tabTopFraction;
        placeTab(tabEl);
      });
      return;
    }
    placeTab(tabEl);
  }

  function placeTab(tabEl) {
    if (!tabEl || tabTopFraction == null) return; // null → keep the CSS default
    const h = tabEl.offsetHeight || 88;
    const vh = window.innerHeight || 800;
    const top = Math.max(8, Math.min(vh - h - 8, tabTopFraction * vh));
    tabEl.style.top = `${top}px`;
  }

  function saveTabPosition(tabEl) {
    const vh = window.innerHeight || 1;
    const styled = parseFloat(tabEl.style.top);
    const px = Number.isFinite(styled) ? styled : tabEl.getBoundingClientRect().top;
    tabTopFraction = Math.max(0, Math.min(1, px / vh));
    set({ [STORAGE_KEYS.ui]: { tabTopFraction } });
  }

  // Hide the bubble for THIS page load only. It returns on the next job page, a
  // reload, or the toolbar icon — never a global "off for all pages".
  function dismissBubble() {
    bubbleDismissed = true;
    unmount();
  }

  // Persistently hide the bubble on the current host. Managed (and undone) from
  // the "Hidden sites" list in Settings, so it's never a one-way trap.
  function hideOnThisSite() {
    const host = currentHost();
    if (!hiddenSites.includes(host)) hiddenSites = [...hiddenSites, host];
    set({ [STORAGE_KEYS.hiddenSites]: hiddenSites }); // cache updated above, sync
    unmount();
  }

  async function unhideSite(host) {
    hiddenSites = hiddenSites.filter((h) => h !== host);
    await set({ [STORAGE_KEYS.hiddenSites]: hiddenSites });
    await renderSettings();
    // If we're on that host right now, bring the bubble back.
    mountIfNeeded();
  }

  const onDocCloseMenu = () => closeTabMenu();
  const onEscCloseMenu = (e) => {
    if (e.key === "Escape") closeTabMenu();
  };

  function openTabMenu(menuEl) {
    if (!menuEl) return;
    menuEl.hidden = false;
    tabMenuOpen = true;
    // Defer so the click that opened it doesn't immediately close it.
    setTimeout(() => document.addEventListener("click", onDocCloseMenu), 0);
    document.addEventListener("keydown", onEscCloseMenu, true);
  }

  function closeTabMenu() {
    tabMenuOpen = false;
    const menuEl = root && root.querySelector(".tab-menu");
    if (menuEl) menuEl.hidden = true;
    document.removeEventListener("click", onDocCloseMenu);
    document.removeEventListener("keydown", onEscCloseMenu, true);
  }

  function unmount() {
    stopProgressPolling();
    open = false;
    clearPagePush({ immediate: true });
    if (host) {
      host.remove();
      host = null;
      root = null;
    }
    const leftover = document.getElementById(HOST_ID);
    if (leftover) leftover.remove();
  }

  function mountIfNeeded() {
    if (bubbleDismissed) return; // user hid the bubble on this page (× on the tab)
    if (hiddenSites.includes(currentHost())) {
      unmount();
      return; // user chose "Hide on this site" — stays hidden until un-hidden in Settings
    }
    // Only show the edge tab on job / application pages — not Instagram, YouTube, etc.
    if (!isJobApplicationPage()) {
      unmount();
      return;
    }
    ensure();
    render();
    maybeAutoOpen();
  }

  function watchHostSurvival() {
    // Some sites/extensions strip unknown nodes — put ours back (job pages only).
    const mo = new MutationObserver(() => {
      if (bubbleDismissed) return;
      if (hiddenSites.includes(currentHost())) return;
      if (!isJobApplicationPage()) return;
      if (host && !host.isConnected) {
        root = null;
        host = null;
        const wasOpen = open;
        ensure();
        render();
        if (wasOpen) setOpen(true);
      }
    });
    mo.observe(document.documentElement, { childList: true });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "TVARIN_TOGGLE_SIDEBAR") {
      // Explicit toolbar click — allowed on any page, and re-summons a dismissed bubble.
      bubbleDismissed = false;
      ensure();
      render();
      toggle();
      sendResponse({ ok: true, open, host: !!(host && host.isConnected) });
      return true;
    }
    if (msg.type === "TVARIN_OPEN_SIDEBAR") {
      bubbleDismissed = false;
      ensure();
      render();
      setOpen(true);
      sendResponse({ ok: true, open: true });
      return true;
    }
    if (msg.type === "TVARIN_PING") {
      sendResponse({ ok: true, open, hasHost: !!(host && host.isConnected) });
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      changes[STORAGE_KEYS.profile] ||
      changes[STORAGE_KEYS.applications] ||
      changes[STORAGE_KEYS.bookmarks] ||
      changes[STORAGE_KEYS.resume] ||
      changes[STORAGE_KEYS.session]
    ) {
      if (host) render();
    }
    // Keep the open bookmarks list live on any change — a sync pull, another
    // tab, or a note save (which only writes on blur, so re-rendering can't
    // interrupt typing).
    if (changes[STORAGE_KEYS.bookmarks] && host) renderBookmarks();
    // Hidden-sites list changed (e.g. un-hidden in another tab) — re-decide.
    if (changes[STORAGE_KEYS.hiddenSites]) {
      hiddenSites = Array.isArray(changes[STORAGE_KEYS.hiddenSites].newValue)
        ? changes[STORAGE_KEYS.hiddenSites].newValue
        : [];
      mountIfNeeded();
    }
  });

  // SPA / soft navigations on ATS sites. Two triggers:
  //   1. the URL changed (classic soft nav) — re-decide immediately, and
  //   2. the URL is the same but the job verdict flipped — an SPA (Oracle CX,
  //      etc.) that renders its form after document_idle without a URL change.
  //      We only re-scan for a short window after each navigation so we're not
  //      running isJobApplicationPage()'s DOM scan on every page forever.
  const RECHECK_TICKS = 8; // ~10s at the 1200ms interval
  let lastHref = location.href;
  let recheckTicks = RECHECK_TICKS;
  let lastVerdict = isJobApplicationPage();
  const checkNav = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      autoOpenedForUrl = "";
      bubbleDismissed = false; // a new page — the bubble comes back
      recheckTicks = RECHECK_TICKS;
      mountIfNeeded();
      lastVerdict = isJobApplicationPage();
      return;
    }
    if (recheckTicks > 0) {
      recheckTicks--;
      const verdict = isJobApplicationPage();
      if (verdict !== lastVerdict) {
        lastVerdict = verdict;
        mountIfNeeded();
      }
    }
  };
  setInterval(checkNav, 1200);
  window.addEventListener("popstate", checkNav);
  window.addEventListener("resize", onViewportResize);

  // Wait briefly for content.js to publish TvarinAPI, then decide.
  const boot = () => {
    // Load the hidden-sites list before the first mount so we never flash the
    // bubble on a site the user chose to hide.
    get([STORAGE_KEYS.hiddenSites]).then((d) => {
      hiddenSites = Array.isArray(d[STORAGE_KEYS.hiddenSites]) ? d[STORAGE_KEYS.hiddenSites] : [];
      mountIfNeeded();
      watchHostSurvival();
      // If API wasn't ready, retry once.
      if (!globalThis.TvarinAPI) {
        setTimeout(mountIfNeeded, 300);
      }
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
