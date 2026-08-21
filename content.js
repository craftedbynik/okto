// Multi-Select Copy — content script.
//
// Hold Cmd (Mac) / Ctrl (Windows) and make normal mouse selections: each one is
// captured as a Range and painted via the CSS Custom Highlight API. Cmd/Ctrl+C
// copies every captured chunk, joined with blank lines, in the order they were
// selected. Escape or a plain click clears everything.
//
// The tracked `selections` array is the single source of truth at copy time —
// window.getSelection() is never read there, because the native Selection only
// holds one range in Chrome (the "only copies the last selection" bug in other
// extensions).
(() => {
  'use strict';

  // Highlight API is required for the visuals; without it the whole feature
  // would be invisible-but-active, which is worse than absent. No-op instead.
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  // Singleton guard on the DOM, not `window`: the page world and a content
  // script's isolated world have separate globals but share the document. A
  // page that embeds this script (the onboarding page opened via file://)
  // must not end up with two competing instances.
  const GUARD_ATTR = 'data-okto-active';
  if (document.documentElement.hasAttribute(GUARD_ATTR)) return;
  document.documentElement.setAttribute(GUARD_ATTR, '');
  window.__multiSelectCopyLoaded = true;

  const HIGHLIGHT_NAME = 'multi-select-copy';
  const FLASH_NAME = 'multi-select-copy-flash';
  const JOINER = '\n\n';
  const FLASH_MS = 280;
  const COPIED_VIEW_MS = 1300;
  const MERGE_GAP_CHARS = 2; // selections this close to a chunk join it

  const isMac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /**
   * @type {{range: Range, idx: number}[]} Source of truth. Order = order the
   * user selected them in; idx picks the selection's color from the palette.
   */
  const selections = [];
  let colorCounter = 0;

  // One hue per selection, cycling. Same L/C across hues so every color reads
  // as equally vivid and text stays legible over any of them.
  const PALETTE_HUES = [85, 25, 320, 260, 200, 150];
  const highlights = PALETTE_HUES.map(() => new Highlight());
  const flashHighlights = PALETTE_HUES.map(() => new Highlight());
  highlights.forEach((h, i) => {
    h.priority = 1;
    CSS.highlights.set(`${HIGHLIGHT_NAME}-${i}`, h);
  });
  // Flash paints on top of the base highlight during copy feedback.
  flashHighlights.forEach((h, i) => {
    h.priority = 2;
    CSS.highlights.set(`${FLASH_NAME}-${i}`, h);
  });

  // adoptedStyleSheets sidesteps page CSP, which can block injected <style> —
  // but constructed sheets can throw in a content-script isolated world, so
  // fall back to a <style> element (extension-inserted styles work in practice
  // even on CSP-strict pages).
  function installStyles(cssText, target) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = cssText;
      (target === document ? document.documentElement : target).appendChild(style);
    }
  }

  installStyles(PALETTE_HUES.map((hue, i) => `
    ::highlight(${HIGHLIGHT_NAME}-${i}) {
      background-color: oklch(0.86 0.14 ${hue} / 0.45);
    }
    ::highlight(${FLASH_NAME}-${i}) {
      background-color: oklch(0.87 0.19 ${hue} / 0.85);
      color: oklch(0.25 0.06 ${hue});
    }
  `).join(''), document);

  // ---------------------------------------------------------------- editable guards

  // Inputs, textareas and contenteditable surfaces are never touched: no
  // capture inside them, no copy interception while they have focus. This is
  // the fix for the "breaks typing in ChatGPT/Notion/Gmail" class of bugs.
  function isEditableContext(node) {
    if (!node) return false;
    const el = node instanceof Element ? node : node.parentElement;
    return !!el && !!el.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    );
  }

  // ---------------------------------------------------------------- range helpers

  // True when the two ranges share any text (touching end-to-start doesn't
  // count). Per the DOM spec, END_TO_START compares this.start to other.end
  // and START_TO_END compares this.end to other.start.
  function overlaps(a, b) {
    try {
      return a.compareBoundaryPoints(Range.END_TO_START, b) < 0 &&
             a.compareBoundaryPoints(Range.START_TO_END, b) > 0;
    } catch {
      return false;
    }
  }

  // Characters of text between two non-overlapping ranges, in document order.
  // Infinity when a block boundary sits between them (never merge across
  // paragraphs) or when they can't be compared.
  function gapChars(a, b) {
    try {
      const aFirst = a.compareBoundaryPoints(Range.START_TO_START, b) <= 0;
      const first = aFirst ? a : b;
      const second = aFirst ? b : a;
      const gap = document.createRange();
      gap.setStart(first.endContainer, first.endOffset);
      gap.setEnd(second.startContainer, second.startOffset);
      if (gap.collapsed) return 0;
      const text = rangeToText(gap);
      return text.includes('\n') ? Infinity : text.length;
    } catch {
      return Infinity;
    }
  }

  function unionRange(ranges) {
    const u = ranges[0].cloneRange();
    for (const r of ranges.slice(1)) {
      if (r.compareBoundaryPoints(Range.START_TO_START, u) < 0) u.setStart(r.startContainer, r.startOffset);
      if (r.compareBoundaryPoints(Range.END_TO_END, u) > 0) u.setEnd(r.endContainer, r.endOffset);
    }
    return u;
  }

  function containsRange(outer, inner) {
    try {
      return outer.compareBoundaryPoints(Range.START_TO_START, inner) <= 0 &&
             outer.compareBoundaryPoints(Range.END_TO_END, inner) >= 0;
    } catch {
      return false;
    }
  }

  // Range.toString() drops line breaks at block boundaries; Selection.toString()
  // preserves them. Briefly route the range through the (empty) native selection
  // to get layout-aware text. Synchronous, so nothing ever paints.
  function rangeToText(range) {
    const sel = window.getSelection();
    if (!sel) return range.toString();
    const saved = [];
    for (let i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i).cloneRange());
    sel.removeAllRanges();
    sel.addRange(range);
    const text = sel.toString();
    sel.removeAllRanges();
    for (const r of saved) sel.addRange(r);
    return text;
  }

  // Drop chunks whose DOM was removed underneath them (their Range collapses).
  // Returns true when anything changed so the HUD can be refreshed.
  function pruneDead() {
    let changed = false;
    for (let i = selections.length - 1; i >= 0; i--) {
      const { range, idx } = selections[i];
      if (range.collapsed) {
        highlights[idx].delete(range);
        selections.splice(i, 1);
        changed = true;
      }
    }
    return changed;
  }

  function collectParts() {
    if (pruneDead()) updateHud(false);

    const ranges = selections.map((s) => s.range);
    // A live native selection that isn't part of the set (keyboard-extended,
    // for instance) is visibly selected, so it copies too.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const live = sel.getRangeAt(0).cloneRange();
      if (!isEditableContext(live.commonAncestorContainer) &&
          !ranges.some((r) => overlaps(r, live))) {
        ranges.push(live);
      }
    }

    // Clipboard order = document order, regardless of the order the user
    // selected in. compareBoundaryPoints throws for ranges in different
    // roots — treat those as equal and leave their relative order alone.
    ranges.sort((a, b) => {
      try {
        return a.compareBoundaryPoints(Range.START_TO_START, b);
      } catch {
        return 0;
      }
    });
    const parts = [];
    for (const range of ranges) {
      // Triple-click selections carry the paragraph's trailing break; the
      // joiner already separates chunks, so strip edge newlines only.
      const text = rangeToText(range).replace(/^\n+|\n+$/g, '');
      if (text !== '') parts.push(text);
    }
    return parts;
  }

  // ---------------------------------------------------------------- capture

  function captureCurrentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0).cloneRange();
    if (range.collapsed || isEditableContext(range.commonAncestorContainer)) return;

    // 1. Re-selecting inside an existing chunk toggles it off.
    const inside = selections.filter((s) => containsRange(s.range, range));
    if (inside.length > 0) {
      for (const hit of inside) {
        highlights[hit.idx].delete(hit.range);
        selections.splice(selections.indexOf(hit), 1);
      }
      sel.removeAllRanges();
      updateHud(false);
      return;
    }

    // 2. Reaching past a chunk's edge, or landing within a couple of characters
    //    of one, means "extend it": merge into one range, keep its color. A
    //    selection bridging two chunks merges all three. (A triple-click
    //    paragraph swallowing a double-clicked word is just this case.)
    const near = selections.filter(
      (s) => overlaps(s.range, range) || gapChars(s.range, range) <= MERGE_GAP_CHARS
    );
    if (near.length > 0) {
      const merged = unionRange([range, ...near.map((s) => s.range)]);
      const keep = near[0];
      for (const hit of near) {
        highlights[hit.idx].delete(hit.range);
        if (hit !== keep) selections.splice(selections.indexOf(hit), 1);
      }
      keep.range = merged;
      highlights[keep.idx].add(merged);
      sel.removeAllRanges();
      updateHud(true);
      return;
    }

    // 3. Brand-new chunk.
    const idx = colorCounter++ % PALETTE_HUES.length;
    selections.push({ range, idx });
    highlights[idx].add(range);
    // Our highlight takes over; leaving the native selection would double-paint.
    sel.removeAllRanges();
    updateHud(true);
  }

  function clearAll() {
    if (selections.length === 0) return;
    selections.length = 0;
    colorCounter = 0; // rainbow restarts with the next batch
    for (const h of highlights) h.clear();
    for (const h of flashHighlights) h.clear();
    updateHud(false);
    watchDom(false);
  }

  // Pages re-render under selections (SPAs, live feeds). Watch the DOM only
  // while a multi-selection exists, so idle pages pay nothing.
  let domObserver = null;
  let pruneTimer = 0;
  function watchDom(on) {
    if (on && !domObserver) {
      domObserver = new MutationObserver(() => {
        clearTimeout(pruneTimer);
        pruneTimer = setTimeout(() => {
          if (pruneDead()) updateHud(false);
          if (selections.length === 0) watchDom(false);
        }, 100);
      });
      domObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } else if (!on && domObserver) {
      domObserver.disconnect();
      domObserver = null;
      clearTimeout(pruneTimer);
    }
  }

  // ---------------------------------------------------------------- copy

  let copiedTimer = 0;

  async function copySelections() {
    const parts = collectParts();
    if (parts.length === 0) return;
    const text = parts.join(JOINER);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      legacyCopy(text);
    }
    flashFeedback();
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    (document.body || document.documentElement).appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  function flashFeedback() {
    for (const { range, idx } of selections) flashHighlights[idx].add(range);
    setTimeout(() => {
      for (const h of flashHighlights) h.clear();
    }, FLASH_MS);
    showCopied();
  }

  // ---------------------------------------------------------------- events

  // Capture phase throughout, so stopPropagation-happy sites can't starve us.
  // Nothing below ever calls preventDefault except Cmd/Ctrl+C with an active
  // multi-selection outside editable surfaces.

  document.addEventListener('mouseup', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (isEditableContext(e.target)) return;
    // Selection isn't final until the browser's default mouseup work runs
    // (double/triple-click included) — capture on the next tick.
    setTimeout(captureCurrentSelection, 0);
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (e.metaKey || e.ctrlKey) return;
    if (e.button !== 0) return; // right-click must not nuke the selection set
    clearAll();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) {
      if (e.key === 'Escape') clearAll();
      return;
    }
    if (selections.length === 0) return;
    if (isEditableContext(e.target) || isEditableContext(document.activeElement)) return;

    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    // Cmd/Ctrl+A means "start over with everything" — stale chunks would make
    // the next copy silently ignore the select-all.
    if (key === 'a') {
      clearAll();
      return;
    }
    if (key !== 'c' || e.shiftKey || e.altKey) return;
    e.preventDefault(); // suppress native copy of the (empty) selection
    copySelections();
  }, true);

  // Backup path for copies not initiated via keyboard (menu bar, context menu).
  document.addEventListener('copy', (e) => {
    if (selections.length === 0) return;
    if (isEditableContext(e.target)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // live native selection wins
    const parts = collectParts();
    if (parts.length === 0 || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', parts.join(JOINER));
    flashFeedback();
  }, true);

  // ---------------------------------------------------------------- HUD

  // A small status pill, created lazily on first capture so the extension adds
  // zero DOM to pages where it's never used. Lives in a closed shadow root so
  // page CSS can't restyle it (and ours can't leak out).

  let hud = null;

  function buildHud() {
    const host = document.createElement('div');
    // Inline + !important so page stylesheets can't reposition or hide the host.
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'left: 0',
      'right: 0',
      'bottom: max(28px, env(safe-area-inset-bottom, 0px))',
      'display: flex',
      'justify-content: center',
      'pointer-events: none',
      'z-index: 2147483647',
    ].map((d) => d + ' !important').join(';');

    const root = host.attachShadow({ mode: 'closed' });
    installStyles(`
      .wrap {
        position: relative;
        display: flex;
      }
      /* origin pinned to the count chip's center (8px padding + 11px radius) */
      .ripple-layer {
        position: absolute;
        left: 19px;
        top: 50%;
        width: 0;
        height: 0;
        pointer-events: none;
      }
      .ripple {
        position: absolute;
        left: -60px;
        top: -60px;
        width: 120px;
        height: 120px;
        border-radius: 50%;
        background: radial-gradient(circle closest-side,
          transparent 38%, var(--rc) 54%, transparent 74%);
        will-change: transform, opacity;
      }
      .pill {
        position: relative;
        display: grid;
        align-items: center;
        /* left padding matches top/bottom so the count chip sits concentric */
        padding: 8px 14px 8px 8px;
        border-radius: 999px;
        background: oklch(0.24 0.025 var(--h, 260) / 0.9);
        backdrop-filter: blur(12px) saturate(1.3);
        -webkit-backdrop-filter: blur(12px) saturate(1.3);
        box-shadow:
          inset 0 0 0 1px oklch(1 0 0 / 0.07),
          0 1px 1px oklch(0 0 0 / 0.25),
          0 6px 20px oklch(0 0 0 / 0.3);
        font: 500 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: oklch(0.985 0.002 260);
        -webkit-font-smoothing: antialiased;
        user-select: none;
        white-space: nowrap;
        opacity: 0;
        transform: translateY(8px) scale(0.96);
        transition-property: opacity, transform, background-color;
        transition-duration: 150ms, 150ms, 250ms;
        transition-timing-function: cubic-bezier(0.4, 0, 1, 1), cubic-bezier(0.4, 0, 1, 1), ease;
      }
      .pill[data-state="open"] {
        opacity: 1;
        transform: none;
        transition-duration: 200ms, 200ms, 250ms;
        transition-timing-function: cubic-bezier(0.23, 1, 0.32, 1), cubic-bezier(0.23, 1, 0.32, 1), ease;
      }
      .row {
        grid-area: 1 / 1;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        transition-property: opacity, filter;
        transition-duration: 180ms;
        transition-timing-function: ease;
      }
      .done { opacity: 0; filter: blur(2px); justify-content: center; }
      .pill[data-view="copied"] .main { opacity: 0; filter: blur(2px); }
      .pill[data-view="copied"] .done { opacity: 1; filter: none; }
      .chip {
        box-sizing: border-box;
        min-width: 22px;
        height: 22px;
        padding: 0 7px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: oklch(0.58 0.145 var(--h, 85));
        color: oklch(0.99 0.002 var(--h, 85));
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.04em;
        transition-property: background-color;
        transition-duration: 250ms;
        transition-timing-function: ease;
      }
      .sep { width: 1px; height: 15px; background: oklch(1 0 0 / 0.14); }
      .hint { display: inline-flex; align-items: center; gap: 6px; color: oklch(0.78 0.008 260); }
      kbd {
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        letter-spacing: 0.02em;
        padding: 3px 6px;
        border-radius: 5px;
        background: oklch(1 0 0 / 0.09);
        box-shadow: inset 0 0 0 1px oklch(1 0 0 / 0.08);
        color: oklch(0.9 0.005 260);
      }
      .check {
        width: 14px;
        height: 14px;
        stroke: oklch(0.8 0.16 150);
        stroke-width: 1.8;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      @media (prefers-reduced-motion: reduce) {
        .pill { transform: none; transition-property: opacity; }
        .row { transition-property: opacity; filter: none !important; }
      }
    `, root);

    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.dataset.state = 'closed';
    pill.dataset.view = 'count';
    pill.innerHTML = `
      <div class="row main">
        <span class="chip">0</span>
        <span class="label">selections</span>
        <span class="sep"></span>
        <span class="hint"><kbd>${isMac ? '⌘C' : 'Ctrl+C'}</kbd><span>to copy</span></span>
      </div>
      <div class="row done">
        <svg class="check" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6.5 4.8 9 10 3.5"></path>
        </svg>
        <span>Copied</span>
      </div>
    `;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const rippleLayer = document.createElement('div');
    rippleLayer.className = 'ripple-layer';
    wrap.appendChild(rippleLayer);
    wrap.appendChild(pill);
    root.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);

    return {
      host,
      pill,
      rippleLayer,
      chip: pill.querySelector('.chip'),
      label: pill.querySelector('.main .label'),
      check: pill.querySelector('.check'),
    };
  }

  function updateHud(pulse) {
    const count = selections.length;
    if (count === 0) {
      if (hud) hud.pill.dataset.state = 'closed';
      return;
    }
    watchDom(true);
    if (!hud) hud = buildHud();

    clearTimeout(copiedTimer);
    hud.pill.dataset.view = 'count';
    hud.pill.dataset.state = 'open';
    hud.chip.textContent = String(count);
    hud.label.textContent = count === 1 ? 'selection' : 'selections';
    // Tint chip and pill toward the latest selection's palette hue.
    const latest = selections[selections.length - 1];
    if (latest) hud.pill.style.setProperty('--h', String(PALETTE_HUES[latest.idx]));

    if (pulse && !reducedMotion.matches) {
      hud.chip.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.08)', offset: 0.4 },
          { transform: 'scale(1)' },
        ],
        { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
      );
      if (latest) spawnRipple(PALETTE_HUES[latest.idx]);
    }
  }

  // A soft ring in the selection's color that swells out from behind the pill
  // and dissipates. One element per capture: rapid selections layer waves
  // instead of restarting one, and each removes itself when done.
  function spawnRipple(hue) {
    if (!hud || hud.rippleLayer.childElementCount > 3) return;
    const ring = document.createElement('span');
    ring.className = 'ripple';
    ring.style.setProperty('--rc', `oklch(0.72 0.17 ${hue} / 0.9)`);
    hud.rippleLayer.appendChild(ring);
    const anim = ring.animate(
      [
        { transform: 'scale(0.35)', opacity: 0.5 },
        { transform: 'scale(1.5)', opacity: 0 },
      ],
      { duration: 420, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
    );
    anim.onfinish = () => ring.remove();
  }

  function showCopied() {
    if (!hud) return;
    hud.pill.dataset.view = 'copied';
    if (!reducedMotion.matches) {
      hud.check.animate(
        [
          { transform: 'scale(0.25)', opacity: 0, filter: 'blur(4px)' },
          { transform: 'scale(1)', opacity: 1, filter: 'blur(0px)' },
        ],
        { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      );
    }
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (hud && selections.length > 0) hud.pill.dataset.view = 'count';
    }, COPIED_VIEW_MS);
  }
})();
