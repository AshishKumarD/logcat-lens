## 3.0.0

### Detail Pane
- Click any log row → resizable right-side pane shows the full message with copy / close icons
- Multi-line JSON bodies are auto-stitched across chunked log entries and pretty-printed (handles bodies split into hundreds of records)
- Tolerant pretty-printer that formats JSON-shaped text even when the response was truncated mid-stream
- JSON detection uses structural brace tracking with string-aware escaping — no app-specific markers required

### Inline Media Previews (base64)
- Any log line whose embedded base64 decodes to a known media magic header is rendered inline as an image / audio / video element instead of a wall of base64 text
  - Supported: PNG, JPEG, GIF, WebP, BMP, MP3, WAV, OGG, MP4 / RIFF containers, PDF
  - Small thumbnail in compact mode; full size in soft-wrap mode
- Subsequent base64 continuation chunks and short marker lines (`MEDIA_END`, etc.) are auto-hidden, so the log shows **one row per media item** instead of dozens of noisy lines
- Clicking the inline preview opens the same image / audio / video at full pane size in the detail pane
- 100% app-agnostic — no specific tag, keyword, or prefix is required. The viewer recognises media purely from the bytes themselves. Anywhere you can emit `Log.d(tag, Base64.encode(bytes))` on Android, Logcat Lens will show the preview.

### Links & Formatting
- HTTP/HTTPS URLs in log messages are now clickable (issue #2) — opens in your system browser

### Live Package & Lifecycle
- Selecting / removing a package while streaming now updates lifecycle tracking immediately — no need to stop/play to pick up the new app
- Soft-wrap mode now re-renders when tag / package / level filters change

### Better Error Surfacing
- `pm clear` failures (common when "Permission monitoring" is on in Developer Options) now show a clear VS Code toast with the exact fix hint, instead of silently doing nothing

### Bug Fixes
- JSON stitcher handles concurrent requests correctly (chunks isolated per `tag + pid + tid`)
- Detail pane title shows `(N lines joined · best-effort)` when the JSON couldn't be fully buffered

### Known Limitations of base64 media in logcat
Logcat was never designed as a binary pipe, and Android imposes hard transport limits we can't work around from the viewer side:

- **Per-record limit:** Android's `Log.d` truncates a single record at ~4 KB. Apps must split the base64 into ~3.5 KB chunks before logging — Logcat Lens then reassembles them. If the app emits a base64 longer than 4 KB in one `Log.d` call, the tail is silently lost on the device.
- **logd buffer drops:** when many large media bodies emit in quick succession (e.g. an asset gallery downloading 100+ images at once), logd's ring buffer can drop records under pressure. The viewer can only render what actually reached logcat — gaps in the base64 produce a broken image. This is a device-side drop, not a viewer bug.
- **No recovery from lossy decoding:** if your HTTP logger reads the response body via `bodyAsString()` / `readUtf8()` (which is what most logging interceptors do), the binary bytes are corrupted by the UTF-8 decode *before* they ever reach `Log.d`. Every `�` (U+FFFD) you see in a binary dump is original bytes that have been erased and replaced — no viewer can reconstruct them. For media bodies, log the **raw bytes as base64** (via `peekBody` or an OkHttp `Interceptor` that buffers the response before consumption), not as a decoded string.
- **Recommendation for serious HTTP body inspection:** use an in-app inspector like Chucker or Axer alongside Logcat Lens. They capture response bytes pre-decode and have their own UI for image / JSON / hex views. Logcat Lens is best for *seeing* media in the same stream as the rest of your logs — not for replacing a dedicated HTTP inspector.

## 2.1.0

### ADB Auto-Discovery & One-Click Install
- **Android Studio is not required** — install ADB directly from within VS Code with a single click
- Automatically finds `adb` from ANDROID_HOME, ANDROID_SDK_ROOT, and common SDK install locations (macOS, Windows, Linux)
- No more "adb: command not found" when VS Code is launched from the dock/start menu instead of a terminal
- New `logcatLens.adbPath` setting to manually override the adb binary path
- Clear "ADB Not Found" screen with Install, Download, and Set Path options when ADB is missing
- Graceful error handling — if ADB is removed or becomes unavailable mid-session, the install screen is shown instead of cryptic errors

## 2.0.0

### App Lifecycle Tracking
- Real-time app state monitoring (Foreground, Background, Not Running, Started, Killed, Crashed, ANR)
- Lifecycle events appear as colored banner rows in the log stream with "Logcat Lens" tag
- Custom `L` log level for Logcat Lens events — always visible through tag/package/search filters, toggleable via level chip
- Context-aware action buttons in status bar: Launch, Force Stop, Bring to Front, Clear Data

### Tag Groups
- Save current tags as a named group, load or delete saved groups
- Active group shown as a collapsible chip — click to expand/collapse individual tags
- Groups persist in VS Code settings across sessions

### Search & Filtering
- Search filter mode — toggle to show only matching logs instead of just navigating
- Search now respects active tag/package/level filters
- Export respects active filters instead of dumping the entire buffer
- Level chip tooltips showing full level names

### Device Detection
- Auto-detect device connect/disconnect via `adb track-devices`
- Online/offline/unauthorized status shown in device dropdown
- Refresh now reliably picks up new devices

### Package Tracking
- Auto-detect package install/uninstall/update from logcat
- Immediate PID map refresh on package changes
- App version info fetched on package selection

### Bug Fixes
- Copy now works in virtual scroll mode (normal mode)
- Search navigation works correctly in soft-wrap mode
- No more duplicate logs when stopping and restarting streaming
- Tag/package chip containers scroll when many are selected
- Device-specific `adb logcat -c` instead of default device
- Tooltips near screen edge flip to stay visible

## 1.0.0

- Real-time logcat streaming with pause/resume/restart
- Client-side filtering by log level, tags, and packages
- Multi-select level chips, tag chips, and package chips with autocomplete
- Full-text search with match navigation
- Virtual scrolling for high-performance rendering
- Standard, compact, and soft wrap display modes
- Resizable column headers
- Double-click to copy, export to editor
- Infinite scroll-back history in soft wrap mode
