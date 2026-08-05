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
    resume: "tvarin.resume",
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
      width: 36px;
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
      width: 36px;
      height: 88px;
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
    }
    .tab:hover { filter: brightness(1.05); }
    .tab svg { width: 18px; height: 18px; }
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
      border: 1px solid #2f6fed;
      border-radius: 12px;
      padding: 12px 16px;
      background: #ffffff;
      color: #2f6fed;
      font-family: inherit;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn-match:hover { background: #eaf2ff; }
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
  const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2m-3.5-6.5-1.4 1.4M6.9 17.1l-1.4 1.4m0-12.6 1.4 1.4m10.2 10.2 1.4 1.4"/></svg>`;
  const COLLAPSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
  const USER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 19c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/></svg>`;
  const DOC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 3h7l4 4v14H7V3z"/><path d="M14 3v5h5"/></svg>`;
  const CHEV_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
  const CHEV_UP_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg>`;
  const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5L19 7"/></svg>`;
  const BACK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>`;
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
        <button class="tab" type="button" title="Open Tvarin" aria-label="Open Tvarin">${MARK_SVG}</button>
        <aside class="panel" role="complementary" aria-label="Tvarin">
          <header class="head">
            <div class="brand">
              <span class="brand__mark">${MARK_SVG}</span>
              <span>Tvarin</span>
            </div>
            <div class="head__actions">
              <button class="icon-btn" type="button" data-action="profile" title="Profile & settings" aria-label="Profile & settings">${GEAR_SVG}</button>
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
                <p class="card__sub">Apply in seconds from your saved profile</p>
                <p class="result" data-el="result" aria-live="polite"></p>
              </div>
            </div>
            <div class="card match-card" data-el="match-card" hidden>
              <button class="btn-match" type="button" data-action="match" data-el="match-btn">Check job match</button>
              <p class="card__sub">How your resume matches this job</p>
              <div class="match" data-el="match-result" hidden></div>
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

    root.querySelector(".tab").addEventListener("click", () => setOpen(true));
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

    // Status dropdowns in the tracker (change doesn't bubble through click).
    root.querySelector(".panel").addEventListener("change", async (e) => {
      const sel = e.target.closest("select.app-status");
      if (!sel) return;
      await setAppStatus(sel.getAttribute("data-app-ts"), sel.value);
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

  function applyAuthUi() {
    if (!root) return;
    const gate = root.querySelector('[data-el="login-gate"]');
    const ready = root.querySelector('[data-el="fill-ready"]');
    const matchCard = root.querySelector('[data-el="match-card"]');
    if (gate) gate.hidden = signedIn;
    if (ready) ready.hidden = !signedIn;
    if (matchCard) matchCard.hidden = !signedIn;
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
      STORAGE_KEYS.resume,
    ]);
    const profile = data[STORAGE_KEYS.profile];
    const apps = data[STORAGE_KEYS.applications] || [];
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

  function isJobApplicationPage() {
    if (globalThis.TvarinAPI && typeof globalThis.TvarinAPI.isJobPage === "function") {
      return globalThis.TvarinAPI.isJobPage();
    }
    return false;
  }

  function maybeAutoOpen() {
    if (!isJobApplicationPage()) return;
    const url = location.href.split("#")[0];
    if (autoOpenedForUrl === url) return;
    autoOpenedForUrl = url;
    ensure();
    render();
    // Slight delay so the page paints first, then slide in.
    setTimeout(() => setOpen(true), 420);
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
      // Explicit toolbar click — allowed on any page.
      ensure();
      render();
      toggle();
      sendResponse({ ok: true, open, host: !!(host && host.isConnected) });
      return true;
    }
    if (msg.type === "TVARIN_OPEN_SIDEBAR") {
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
      changes[STORAGE_KEYS.resume] ||
      changes[STORAGE_KEYS.session]
    ) {
      if (host) render();
    }
  });

  // SPA / soft navigations on ATS sites
  let lastHref = location.href;
  const checkNav = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      autoOpenedForUrl = "";
      mountIfNeeded();
    }
  };
  setInterval(checkNav, 1200);
  window.addEventListener("popstate", checkNav);
  window.addEventListener("resize", onViewportResize);

  // Wait briefly for content.js to publish TvarinAPI, then decide.
  const boot = () => {
    mountIfNeeded();
    watchHostSurvival();
    // If API wasn't ready, retry once.
    if (!globalThis.TvarinAPI) {
      setTimeout(mountIfNeeded, 300);
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
