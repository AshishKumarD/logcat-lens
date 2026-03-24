# Logcat Lens — Performance Optimizations

## Data Flow Pipeline

```
ADB Process (spawn) → Node.js Backend (parse) → postMessage → Webview Frontend (buffer + render)
```

---

## Implemented Optimizations

### 1. Virtual Scrolling
**Impact: Critical | Files: `logcat.js`, `logcat.css`**

Only ~80-140 DOM `<entry>` elements exist at any time, regardless of buffer size (100K+). A `<div id="viewport">` with a computed height provides the scrollbar, and entries are absolutely positioned using `transform: translateY()`.

- `ROW_HEIGHT = 18px` (fixed) enables O(1) scroll-to-row calculation
- `OVERSCAN = 20` rows above/below viewport prevent blank flashes during fast scroll
- Display count is derived from `filteredIndices` (if active) or raw `buffer.length`

### 2. DOM Element Pooling
**Impact: High | File: `logcat.js`**

Entry elements are never destroyed — they're recycled via `_pool[]`. When a row scrolls out of view, its element is moved offscreen (`translateY(-9999px)`) and pushed to the pool. When a new row scrolls in, it pops from the pool instead of calling `createElement`.

- Eliminates GC pressure from constant create/destroy cycles
- Pool elements retain their child structure — `_updateEntry()` just sets `textContent` on existing children (no `innerHTML` re-parse)
- First render uses `innerHTML` via `_entryHTML()` only when children don't exist yet

### 3. GPU-Composited Positioning
**Impact: High | File: `logcat.js`**

Entries use `transform: translateY()` instead of `top` for positioning. Combined with `will-change: transform` and `contain: layout style paint` on each entry, this:
- Promotes entries to their own compositor layer
- Avoids triggering layout recalculation on position changes
- Keeps repositioning on the GPU thread, not the main thread

### 4. Offscreen Recycling (No display:none)
**Impact: Medium | File: `logcat.js`**

Pooled elements are moved offscreen via `translateY(-9999px)` rather than `display: none`. The `display` property triggers reflow when toggled, causing visible flicker. Transform changes are compositor-only operations with no reflow cost.

### 5. Content Update via textContent
**Impact: Medium | File: `logcat.js` — `_updateEntry()`**

When a pooled element is reused for a different log, `_updateEntry()` sets `textContent` on each child directly:
```js
c[0].textContent = log.timestamp;
c[1].textContent = (log.tag || '').trim();
// ...
```
This avoids `innerHTML` re-parsing and automatic HTML escaping is built into `textContent`.

### 6. Log Batching with requestAnimationFrame
**Impact: High | File: `logcat.js` — `queueLogEntry()` / `flushBatch()`**

Incoming logs are queued in `_pendingLogs[]`. A single `requestAnimationFrame` callback flushes the entire batch:
- If 200 logs arrive in one frame, they're processed in one flush — not 200 individual DOM updates
- Buffer, filter indices, and search matches are all updated in the same flush
- Virtual height and visible rows are updated once at the end

### 7. Backend Line Buffering
**Impact: Medium | File: `adb-service.js`**

ADB stdout `data` events can split mid-line. A `lineBuffer` accumulates partial data, splits on `\n`, and keeps the last (potentially incomplete) element for the next chunk. This prevents:
- Malformed log entries from truncated lines
- Failed regex parses causing dropped logs

### 8. Incremental Filter Maintenance
**Impact: Medium | File: `logcat.js` — `flushBatch()`**

When new logs arrive, `filteredIndices` is updated incrementally — each new log is checked against current filters and appended if it passes. This avoids a full O(n) rebuild of the filter index on every batch.

Full rebuild (`rebuildFilteredIndices()`) only happens when filters themselves change (user toggles a level, adds a tag/package).

### 9. Pre-computed Search Text
**Impact: Low-Medium | File: `logcat.js` — `queueLogEntry()`**

Each log gets `log.text` computed once at ingestion:
```js
log.text = `${log.timestamp} ${log.pkg || ''} ${log.tag} ${log.message}`.toLowerCase();
```
Search queries then do a single `String.includes()` on this pre-built lowercase string. Without this, every search match check would need to concatenate and lowercase on the fly.

### 10. Debounced Search
**Impact: Low-Medium | File: `logcat.js` — `search()`**

Search is debounced at 150ms to prevent re-scanning the buffer on every keystroke:
```js
search(dir) {
    clearTimeout(this._searchDebounce);
    this._searchDebounce = setTimeout(() => this._doSearch(dir), 150);
}
```

### 11. Throttled Scroll Handler
**Impact: Medium | File: `logcat.js` — `connectedCallback()`**

The scroll event handler uses a `scrollTicking` guard with `requestAnimationFrame` to coalesce multiple scroll events into one render per frame. Without this, fast scrolling can fire dozens of scroll events per frame, each triggering a `renderVisibleRows()`.

### 12. String-based HTML Escaping
**Impact: Low | File: `logcat.js` — `escapeHtml()`**

Uses `String.replace()` chain instead of creating a temporary DOM element:
```js
text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
```
Avoids DOM element allocation on every log message (hot path).

### 13. CSS Containment on Entries
**Impact: Medium | File: `logcat.css`**

```css
entry { contain: layout style paint; }
```
Tells the browser that layout/style/paint changes inside an entry don't affect anything outside it. This limits the scope of rendering work when entry content changes.

### 14. Client-Side Filtering (No Stream Restart)
**Impact: High | File: `logcat.js`**

All filtering (level, tag, package) happens in the UI via `filteredIndices`. The ADB stream always runs at Verbose level — changing filters never kills/restarts the stream. This means:
- Zero data loss when changing filters
- Instant filter application (just rebuild indices + re-render visible rows)
- No async UID lookups or ADB process restarts

### 15. Set-based Level Filtering
**Impact: Low | File: `logcat.js`**

Level filtering uses `Set.has()` (O(1)) instead of array index comparison or `Array.includes()`. With 6 levels this is marginal, but it's the correct data structure for membership testing.

### 16. Scroll Position Stability on Buffer Trim
**Impact: Medium | File: `logcat.js` — `trimBuffer()`**

When the buffer exceeds 100K entries and old logs are removed, `scrollTop` is adjusted by the exact pixel offset of removed display rows. This prevents the viewport from jumping when the user has auto-scroll disabled and is reading a specific section.

### 17. Soft Wrap Bypasses Virtual Scroll
**Impact: Medium | File: `logcat.css`**

When soft wrap is enabled, entries have variable heights (wrapping text), breaking the fixed `ROW_HEIGHT` assumption. CSS overrides switch entries to `position: static` and disable transforms, falling back to natural document flow. The `flushBatch` method detects soft wrap mode and appends entries as regular elements instead of updating virtual scroll.

---

## Planned Optimizations (Not Yet Implemented)

### P0: Batch postMessage Across Webview Bridge
**Impact: Critical | Files: `adb-service.js`, `main-view-provider.js`, `logcat.js`**

Currently each parsed log emits a separate `adbevent` → `postMessage()` call. The VS Code webview bridge has significant per-message overhead (JSON serialization + iframe boundary). Under heavy logcat output (1000+ lines/sec), this saturates the bridge.

**Fix:** Accumulate logs in the backend and send one `{ type: 'log-batch', data: { logs: [...] } }` message per ADB `data` chunk (or per 16ms tick). The frontend `onMessage` handler would push the entire array to `_pendingLogs` at once.

### P1: Line Clustering
**Impact: High | Effort: Medium**

Instead of 1 DOM element per log line, group 20-50 lines into a single cluster element. The virtual scroller manages clusters, not individual lines. GitHub uses this to render 50K+ log lines. Reduces DOM mutation count by ~50x.

### P2: Ring Buffer Instead of Array.splice
**Impact: Medium | Effort: Medium**

`Array.splice(0, N)` on a 100K array is O(n) because it shifts all remaining elements. A ring buffer (circular array with head/tail pointers) makes removal O(1). Also avoids creating temporary arrays during `filteredIndices` and `matches` remapping.

### P3: Binary Search in scrollToMatch
**Impact: Medium | Effort: Low**

`filteredIndices.indexOf(bufferIndex)` is O(n). Since `filteredIndices` is sorted, binary search makes it O(log n). At 100K entries, this is the difference between ~100K comparisons and ~17.

### P4: Adaptive Frame-Rate Throttling
**Impact: Medium | Effort: Low**

Monitor frame budget (12ms target, leaving 4ms headroom for 60fps). If `renderVisibleRows()` exceeds budget, skip non-essential work (search highlight updates, status text) and defer to next frame. Prevents cascading jank during burst output.

### P5: Decoupled Scroll Container
**Impact: High (Kills flicker in Chrome) | Effort: Medium**

Separate the scrollable div from the content div as siblings (not parent-child). The scroll div is an empty div with the correct total height. The content div is absolutely positioned and moved via `transform: translateY(-scrollTop)`. Since content doesn't natively scroll, Chrome's compositor can't show stale scrolled content — eliminating the compositor-main thread race condition.

### P6: Web Worker for Log Processing
**Impact: High | Effort: High**

Move log filtering, search matching, and text preprocessing to a dedicated Web Worker. The main thread only handles:
- Receiving filtered/matched results from the worker
- Rendering visible rows

This keeps the UI thread free for scrolling/interaction even during burst log output with complex filters.

### P7: Transferable ArrayBuffer for Worker Communication
**Impact: Medium | Effort: Low (after Worker is implemented)**

When using Web Workers, encode log batches as a single `ArrayBuffer` and transfer ownership (zero-copy) instead of structured cloning. A 500MB ArrayBuffer transfer takes 1ms vs 149ms for structured clone.

### P8: ViewType Element Pools
**Impact: Low-Medium | Effort: Low**

Separate element pools per log priority level. When recycling, a "red error element" goes back to the error pool and is reused for the next error — skipping the className update and style recalculation. Currently all priorities share one pool, so every reuse requires restyling.

### P9: Canvas Rendering (Nuclear Option)
**Impact: Very High | Effort: Very High**

Replace DOM entries with an HTML5 Canvas. Render text directly using `fillText()` with cached font metrics. xterm.js's canvas renderer is 5-45x faster than DOM. Their WebGL renderer achieves 900% improvement over canvas.

Eliminates DOM layout/paint entirely, but requires custom implementations for:
- Text selection (hidden textarea overlay)
- Search highlighting (custom drawing)
- Accessibility (parallel invisible DOM)
- Copy/paste

Only worth considering if DOM-based approaches hit a wall.
