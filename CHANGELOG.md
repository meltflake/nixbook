# NixBook — Architecture & Changelog

## Architecture Overview

### Files
| File | Purpose |
|------|---------|
| `index.html` | Homepage: book shelf, add books, translation trigger, settings, Dropbox sync |
| `reader.html` | EPUB reader: paginated reading, word lookup, highlights, translation display |
| `db.js` | IndexedDB wrapper (v4): stores books, vocabulary, highlights, translations |
| `sync.js` | Dropbox sync: merge logic, push/pull, book file sync, translation sync |
| `dropbox.js` | Dropbox API: OAuth PKCE, upload/download data/books/translations |
| `theme.js` | Theme state: light/dark/eink cycle, stored in localStorage |
| `theme.css` | Solarized color scheme + eink theme, JetBrains Mono font |
| `sw.js` | Service Worker: network-first (dev mode, no caching) |
| `flashcards.html` | Flashcard review (SM-2 spaced repetition) |
| `highlights.html` | Highlights feed view with export |
| `translate.js` | Unused (translation moved inline to index.html) |
| `translate-worker.js` | Unused (translation moved inline to index.html) |
| `manifest.json` | PWA manifest |

### Key Dependencies (CDN)
- **foliate-js**: EPUB parsing & rendering (`cdn.jsdelivr.net/gh/johnfactotum/foliate-js@main/`)
- **zip.js**: ZIP extraction for EPUB files (`cdn.jsdelivr.net/npm/@zip.js/zip.js/+esm`)
- **Cloudflare Worker**: Translation proxy at `nixbook.wulujia.workers.dev`

### Data Storage
- **IndexedDB** (`epub-reader` v4): books, vocabulary, highlights, translations
- **localStorage keys**:
  - `epub-reader-theme`: light/dark/eink
  - `reader-font-size`: number (default 16)
  - `translation-queue`: JSON object of queued translation tasks per bookId
  - `translation-complete`: JSON object of completed books
  - `paragraph-counts`: JSON object of unique hash counts per bookId
  - `showTranslations_{bookId}`: boolean per book

### Translation
- Model: `claude-3-5-haiku-20241022` (via Cloudflare Worker proxy)
- Batch size: 10 paragraphs per API call
- Paragraph filtering: text.length >= 10, no Chinese characters
- Hash: simple string hash → base36 (shared between db.js and index.html)
- Completion: based on unique hash count (not total paragraph count, since duplicates exist)

---

## reader.html — Interaction Design

### Layout (top to bottom)
1. **Toolbar** (sticky top): back button, book title, chapter label, translate toggle, theme toggle, TOC
2. **Reader container** (flex: 1): contains `<foliate-view>` with paginated flow
3. **Bottom bar** (hidden by default): progress slider + percentage

### Viewport Height (CRITICAL)
- Problem: Mobile browsers have dynamic chrome (address bar, bottom nav) that `100vh` doesn't account for
- Solution: Inline `<script>` sets `document.body.style.height = window.innerHeight + 'px'`
- Updates on `resize` and `visualViewport.resize` events
- The EPUB content also has `padding: 20px 20px 60px 20px` as extra bottom safety margin
- **DO NOT use CSS-only solutions** (`100vh`, `100dvh`, `calc(100% - Npx)`) — they are unreliable across mobile browsers

### Touch Interactions (Mobile)
- **Quick tap** (<300ms, <10px movement): Toggle toolbar visibility
  - Handled in `touchend` event on EPUB doc
  - `click` event on EPUB doc is **skipped** for touch devices (`if (isTouchDevice()) return`) to prevent double-fire
- **Horizontal swipe** (>80px): Page turn (left=next, right=prev)
  - Also in `touchend`, checked after tap
  - Skipped if text is selected
- **Long press**: Browser native text selection (we do NOT override this)
- **Selection complete**: Detected via `selectionchange` event (600ms debounce)
  - Single word → dictionary popup + save to vocabulary
  - Sentence → auto-highlight + save to highlights
  - After handling, `sel.removeAllRanges()` clears selection to dismiss browser's native toolbar

### Mouse Interactions (PC)
- **Click**: Toggle toolbar (unless text selected or link clicked)
  - Handled in `click` event, only for non-touch devices
- **Mouse selection + mouseup**: Same word/sentence handling as mobile
- **Keyboard**: Arrow keys for navigation, VolumeUp/Down mapped to page turn
- **Toolbar**: Visible by default on PC (hidden by default on mobile only)

### Dictionary Popup Positioning
- **Mobile**: Fixed at top center (`left: center, top: 60px`) — never blocked by browser toolbar
- **PC**: Near the selection, above the text (fallback to below if no room)

### Progress Sync
- Every `relocate` event (page turn): `saveBook()` → then `pushToDropbox()`
- `isSyncing` lock prevents concurrent syncs
- No debounce, no interval — immediate on every page turn

---

## sync.js — Merge Logic

### Full sync (`syncWithDropbox`)
1. Download remote data
2. Export local data
3. Merge (local-first for books)
4. Apply merged data to IndexedDB (books, vocabulary, highlights)
5. Upload merged data to Dropbox
6. Sync book files (upload missing, download missing)
7. Sync translations per book

### Book merge rule
- **Local wins by default** (local books added to map first)
- Remote only overwrites if `remote.lastReadAt > local.lastReadAt`
- File blob always preserved from local

### `applyMergedData`
- Vocabulary: `put` (upsert)
- Highlights: `clear` + `add` (full replace to avoid duplicate auto-increment IDs)
- Books: read existing → merge metadata (progress, lastLocation, lastReadAt) but **preserve local file blob and coverBlob**

### Quick push (`pushToDropbox`)
- Upload-only, no merge — used after page turns in reader.html

---

## index.html — Translation Badge Logic

### Badge priority (top to bottom, first match wins)
1. Active translation running → show status message
2. `translationCount >= totalParas` → "已翻译 N/N 段 ✓"
3. Queued task (not error) → "继续 N%"
4. Has translations + has file → show count + "继续翻译" button
5. Has translations, no file → show count only (can't resume)
6. Has file, no translations → "翻译" button

### `totalParas` sources (first non-null wins)
1. `localStorage` paragraph-counts
2. Queued task totalCount
3. Completed book count

### Translation resume
- Always re-parses EPUB (never trusts cached paragraph list from queue)
- Saves unique hash count (not total paragraph count)

---

## Known Issues / Technical Debt
1. `translate.js` and `translate-worker.js` are unused — translation logic is inline in `index.html`
2. `hashText()` is duplicated in both `db.js` and `index.html`
3. `formatAuthor()` in `index.html` has object-safe handling; `reader.html` line ~670 still uses raw `String(meta.author)` for non-array objects
4. Bottom bar `.bottom-bar` has `display: none` but is toggled via `bar-hidden` class — the bar is never actually shown because `display: none` takes precedence. Need to set `display: flex` when toolbar is visible.
5. E-ink theme disables ALL transitions/animations globally — may affect foliate-js page animation

---

## Changelog

### 2026-02-15

#### Batch 1: Core fixes
- Fixed zip.js CDN: UMD → ESM (`+esm` URL)
- Created `makeZipLoader(file)` for foliate-js EPUB class
- Fixed Dropbox token refresh (auto-refresh via `getValidAccessToken()`)
- Fixed translation progress display (total book progress, not remaining)

#### Batch 2: Translation persistence
- Persistent translation queue in `localStorage`
- Auto-resume `resumeQueuedTranslations()` on page load
- Translation completion marker in `localStorage`

#### Batch 3: Reader UX
- Fixed mouse click vs text selection conflict (track `mouseDownPos`/`isSelecting`)
- PC: keyboard-only navigation (no click navigation)
- Mobile: swipe gestures (>80px horizontal) + edge tap
- Changed font to Noto Sans SC Regular (wght@400)
- Changed link color to Solarized green (#859900)

#### Batch 4: Homepage redesign
- Redesigned card layout, header icons, drag & drop
- Added periodic sync (60s interval) + debounced sync (3s)
- Smart tab behavior (translation running → new tab)

#### Batch 5: Naming & themes
- Renamed to NixBook
- Added e-ink theme (light → dark → eink cycle)
- Mobile: increased swipe threshold to 80px
- Added `selectionchange` listener for mobile word lookup
- Dictionary popup positioned above selection

#### Batch 6: Bottom cutoff saga
- Tried `padding-bottom`, `env(safe-area-inset-bottom)`, `100dvh`, `calc(100% - 48px)`, `@media (pointer: coarse)` — all unreliable
- **Final solution**: JS `window.innerHeight` sets body height + 60px bottom padding in EPUB content

#### Batch 7: Toolbar toggle
- Problem: `click` and `touchend` both fired on mobile, causing double toggle
- Fix: `click` handler skips touch devices; only `touchend` handles tap on mobile

#### Batch 8: Translation fixes
- Fixed model name: `claude-3-5-haiku-20241022` (not `claude-haiku-4-5-20250929`)
- Always re-parse EPUB on resume (don't trust cached paragraphs)
- Save unique hash count as total (not duplicate paragraph count)
- Fixed `[object Object]` author display

#### Batch 9: Progress sync
- Changed from debounced (3s) to immediate sync on every page turn
- Fixed merge: local-first (local added to map first, remote only wins if genuinely newer)
- Fixed `applyMergedData` to write book metadata back to IndexedDB

#### Batch 10: Settings & native selection
- Settings panel: theme picker + font size
- Reader respects font size from settings
- Restored native text selection (removed `user-select: none`)
- `sel.removeAllRanges()` after handling to dismiss browser toolbar
- Extract cover and metadata on book add (not just on first read)

#### Batch 11: Progress sync robustness (2026-02-15)
- **Bug**: Progress reverts to old position after going back and re-entering reader
- **Root causes identified**:
  1. `applyMergedData` unconditionally overwrote local IndexedDB with merged data, even if local was updated between merge computation and apply
  2. `pushToDropbox` from reader.html was fire-and-forget — if page navigated before fetch completed, cloud stayed stale
  3. Back button (`location.href = 'index.html'`) didn't wait for save to complete
- **Fixes**:
  1. `applyMergedData` now re-checks local `lastReadAt` before overwriting — skips if local is newer than merged
  2. `syncWithDropbox` re-reads fresh local data AFTER apply, uploads that (not the merge result)
  3. Back button now `await`s pending save + does a final `saveBook` before navigating
  4. Added `visibilitychange` and `pagehide` handlers to save progress when user swipes back or switches apps
  5. Added `📚` prefixed logging to trace sync decisions
- **Key principle**: IndexedDB is source of truth. Cloud is a mirror. Never let cloud overwrite local unless cloud is strictly newer.

#### Batch 12: Cover extraction + translation completion sync (2026-02-15)
- **Bug 1**: Book covers not showing on homepage (new browser or after sync)
  - Root cause: `coverBlob` stored in IndexedDB only, not synced via Dropbox. New browsers have null coverBlob.
  - Fix: `renderBooks()` now detects missing covers and extracts them in background from the EPUB file. Card updates dynamically when cover is ready.
  - Added `extractCoverOnly(file)` — lightweight cover-only extraction (no metadata parsing overhead).
- **Bug 2**: Translation completion status not syncing across devices
  - Root cause: `isTranslationComplete()` and `totalParas` both stored in `localStorage` — per-browser, not synced.
  - Fix: `paragraphCount` now stored in book metadata (IndexedDB), included in `exportLocalData()`, synced via Dropbox.
  - On new browser: if `translationCount >= book.paragraphCount`, shows "已翻译 N/M 段 ✓" immediately.
  - If `paragraphCount` unknown but translations exist and file available, runs `countParagraphs(file)` in background to determine completion.
  - Backfill: localStorage paragraph counts automatically migrated to IndexedDB on render.
- **Key principle**: Any state that affects UI across devices must live in IndexedDB (synced), not localStorage (per-browser).

#### Batch 13: Critical fix — stale saveBook in async callbacks (2026-02-15)
- **Bug**: Batch 12 introduced `saveBook(book)` in async callbacks (cover extraction, paragraph counting). These callbacks captured `book` objects by closure from `renderBooks()`. When they resolved seconds later, `saveBook(book)` used `put()` which replaced the ENTIRE IndexedDB record — including `progress` and `lastLocation` — with stale data from when the book was first read.
- **Timeline of the bug**:
  1. `renderBooks()` reads book (progress=60%) → starts `extractCoverOnly()` async
  2. User clicks book → reader.html → reads to 70% → saves to IndexedDB
  3. `extractCoverOnly()` resolves → `saveBook(book)` writes back the T0 snapshot (progress=60%)
  4. User returns → reader reads 60% → progress reverted!
- **Fix**: All async callbacks now re-read the fresh record from IndexedDB via `getBook(bookId)` before saving, ensuring only the intended field (coverBlob, paragraphCount) is updated.
- **Rule**: NEVER do `saveBook(entireObject)` for partial field updates. Always re-read the latest record first.
- **Also added**: Diagnostic logging in reader.html to trace lastLocation at every key point.

#### Batch 14: localStorage progress backup + sync logging (2026-02-15)
- **New safety net**: reader.html backs up progress to localStorage on every page turn (`progress-backup-{bookId}`)
- On reader load: if localStorage backup has newer `lastReadAt` than IndexedDB, restores from backup before displaying
- **Tested with Playwright**: corrupted IndexedDB with stale data → reader correctly recovered from localStorage backup
- **sync.js hardened**: `applyMergedData` now uses STRICT greater-than (`>` not `>=`) for progress overwrites. Same-timestamp case only updates metadata (title, author, paragraphCount), never progress/lastLocation.
- **Comprehensive logging added**: every sync step logs with `📚 SYNC`, `📚 MERGE`, `📚 APPLY` prefixes, showing progress values and which side wins
- **Key insight from testing**: once IndexedDB has stale data, reader loads it and saves with new `lastReadAt`, creating a self-reinforcing loop. The localStorage backup breaks this loop.

#### Batch 15: Offline ECDICT dictionary (2026-02-15)
- **Replaced MyMemory API with offline dictionary**: 80,000 high-frequency English words from ECDICT
- Source: `skywind3000/ECDICT` (CC licensed), processed to compact JSON format
- Each entry: `word → [phonetic, translation]`, e.g. `"ephemeral": ["i'femәrәl", "a. 朝生暮死的, 短命的, 短暂的"]`
- **4.9MB JSON**, loaded async on reader init → instant lookup (in-memory hash map)
- Dictionary popup now shows **phonetic notation** (`/fəˈnetɪk/`) between word and translation
- Fallback: if word not in offline dict, tries MyMemory API (graceful degradation)
- **No network needed** for word lookup in normal reading

#### Batch 16: PC word lookup / toolbar toggle conflict (2026-02-15)
- **Bug**: On PC, selecting a word for dictionary lookup also triggered toolbar toggle
- **Root cause**: `handleSelection` calls `sel.removeAllRanges()` to dismiss browser native toolbar. The `click` event fires AFTER `mouseup`, and by that time the selection is empty, so the `sel.toString().length > 0` guard fails → toolbar toggles.
- **Fix**: Added `justHandledSelection` flag, set to `true` in `handleSelection`, checked and reset in `click` handler. Also:
  - `isSelecting` (mouse drag >5px) now blocks toolbar toggle
  - Clicking outside dict popup closes it without toggling toolbar
  - Clicking outside delete popup closes it without toggling toolbar

#### Batch 17: Vocabulary word underline (2026-02-15)
- **Feature**: Words looked up in dictionary now get a dotted underline in the text
- **Style**: `underline dotted #93a1a1` (Solarized base1 — lighter than sentence highlight's solid `#b58900`) with 1.5px thickness
- **On lookup**: Word is immediately underlined where selected + saved to vocabulary + added to in-memory cache
- **On page load**: `restoreVocabHighlights(doc)` scans all text nodes for vocabulary words (word-boundary matching) and applies the dotted underline
- **Cache**: `cachedVocabWords` (Set of lowercase words) loaded once from IndexedDB `vocabulary` store, updated live on new lookups
- **Skip logic**: Text nodes inside `.epub-highlight` or `.epub-vocab` spans are skipped to avoid double-decoration
- **Reverse-order application**: When multiple vocab words found in one text node, applied from end to start to preserve character offsets
- **CSS class**: `.epub-vocab` (vs `.epub-highlight` for sentence highlights)

#### Batch 18: Dict popup auto-dismiss (2026-02-15)
- **Bug**: On mobile, dictionary popup stayed visible after swiping, tapping, or turning pages — never auto-dismissed
- **Root cause**: `hideDict()` was only called on PC click-outside and explicit actions. No dismiss logic for touch gestures or page navigation.
- **Fixes**:
  - `relocate` event (any page turn): `hideDict()` at start of handler
  - Horizontal swipe (touchend): `hideDict()` before `goLeft()`/`goRight()`
  - Quick tap on mobile: if dict popup is visible, tap dismisses it (instead of toggling toolbar); second tap toggles toolbar as normal
