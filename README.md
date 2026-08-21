# okto

Chrome extension (Manifest V3, formerly "Multi-Select Copy") for selecting multiple, non-contiguous chunks of text on a page and copying them all at once — in document order, joined with blank lines.

## Usage

1. Hold **⌘ (Mac) / Ctrl (Windows)** and select text with the mouse. Each selection is kept and highlighted — each in its own color from a rainbow palette; a status pill shows the count.
2. Repeat for as many chunks as you want, anywhere on the page.
3. Press **⌘C / Ctrl+C**. All chunks land on the clipboard in the order they appear on the page, separated by `\n\n`.
4. **Escape**, a plain click, or **⌘A / Ctrl+A** clears everything.

The extension is invisible until you hold the modifier key. With no multi-selection active it never touches events or the clipboard.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick this directory

Requires Chrome 111+ (CSS Custom Highlight API + `oklch()`).

## Architecture

Single content script ([content.js](content.js)), no background worker, no settings, no backend.

- **`selections: Range[]` is the single source of truth.** `window.getSelection()` is never read at copy time — Chrome's native `Selection` holds only one range, which is exactly the "only copies the last selection" bug in existing multi-select extensions.
- **CSS Custom Highlight API** (`Highlight` + `CSS.highlights.set()`) paints the captured ranges. No DOM wrapping, so no site-specific breakage and no layout mutation. Six registered highlights (one per palette hue, cycling) give each selection its own color; a matching higher-priority set provides the brief flash on copy. (`::highlight()` cannot render gradients — per-selection solid colors are the expressive ceiling of the API.)
- **Copy interception** happens on `keydown` (⌘C/Ctrl+C): `preventDefault()`, then the clipboard text is built from the tracked array, sorted into document order via `compareBoundaryPoints`. A `copy`-event listener covers menu-driven copies. Text per range is extracted layout-aware (block boundaries become newlines) by briefly routing each range through the empty native selection — synchronous, so nothing repaints.
- **Editable surfaces are never touched.** Capture, ⌘C, ⌘A and copy interception all skip `input`, `textarea`, `select` and `[contenteditable]` (via `closest()`), both by event target and by focused element. Typing/copying in ChatGPT, Notion, Gmail compose etc. stays fully native.
- **Both `metaKey` and `ctrlKey`** are accepted everywhere — no hardcoded platform.
- The HUD pill lives in a **closed shadow root** with inline `!important` host positioning; page CSS can't restyle it. It's created lazily on first capture, so unused pages get zero extra DOM. Styles use `adoptedStyleSheets`, which page CSP can't block.
- Feature detection: without `CSS.highlights` the script no-ops entirely.

### Small behaviors worth knowing

- Selecting **inside** an existing chunk deselects it (re-selecting a phrase toggles it off).
- Selecting within 2 characters of a chunk, or overlapping it while reaching past its edge, **merges** into that chunk (union range, same color). A selection bridging two chunks merges all three. Never merges across a paragraph break. A triple-click paragraph swallowing a double-clicked word is just this merge.
- Ranges are live; chunks whose DOM was removed collapse and are pruned (a MutationObserver runs only while a multi-selection exists, so the count stays honest on SPAs and live feeds).
- A live native selection present at copy time (e.g. keyboard-extended) is copied along with the set — what's visibly selected is what you get.
- Leading/trailing newlines are stripped per chunk (triple-click paragraphs carry the trailing break); `<pre>` whitespace inside a chunk is preserved.
- ⌘A clears the multi-selection so a following ⌘C copies the whole page natively, as the user expects.
- Right-click does **not** clear the selection set (context menu stays usable).
- `prefers-reduced-motion` disables all transform/blur motion in the HUD.

## Verified (2026-08-21, real browser)

- 3 non-contiguous chunks selected in non-DOM order → clipboard in document order (OS clipboard, real ⌘C keypress)
- Multi-line chunk across `<br>` → newline preserved (`Line one…\nLine two…`), `Range.toString()` would have lost it
- Ctrl-key capture path (Windows modifier) captures identically to ⌘
- Capture inside contenteditable rejected; typing there with multi-selections active works; focused-editable ⌘C is left to the native handler (no `preventDefault`)
- Escape / plain click / ⌘A each clear selections and close the HUD
- Superset replacement, exact-dupe skip, copied-state HUD flow (`count → copied → count`), highlight flash on copy

## Test page

`test/test-page.html` — paragraphs, multi-line block, contenteditable, input/textarea. Serve the repo root (`python3 -m http.server`) and open it; it loads `content.js` via a script tag so the logic can be exercised without installing the extension. `#debug` in the URL exposes shadow roots for automated assertions.

## Known limitations (v1)

- Menu-bar/context-menu copy relies on the `copy` event actually firing; since the native selection is empty while a multi-selection is active, Chrome may not offer Copy there — keyboard copy is the primary path.
- Overlapping (non-identical, non-superset) selections are copied as-is, including the overlap.
- In iframes each frame keeps its own independent selection set (content script runs per-frame).
- Join separator is fixed at `\n\n`; clipboard order is fixed at document order. Both are deliberate v1 scope choices.
