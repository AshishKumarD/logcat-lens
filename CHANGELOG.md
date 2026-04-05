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
