class Logcat extends HTMLElementBase {
	BUFFER_SIZE = 100000;    // Can be huge now — only JS array, not DOM
	ROW_HEIGHT = 18;         // Fixed row height in px (line-height: 1.5 * 12px)
	OVERSCAN = 20;           // Extra rows rendered above/below viewport

	buffer = [];             // All log objects
	filteredIndices = [];    // indices into buffer that pass filters (and skip media continuations)

	matches = [];
	currentMatch = -1;
	query = '';

	autoScroll = true;
	softWrap = false;
	viewMode = 'standard';
	isPlaying = false;
	isPaused = false;
	state = 'idle';

	availablePackages = [];
	selectedPackages = [];
	tags = [];
	knownTags = new Set();
	tagGroups = {};
	activeTagGroup = null; // name of currently loaded group
	tagGroupExpanded = false; // whether to show individual tags
	selectedLevels = new Set(['V', 'D', 'I', 'W', 'E', 'F', 'L']); // All on by default
	searchFilterMode = false;

	// Batching
	_pendingLogs = [];
	_batchRAF = null;
	_searchDebounce = null;

	// Virtual scroll state
	_visibleStart = 0;
	_visibleEnd = 0;
	_renderedEntries = new Map(); // displayIndex -> { el, bufIdx }
	_pool = []; // Recycled entry elements
	_flowStart = 0; // First display index in DOM (soft-wrap mode)
	_flowEnd = 0;   // Last display index in DOM (soft-wrap mode)

	connectedCallback() {
		super.render(this.render());

		// Virtual scroll handler
		let scrollTicking = false;
		this.logList.onscroll = () => {
			if (!scrollTicking) {
				scrollTicking = true;
				requestAnimationFrame(() => {
					const threshold = this.softWrap ? 50 : 5;
					this.autoScroll = (this.logList.scrollTop + this.logList.clientHeight) >= (this.logList.scrollHeight - threshold);
					this.updateScrollButtons();

					if (this.softWrap) {
						// Load older entries when scrolling near top
						if (this.logList.scrollTop < 200) {
							this._loadOlderEntries();
						}
					} else {
						this.renderVisibleRows();
					}
					scrollTicking = false;
				});
			}
		};

		this.initTooltips();
		this.initDetailPane();
		this.initPackageAutocomplete();
		this.initTagInput();
		this.initColumnResize();
		this.renderLevelChips();
		this.updateStatus();
		this.postMessage({ type: 'load-tag-groups' });

		// Check ADB before doing anything else
		this.postMessage({ type: 'check-adb' });
	}

	_setAdbMissing(missing) {
		this.querySelector('#adb-missing-overlay').style.display = missing ? '' : 'none';
		this.querySelector('sidebar').style.display = missing ? 'none' : '';
		this.querySelector('.content').style.display = missing ? 'none' : '';
		if (missing) {
			const btn = this.querySelector('#adb-install-btn');
			btn.disabled = false;
			btn.textContent = 'Install ADB';
		}
	}

	onMessage(event) {
		event = event.data;

		switch (event.type) {
			case 'adb-status':
				if (event.data.available) {
					this._setAdbMissing(false);
					this.refreshDevices();
				} else {
					this._setAdbMissing(true);
				}
				break;
			case 'devices':
				this.toggleLoading(false);
				this.setDevices(event.data.devices);
				break;
			case 'packages':
				this.availablePackages = event.data.packages;
				if (document.activeElement === this.packageInput && this.packageInput.value) {
					this.showPackageDropdown(this.packageInput.value);
				}
				break;
			case 'tags':
				event.data.tags.forEach(t => this.knownTags.add(t));
				break;
			case 'tag-groups':
				this.tagGroups = event.data.groups || {};
				break;
			case 'log':
				if (!this.isPaused) this.queueLogEntry(event.data.log);
				break;
			case 'package-changed':
				this._showPackageEvent(event.data.message);
				break;
			case 'lifecycle':
				this._showLifecycleEvent(event.data);
				break;
			case 'package-info':
				this._showPackageInfo(event.data);
				break;
			case 'stop':
				this.isPlaying = false;
				this.isPaused = false;
				this.state = 'idle';
				this.updatePlayButton();
				this.updateStatus();
				break;
		}
	}

	// ACTIONS
	start() {
		if (this.isPlaying && !this.isPaused) return;
		if (this.isPaused) { this.resume(); return; }

		this.postMessage({
			type: 'start',
			data: {
				deviceId: this.deviceSelect.value,
				packages: this.selectedPackages,
				tag: this.tags,
				level: 'V',
				search: this.searchInput.value,
			}
		});

		this.isPlaying = true;
		this.isPaused = false;
		this.state = 'streaming';
		this.updatePlayButton();
		this.updateStatus();
	}

	pause() {
		if (!this.isPlaying || this.isPaused) return;
		this.isPaused = true;
		this.state = 'paused';
		this.postMessage({ type: 'pause' });
		this.updatePlayButton();
		this.updateStatus();
	}

	resume() {
		if (!this.isPaused) return;
		this.isPaused = false;
		this.state = 'streaming';
		this.postMessage({ type: 'resume' });
		this.updatePlayButton();
		this.updateStatus();
	}

	stop() {
		if (!this.isPlaying) return;
		this.postMessage({ type: 'stop' });
		this.isPlaying = false;
		this.isPaused = false;
		this.state = 'idle';
		this.updatePlayButton();
		this.updateStatus();
	}

	restart() {
		this.clear();
		this.postMessage({
			type: 'restart',
			data: {
				deviceId: this.deviceSelect.value,
				packages: this.selectedPackages,
				tag: this.tags,
				level: 'V',
				search: this.searchInput.value,
			}
		});
		this.isPlaying = true;
		this.isPaused = false;
		this.state = 'streaming';
		this.updatePlayButton();
		this.updateStatus();
	}

	clear() {
		this.buffer = [];
		this.filteredIndices = [];
		this._mediaSources = new Map();
		this._pendingLogs = [];
		if (this._batchRAF) {
			cancelAnimationFrame(this._batchRAF);
			this._batchRAF = null;
		}
		this.clearSearch();

		if (this.softWrap) {
			// Flow mode — just clear the viewport
			this.viewport.innerHTML = '';
			this._flowStart = 0;
			this._flowEnd = 0;
		} else {
			// Virtual scroll — return entries to pool
			for (const [, item] of this._renderedEntries) {
				item.el.style.transform = 'translateY(-9999px)';
				this._pool.push(item.el);
			}
			this._renderedEntries.clear();
			this.updateVirtualHeight();
		}

		this.postMessage({ type: 'clear' });
	}

	// ========================
	// VIRTUAL SCROLLING
	// ========================
	getDisplayCount() {
		return this.filteredIndices.length;
	}

	getLogAtDisplayIndex(displayIdx) {
		return this.buffer[this.filteredIndices[displayIdx]];
	}

	getBufferIndexForDisplayIndex(displayIdx) {
		return this.filteredIndices[displayIdx];
	}

	updateVirtualHeight() {
		const totalHeight = this.getDisplayCount() * this.ROW_HEIGHT;
		this.viewport.style.height = totalHeight + 'px';
	}

	renderVisibleRows() {
		const scrollTop = this.logList.scrollTop;
		const viewHeight = this.logList.clientHeight;
		const totalRows = this.getDisplayCount();

		if (!viewHeight || !totalRows) return;

		const startRow = Math.max(0, Math.floor(scrollTop / this.ROW_HEIGHT) - this.OVERSCAN);
		const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewHeight) / this.ROW_HEIGHT) + this.OVERSCAN);

		// Recycle entries outside visible range into pool
		for (const [idx, item] of this._renderedEntries) {
			if (idx < startRow || idx >= endRow) {
				item.el.style.transform = 'translateY(-9999px)';
				this._pool.push(item.el);
				this._renderedEntries.delete(idx);
			}
		}

		// Render entries in visible range — reuse from pool or existing
		const activeMatchBufIdx = (this.currentMatch >= 0) ? this.matches[this.currentMatch] : -1;

		for (let i = startRow; i < endRow; i++) {
			const bufIdx = this.getBufferIndexForDisplayIndex(i);
			const existing = this._renderedEntries.get(i);

			// Already rendered with correct data — just verify position
			if (existing && existing.bufIdx === bufIdx) {
				continue;
			}

			const log = this.getLogAtDisplayIndex(i);
			if (!log) continue;

			// Get or create element
			let el;
			if (existing) {
				el = existing.el; // Reuse in-place, data changed
			} else if (this._pool.length > 0) {
				el = this._pool.pop(); // Recycle from pool
			} else {
				el = document.createElement('entry');
				el.style.position = 'absolute';
				el.style.left = '0';
				el.style.height = this.ROW_HEIGHT + 'px';
				el.style.willChange = 'transform';
				this.viewport.appendChild(el);
			}

			// Update content
			el.className = log.priority + (log._lifecycle ? ' lifecycle-entry lifecycle-' + log._lifecycle : '') + (activeMatchBufIdx === bufIdx ? ' active-match' : '') + (this._selectedBufIdx === bufIdx ? ' selected' : '');
			el.style.transform = `translateY(${i * this.ROW_HEIGHT}px)`;
			el.dataset.bufIdx = bufIdx;
			el.children.length === 0
				? el.innerHTML = this._entryHTML(log, bufIdx)
				: this._updateEntry(el, log, bufIdx);

			this._renderedEntries.set(i, { el, bufIdx });
		}

		this._visibleStart = startRow;
		this._visibleEnd = endRow;
	}

	_entryHTML(log, bufIdx) {
		return `<timestamp>${log.timestamp}</timestamp><tag>${(log.tag || '').trim()}</tag><pkg>${log.pkg || ''}</pkg><pid>${log.pid || ''}</pid><badge>${log.priority}</badge><message>${this._formatMessage(log.message, bufIdx)}</message>`;
	}

	_updateEntry(el, log, bufIdx) {
		const c = el.children;
		c[0].textContent = log.timestamp;
		c[1].textContent = (log.tag || '').trim();
		c[2].textContent = log.pkg || '';
		c[3].textContent = log.pid || '';
		c[4].textContent = log.priority;
		c[5].innerHTML = this._formatMessage(log.message, bufIdx);
	}

	_formatMessage(text, bufIdx) {
		const raw = text || '';
		const segments = this._segmentBinary(raw);
		let out = '';
		for (const seg of segments) {
			if (seg.type === 'binary') {
				out += this._renderBinaryChip(seg, bufIdx);
			} else if (seg.type === 'json') {
				out += this._renderJsonChip(seg);
			} else {
				out += this.escapeHtml(seg.value).replace(
					/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g,
					(url) => `<a href="${url}" class="log-link" target="_blank" rel="noopener">${url}</a>`
				);
			}
		}
		return out;
	}

	// Find embedded binary blobs (data URIs, base64, hex) whose decoded magic
	// bytes match a known format. Returns ordered segments of text/binary.
	_segmentBinary(raw) {
		const MAX_ENC_LEN = 1_000_000; // hard cap per blob
		// Order matters: try data URIs first (most specific), then base64, then hex.
		const patterns = [
			{ kind: 'dataurl', re: /data:([a-z]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)/g },
			{ kind: 'b64',     re: /\b[A-Za-z0-9+/_-]{32,}={0,2}/g },
			{ kind: 'hex',     re: /\b[0-9a-fA-F]{16,}\b/g },
		];

		const hits = [];
		// JSON blocks: walk the string, find balanced {...} or [...] that parse.
		const jsonHits = this._findJsonBlocks(raw);
		for (const j of jsonHits) hits.push(j);

		for (const { kind, re } of patterns) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(raw)) !== null) {
				if (m[0].length > MAX_ENC_LEN) continue;
				let mime = null, payload = null, enc = null;
				if (kind === 'dataurl') {
					mime = m[1];
					payload = m[2];
					enc = 'b64';
				} else if (kind === 'b64') {
					payload = m[0];
					const head = this._b64DecodeHead(payload, 16);
					mime = head ? this._sniffMime(head) : null;
					enc = 'b64';
				} else {
					payload = m[0].length % 2 === 0 ? m[0] : m[0].slice(0, -1);
					const head = this._hexDecodeHead(payload, 16);
					mime = head ? this._sniffMime(head) : null;
					enc = 'hex';
				}
				if (!mime) continue;
				hits.push({ start: m.index, end: m.index + m[0].length, mime, payload, enc });
			}
		}

		if (hits.length === 0) return [{ type: 'text', value: raw }];

		// Resolve overlaps: keep earliest, longest.
		hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
		const kept = [];
		let cursor = 0;
		for (const h of hits) {
			if (h.start < cursor) continue;
			kept.push(h);
			cursor = h.end;
		}

		const segs = [];
		let pos = 0;
		for (const h of kept) {
			if (h.start > pos) segs.push({ type: 'text', value: raw.slice(pos, h.start) });
			if (h.kind === 'json') {
				segs.push({ type: 'json', text: h.text });
			} else {
				const size = h.enc === 'b64'
					? Math.floor(h.payload.replace(/=+$/, '').length * 3 / 4)
					: Math.floor(h.payload.length / 2);
				segs.push({ type: 'binary', mime: h.mime, payload: h.payload, enc: h.enc, size });
			}
			pos = h.end;
		}
		if (pos < raw.length) segs.push({ type: 'text', value: raw.slice(pos) });
		return segs;
	}

	_findJsonBlocks(raw) {
		const out = [];
		const MIN_LEN = 40;
		for (let i = 0; i < raw.length; i++) {
			const c = raw[i];
			if (c !== '{' && c !== '[') continue;
			const end = this._scanBalancedJson(raw, i);
			if (end < 0) continue;
			const len = end - i + 1;
			if (len < MIN_LEN) { i = end; continue; }
			const text = raw.slice(i, end + 1);
			try {
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === 'object') {
					out.push({ kind: 'json', start: i, end: end + 1, text });
				}
			} catch { /* not JSON */ }
			i = end;
		}
		return out;
	}

	_scanBalancedJson(s, start) {
		const open = s[start];
		const close = open === '{' ? '}' : ']';
		let depth = 0;
		let inStr = false;
		for (let i = start; i < s.length; i++) {
			const c = s[i];
			if (inStr) {
				if (c === '\\') { i++; continue; }
				if (c === '"') inStr = false;
			} else {
				if (c === '"') inStr = true;
				else if (c === '{' || c === '[') depth++;
				else if (c === '}' || c === ']') {
					depth--;
					if (depth === 0) return c === close ? i : -1;
				}
			}
		}
		return -1;
	}

	_b64DecodeHead(s, n) {
		try {
			const norm = s.replace(/-/g, '+').replace(/_/g, '/');
			// atob needs length % 4 === 0; pad with '='.
			const pad = norm.length % 4 ? norm + '='.repeat(4 - (norm.length % 4)) : norm;
			const bin = atob(pad.slice(0, Math.max(24, Math.ceil(n * 4 / 3) + 4)));
			const len = Math.min(bin.length, n);
			const out = new Uint8Array(len);
			for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
			return out;
		} catch { return null; }
	}

	_hexDecodeHead(s, n) {
		const len = Math.min(Math.floor(s.length / 2), n);
		const out = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			const b = parseInt(s.substr(i * 2, 2), 16);
			if (Number.isNaN(b)) return null;
			out[i] = b;
		}
		return out;
	}

	_sniffMime(b) {
		if (!b || b.length < 2) return null;
		// PNG
		if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
		// JPEG
		if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
		// GIF
		if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
		// BMP
		if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
		// PDF
		if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
		// ID3 (MP3)
		if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
		// MP3 frame sync
		if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'audio/mpeg';
		// ZIP
		if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return 'application/zip';
		// OGG
		if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
		// RIFF container: WAV / WEBP
		if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12) {
			if (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav';
			if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
		}
		return null;
	}

	_renderBinaryChip(seg, bufIdx) {
		// If this row is the MEDIA header line, stitch the full payload across
		// continuation chunks and render the image (or audio/video) inline.
		if (bufIdx != null && seg.mime && /^image\/|^audio\/|^video\//.test(seg.mime)) {
			const stitched = this._collectMediaBlob(bufIdx);
			if (stitched) {
				const dataUrl = `data:${stitched.mime};base64,${this._toBase64(stitched.payload, stitched.enc)}`;
				const kb = stitched.size >= 1024
					? (stitched.size / 1024).toFixed(1) + ' KB'
					: stitched.size + ' B';
				if (stitched.mime.startsWith('image/')) {
					return `<span class="log-media-inline" title="${this.escapeHtml(stitched.mime)} · ${kb}"><img src="${dataUrl}" alt="${this.escapeHtml(stitched.mime)}"></span>`;
				}
				if (stitched.mime.startsWith('audio/')) {
					return `<span class="log-media-inline"><audio controls preload="none" src="${dataUrl}"></audio></span>`;
				}
				if (stitched.mime.startsWith('video/')) {
					return `<span class="log-media-inline"><video controls preload="metadata" src="${dataUrl}"></video></span>`;
				}
			}
		}
		const kb = seg.size >= 1024
			? (seg.size / 1024).toFixed(1) + ' KB'
			: seg.size + ' B';
		const id = this._stashBlob(seg);
		return `<span class="log-binary-chip" data-blob-id="${id}">[${this.escapeHtml(seg.mime)} · ${kb} · preview]</span>`;
	}

	_renderJsonChip(seg) {
		// JSON is shown pretty-printed in the detail pane; keep the log line
		// as plain (escaped) text so row layout stays compact.
		return this.escapeHtml(seg.text);
	}

	_stashBlob(blob) {
		this._blobStore = this._blobStore || new Map();
		this._blobSeq = (this._blobSeq || 0) + 1;
		const id = String(this._blobSeq);
		this._blobStore.set(id, blob);
		// Cap the store so reused rows don't grow it unbounded.
		if (this._blobStore.size > 5000) {
			const firstKey = this._blobStore.keys().next().value;
			this._blobStore.delete(firstKey);
		}
		return id;
	}

	_invalidateAllRows() {
		for (const [, item] of this._renderedEntries) {
			item.el.style.transform = 'translateY(-9999px)';
			this._pool.push(item.el);
		}
		this._renderedEntries.clear();
	}

	// ========================
	// CLIENT-SIDE FILTERING
	// ========================
	LEVEL_ORDER = ['V', 'D', 'I', 'W', 'E', 'F', 'L'];
	LEVEL_NAMES = { V: 'Verbose', D: 'Debug', I: 'Info', W: 'Warning', E: 'Error', F: 'Fatal', L: 'Logcat Lens' };

	toggleLevel(level) {
		if (this.selectedLevels.has(level)) {
			if (this.selectedLevels.size <= 1) return; // Keep at least one
			this.selectedLevels.delete(level);
		} else {
			this.selectedLevels.add(level);
		}
		this.renderLevelChips();
		this.rebuildFilteredIndices();
	}

	renderLevelChips() {
		this.levelChips.innerHTML = this.LEVEL_ORDER.map(l => {
			const active = this.selectedLevels.has(l);
			return `<span class="level-chip level-${l}${active ? ' active' : ''}" data-tooltip="${this.LEVEL_NAMES[l]}" onclick="${this.handle}.toggleLevel('${l}')">${l}</span>`;
		}).join('');
	}

	rebuildFilteredIndices() {
		const hasTags = this.tags.length > 0;
		const hasPkgs = this.selectedPackages.length > 0;
		const allLevels = this.selectedLevels.size === this.LEVEL_ORDER.length;
		const hasLevel = !allLevels;
		const hasSearch = this.searchFilterMode && this.query;

		this.filteredIndices = [];
		const showL = this.selectedLevels.has('L');
		for (let i = 0; i < this.buffer.length; i++) {
			const log = this.buffer[i];
			if (log._mediaContinuation) continue; // hide MEDIA base64 continuation lines
			if (log.priority === 'L') {
				if (showL) this.filteredIndices.push(i);
				continue;
			}
			if (hasLevel && !this.selectedLevels.has(log.priority)) continue;
			if (hasTags && !this.tags.includes((log.tag || '').trim())) continue;
			if (hasPkgs && !this.selectedPackages.some(p => (log.pkg || '').includes(p))) continue;
			if (hasSearch && !this.matchesQuery(log)) continue;
			this.filteredIndices.push(i);
		}

		// Rebuild search matches against filtered view
		if (this.query) {
			this.matches = [];
			const count = this.getDisplayCount();
			for (let i = 0; i < count; i++) {
				const log = this.getLogAtDisplayIndex(i);
				if (this.matchesQuery(log)) {
					this.matches.push(this.getBufferIndexForDisplayIndex(i));
				}
			}
			this.currentMatch = -1;
			this.updateSearchUI();
		}

		if (this.softWrap) {
			// Flow mode renders DOM entries directly — rebuild it.
			this._enterFlowMode();
		} else {
			this.updateVirtualHeight();
			this._invalidateAllRows();
			this.renderVisibleRows();
		}

		if (this.autoScroll) {
			this.logList.scrollTop = this.logList.scrollHeight;
		}
	}

	// ========================
	// LOG INGESTION (BATCHING)
	// ========================
	queueLogEntry(log) {
		log.text = `${log.timestamp} ${log.pkg || ''} ${log.tag} ${log.message}`.toLowerCase();
		if (log.tag) this.knownTags.add(log.tag.trim());
		this._classifyMediaContinuation(log);
		this._pendingLogs.push(log);

		if (!this._batchRAF) {
			this._batchRAF = requestAnimationFrame(() => this.flushBatch());
		}
	}

	flushBatch() {
		this._batchRAF = null;
		const logs = this._pendingLogs;
		if (!logs.length) return;
		this._pendingLogs = [];

		const allLevels = this.selectedLevels.size === this.LEVEL_ORDER.length;
		const hasLevel = !allLevels;
		const hasTags = this.tags.length > 0;
		const hasPkgs = this.selectedPackages.length > 0;
		const hasSearch = this.searchFilterMode && this.query;
		const hasFilter = hasLevel || hasTags || hasPkgs || hasSearch;

		for (let i = 0; i < logs.length; i++) {
			const log = logs[i];
			const bufIdx = this.buffer.length;
			this.buffer.push(log);

			// Always exclude media continuation lines from display.
			if (log._mediaContinuation) continue;

			let pass;
			if (log.priority === 'L') {
				pass = this.selectedLevels.has('L');
			} else {
				pass = true;
				if (hasLevel && !this.selectedLevels.has(log.priority)) pass = false;
				if (hasTags && !this.tags.includes((log.tag || '').trim())) pass = false;
				if (hasPkgs && !this.selectedPackages.some(p => (log.pkg || '').includes(p))) pass = false;
				if (hasSearch && !this.matchesQuery(log)) pass = false;
			}
			if (pass) this.filteredIndices.push(bufIdx);

			// Update search matches — only for visible (filter-passing) entries
			if (pass && this.query && this.matchesQuery(log)) {
				this.matches.push(bufIdx);
			}
		}

		if (this.query) this.updateSearchUI();

		// Trim buffer if too large
		this.trimBuffer();

		if (this.softWrap) {
			// Flow mode — append new visible entries
			const filterSet = new Set(this.filteredIndices.slice(-this.SOFT_WRAP_MAX_DOM));
			let html = '';
			const startIdx = this.buffer.length - logs.length;
			for (let i = 0; i < logs.length; i++) {
				const bufIdx = startIdx + i;
				if (!filterSet.has(bufIdx)) continue;
				const log = logs[i];
				html += `<entry class="${log.priority}${log._lifecycle ? ' lifecycle-entry lifecycle-' + log._lifecycle : ''}" data-buf-idx="${bufIdx}">${this._entryHTML(log, bufIdx)}</entry>`;
			}
			if (html) {
				this.viewport.insertAdjacentHTML('beforeend', html);
				this._flowEnd = this.getDisplayCount();
			}

			// Trim old DOM entries to keep under limit
			const children = this.viewport.children;
			if (children.length > this.SOFT_WRAP_MAX_DOM && this.autoScroll) {
				const removeCount = children.length - this.SOFT_WRAP_MAX_DOM;
				for (let r = 0; r < removeCount; r++) {
					children[0].remove();
				}
				this._flowStart += removeCount;
			}
		} else {
			// Virtual scroll mode
			this.updateVirtualHeight();
			this.renderVisibleRows();
		}

		if (this.autoScroll) {
			this.logList.scrollTop = this.logList.scrollHeight;
		}
	}

	trimBuffer() {
		if (this.buffer.length <= this.BUFFER_SIZE) return;

		const oldDisplayCount = this.getDisplayCount();
		const removeCount = this.buffer.length - this.BUFFER_SIZE + 10000;
		this.buffer.splice(0, removeCount);

		// Rebuild filtered indices
		this.filteredIndices = this.filteredIndices
			.map(idx => idx - removeCount)
			.filter(idx => idx >= 0);

		// Rebuild search matches
		const origLen = this.matches.length;
		this.matches = this.matches
			.map(idx => idx - removeCount)
			.filter(idx => idx >= 0);
		if (this.currentMatch >= 0) {
			const removed = origLen - this.matches.length;
			this.currentMatch -= removed;
			if (this.currentMatch < 0) this.currentMatch = -1;
		}
		this.updateSearchUI();

		// Adjust scroll position so current view doesn't jump
		const newDisplayCount = this.getDisplayCount();
		const removedDisplayRows = oldDisplayCount - newDisplayCount;
		if (!this.autoScroll && removedDisplayRows > 0) {
			this.logList.scrollTop = Math.max(0, this.logList.scrollTop - removedDisplayRows * this.ROW_HEIGHT);
		}

		// Invalidate rendered entries since display indices shifted
		this._invalidateAllRows();
	}

	escapeHtml(text) {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	// ========================
	// PLAY/PAUSE/STATUS
	// ========================
	togglePausePlay() {
		if (this.isPaused) this.resume();
		else if (this.isPlaying) this.pause();
	}

	statusAction() {
		switch (this.state) {
			case 'idle': this.start(); break;
			case 'streaming': this.stop(); break;
			case 'paused': this.resume(); break;
		}
	}

	updatePlayButton() {
		if (!this.isPlaying) {
			this.pausePlayButton.className = 'ic play';
			this.pausePlayButton.dataset.tooltip = 'Pause';
			this.pausePlayButton.disabled = true;
		} else if (this.isPaused) {
			this.pausePlayButton.className = 'ic play';
			this.pausePlayButton.dataset.tooltip = 'Resume';
			this.pausePlayButton.disabled = false;
		} else {
			this.pausePlayButton.className = 'ic pause';
			this.pausePlayButton.dataset.tooltip = 'Pause';
			this.pausePlayButton.disabled = false;
		}
	}

	updateStatus() {
		let text = '';
		switch (this.state) {
			case 'idle':
				text = 'Not Started';
				this.statusActionBtn.className = 'ic play';
				this.statusActionBtn.dataset.tooltip = 'Start';
				break;
			case 'streaming':
				text = 'Streaming';
				this.statusActionBtn.className = 'ic stop';
				this.statusActionBtn.dataset.tooltip = 'Stop';
				break;
			case 'paused':
				text = 'Paused';
				this.statusActionBtn.className = 'ic play';
				this.statusActionBtn.dataset.tooltip = 'Resume';
				break;
		}
		this.statusText.textContent = text;
		this.pauseBanner.style.display = this.state === 'paused' ? '' : 'none';
	}

	// ========================
	// DEVICES
	// ========================
	refreshDevices() {
		this.toggleLoading(true);
		this.postMessage({ type: 'devices' });
	}

	setDevices(devices) {
		const prevValue = this.deviceSelect.value;
		this.deviceSelect.innerHTML = devices.length
			? devices.map(d => {
				const status = d.status && d.status !== 'online' ? ` (${d.status})` : '';
				const disabled = d.status && d.status !== 'online' ? ' disabled' : '';
				return `<option value="${d.id}"${disabled}>${d.model}${status}</option>`;
			}).join('')
			: '<option value="">No devices found</option>';
		// Restore previous selection if still available
		if (prevValue && [...this.deviceSelect.options].some(o => o.value === prevValue && !o.disabled)) {
			this.deviceSelect.value = prevValue;
		}
		if (devices.length && devices.some(d => d.status === 'online')) {
			this.fetchPackages();
			this.fetchTags();
		}
	}

	_toBase64(payload, enc) {
		if (enc === 'b64') {
			// Normalize base64url → base64 and ensure padding.
			let s = payload.replace(/-/g, '+').replace(/_/g, '/');
			if (s.length % 4) s += '='.repeat(4 - (s.length % 4));
			return s;
		}
		// Hex → base64
		const len = Math.floor(payload.length / 2);
		let bin = '';
		for (let i = 0; i < len; i++) {
			bin += String.fromCharCode(parseInt(payload.substr(i * 2, 2), 16));
		}
		return btoa(bin);
	}

	initDetailPane() {
		const pane = this.querySelector('#log-detail-pane');
		const body = this.querySelector('#log-detail-body');
		const title = this.querySelector('#log-detail-title');
		const copyBtn = this.querySelector('#log-detail-copy');
		const closeBtn = this.querySelector('#log-detail-close');
		const resize = this.querySelector('#log-detail-resize');

		closeBtn.addEventListener('click', () => {
			pane.style.display = 'none';
			this._selectedBufIdx = null;
			// Refresh row highlight
			for (const item of this._renderedEntries.values()) {
				item.el.classList.remove('selected');
			}
			this.viewport.querySelectorAll('entry.selected').forEach(e => e.classList.remove('selected'));
		});

		copyBtn.addEventListener('click', () => {
			if (!this._activeDetailText) return;
			this.postMessage({ type: 'copy', data: { text: this._activeDetailText } });
		});

		// Resize drag (vertical)
		let dragging = false, startY = 0, startH = 0;
		resize.addEventListener('mousedown', (e) => {
			dragging = true;
			startY = e.clientY;
			startH = pane.offsetHeight;
			document.body.style.userSelect = 'none';
			e.preventDefault();
		});
		document.addEventListener('mousemove', (e) => {
			if (!dragging) return;
			const dy = startY - e.clientY;
			const next = Math.min(Math.max(startH + dy, 80), window.innerHeight * 0.8);
			pane.style.height = next + 'px';
		});
		document.addEventListener('mouseup', () => {
			if (dragging) { dragging = false; document.body.style.userSelect = ''; }
		});

		// Binary chips inside an entry → open binary in the same detail pane.
		this.logList.addEventListener('click', (e) => {
			const chip = e.target.closest('.log-binary-chip');
			if (!chip) return;
			e.preventDefault();
			e.stopPropagation();
			const id = chip.dataset.blobId;
			const blob = this._blobStore?.get(id);
			if (!blob) return;
			const entry = chip.closest('entry');
			const bufIdx = entry?.dataset.bufIdx != null ? parseInt(entry.dataset.bufIdx, 10) : null;
			// Try to stitch the full base64 across same-source neighbour lines
			// (Android splits long messages into ~4 KB chunks).
			const stitched = bufIdx != null ? this._collectMediaBlob(bufIdx) : null;
			this._showBinaryDetail(stitched || blob, bufIdx);
		});

		// Single-click on a log row → open detail
		this.logList.addEventListener('click', (e) => {
			// Ignore clicks on interactive children (links, chips)
			if (e.target.closest('a, .log-binary-chip')) return;
			const entry = e.target.closest('entry');
			if (!entry) return;
			const bufIdxAttr = entry.dataset.bufIdx;
			if (bufIdxAttr == null) return;
			const bufIdx = parseInt(bufIdxAttr, 10);
			const log = this.buffer[bufIdx];
			if (!log) return;
			this._showDetail(log, bufIdx);
		});
	}

	_showBinaryDetail(blob, bufIdx) {
		const pane = this.querySelector('#log-detail-pane');
		const body = this.querySelector('#log-detail-body');
		const title = this.querySelector('#log-detail-title');

		if (bufIdx != null) {
			this._selectedBufIdx = bufIdx;
			this.viewport.querySelectorAll('entry.selected').forEach(el => el.classList.remove('selected'));
			const visEntry = this.viewport.querySelector(`entry[data-buf-idx="${bufIdx}"]`);
			if (visEntry) visEntry.classList.add('selected');
		}

		const sizeLabel = blob.size >= 1024 ? (blob.size / 1024).toFixed(1) + ' KB' : blob.size + ' B';
		title.textContent = `${blob.mime}  ·  ${sizeLabel}`;

		body.innerHTML = '';
		const dataUrl = `data:${blob.mime};base64,${this._toBase64(blob.payload, blob.enc)}`;
		if (blob.mime.startsWith('image/')) {
			const img = document.createElement('img');
			img.className = 'log-detail-img';
			img.src = dataUrl;
			body.appendChild(img);
		} else if (blob.mime.startsWith('audio/')) {
			const audio = document.createElement('audio');
			audio.controls = true;
			audio.src = dataUrl;
			body.appendChild(audio);
		} else if (blob.mime.startsWith('video/')) {
			const video = document.createElement('video');
			video.controls = true;
			video.src = dataUrl;
			video.className = 'log-detail-video';
			body.appendChild(video);
		} else {
			const p = document.createElement('p');
			p.textContent = `${blob.mime} — copy data URI to inspect.`;
			body.appendChild(p);
		}
		this._activeDetailText = dataUrl;
		pane.style.display = '';
	}

	_showDetail(log, bufIdx) {
		const pane = this.querySelector('#log-detail-pane');
		const body = this.querySelector('#log-detail-body');
		const title = this.querySelector('#log-detail-title');

		// Highlight selection
		this._selectedBufIdx = bufIdx;
		this.viewport.querySelectorAll('entry.selected').forEach(e => e.classList.remove('selected'));
		const visEntry = this.viewport.querySelector(`entry[data-buf-idx="${bufIdx}"]`);
		if (visEntry) visEntry.classList.add('selected');

		body.innerHTML = '';

		// If the clicked row is part of a media block, render the image / audio /
		// video directly — full size in the pane.
		const media = this._collectMediaBlob(bufIdx);
		if (media && media.payload) {
			this._showBinaryDetail(media, bufIdx);
			return;
		}

		// Otherwise reassemble multi-line JSON bodies across same-tag/pid log entries.
		const stitched = this._collectMultilineBody(bufIdx, log);

		if (stitched) {
			// Clicked line is part of a JSON body — show ONLY the full pretty JSON.
			let pretty;
			let parsed = true;
			try { pretty = JSON.stringify(JSON.parse(stitched.text), null, 2); }
			catch { pretty = this._softPrettyJson(stitched.text); parsed = false; }
			const suffix = parsed
				? `JSON (${stitched.lineCount} lines joined)`
				: `JSON (${stitched.lineCount} lines · best-effort, parse failed)`;
			title.textContent = `${log.timestamp}  ${log.priority}  ${(log.tag || '').trim()}  ${log.pkg || ''}  pid=${log.pid || ''}  · ${suffix}`;
			const pre = document.createElement('pre');
			pre.className = 'log-detail-json';
			pre.textContent = pretty;
			body.appendChild(pre);
			this._activeDetailText = pretty;
		} else {
			// No JSON detected — render the raw message (with binary chips if any).
			title.textContent = `${log.timestamp}  ${log.priority}  ${(log.tag || '').trim()}  ${log.pkg || ''}  pid=${log.pid || ''}`;
			const segs = this._segmentBinary(log.message || '');
			const parts = [];
			for (const seg of segs) {
				if (seg.type === 'binary') {
					parts.push(`[${seg.mime} · ${seg.size} bytes]`);
					const chip = document.createElement('span');
					chip.className = 'log-binary-chip';
					chip.dataset.blobId = this._stashBlob(seg);
					chip.textContent = `[${seg.mime} · ${(seg.size/1024).toFixed(1)} KB · click to preview]`;
					body.appendChild(chip);
					body.appendChild(document.createElement('br'));
				} else {
					const text = seg.type === 'json' ? seg.text : seg.value;
					parts.push(text);
					const span = document.createElement('span');
					span.textContent = text;
					body.appendChild(span);
				}
			}
			this._activeDetailText = parts.join('');
		}

		pane.style.display = '';
	}

	// If the clicked log is part of a multi-line body block (OkHttp/HttpLoggingInterceptor
	// style: `BODY START` … chunks … `BODY END`), or it's surrounded by same-tag/pid
	// neighbours that together form valid JSON, return the stitched text.
	// Mark base64 continuation lines of a media block. App-agnostic: a line is
	// treated as a media "header" if its message contains a long base64 run
	// whose first decoded bytes match a known media magic header (image/audio/
	// video). Subsequent same-source lines that are pure base64 (or a single
	// short marker like `MEDIA_END`) are continuations and get hidden.
	_classifyMediaContinuation(log) {
		this._mediaSources = this._mediaSources || new Map();
		const key = `${log.tag}|${log.pid}|${log.tid}`;
		const msg = (log.message || '').trim();
		const PURE_B64 = /^[A-Za-z0-9+/=]+$/;

		// Detect "this line starts a media block" via magic-byte sniffing.
		const b64Match = msg.match(/[A-Za-z0-9+/]{32,}={0,2}/);
		if (b64Match) {
			const head = this._b64DecodeHead(b64Match[0], 16);
			const mime = head ? this._sniffMime(head) : null;
			if (mime && /^(image|audio|video)\//.test(mime)) {
				this._mediaSources.set(key, true);
				return; // header — keep visible, do not mark as continuation
			}
		}

		const active = this._mediaSources.get(key);
		if (!active) return;

		// A short marker line (e.g. "MEDIA_END") between chunks is treated as
		// part of the media block and hidden too.
		if (PURE_B64.test(msg) || /^[A-Za-z_]{1,16}$/.test(msg)) {
			log._mediaContinuation = true;
			return;
		}

		// Anything else ends the active media block.
		this._mediaSources.delete(key);
	}

	// Stitch a MEDIA <mime> <size>B <base64...> log block across same-source
	// chunks (Android splits long Log.d messages at ~4 KB). Walks backwards to
	// find the header line, then forward concatenating same-source base64
	// continuations until a non-base64 / new-marker line appears.
	_collectMediaBlob(bufIdx) {
		const clicked = this.buffer[bufIdx];
		if (!clicked) return null;
		const sameSource = (l) => l && l.tag === clicked.tag && l.pid === clicked.pid && l.tid === clicked.tid;

		const PURE_B64 = /^[A-Za-z0-9+/=]+$/;
		const SHORT_MARKER = /^[A-Za-z_]{1,16}$/; // e.g. MEDIA_END

		// Walk backward to find the line whose base64 starts a media block
		// (magic-byte sniff). App-agnostic — no keyword required.
		let headerIdx = -1, mime = '', firstChunk = '';
		for (let i = bufIdx; i >= 0; i--) {
			const l = this.buffer[i];
			if (!sameSource(l)) continue;
			const msg = (l.message || '').trim();
			const b64Match = msg.match(/[A-Za-z0-9+/]{32,}={0,2}/);
			if (!b64Match) {
				// Stop walking back at the first non-base64-bearing line on the
				// same source — that's the boundary of the current block.
				if (i < bufIdx) break;
				continue;
			}
			const head = this._b64DecodeHead(b64Match[0], 16);
			const m = head ? this._sniffMime(head) : null;
			if (m && /^(image|audio|video)\//.test(m)) {
				headerIdx = i;
				mime = m;
				// Capture from the first b64 char in this message onwards.
				firstChunk = msg.substring(b64Match.index);
				break;
			}
		}
		if (headerIdx < 0) return null;

		// Concatenate base64 from header chunk + subsequent same-source lines
		// until a non-base64 line appears (short app markers tolerated).
		let b64 = firstChunk.replace(/[^A-Za-z0-9+/=].*$/, '');
		for (let i = headerIdx + 1; i < this.buffer.length; i++) {
			const l = this.buffer[i];
			if (!sameSource(l)) continue;
			const msg = (l.message || '').trim();
			if (!msg) continue;
			if (PURE_B64.test(msg)) { b64 += msg; continue; }
			if (SHORT_MARKER.test(msg)) continue; // tolerate MEDIA_END-style markers
			break;
		}

		// Compute size from the decoded base64 length (raw bytes).
		const padded = b64.replace(/=+$/, '');
		const size = Math.floor(padded.length * 3 / 4);
		return { type: 'binary', mime, size, payload: b64, enc: 'b64' };
	}

	// Best-effort pretty-printer that formats JSON-shaped text even when it's
	// truncated or has small corruptions that JSON.parse rejects. Walks the
	// chars tracking brace/bracket depth (string-aware) and inserts newlines
	// + indentation where a real pretty-printer would.
	_softPrettyJson(text) {
		const INDENT = '  ';
		let out = '';
		let depth = 0, inStr = false, esc = false;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (esc) { out += c; esc = false; continue; }
			if (inStr) {
				out += c;
				if (c === '\\') esc = true;
				else if (c === '"') inStr = false;
				continue;
			}
			if (c === '"') { inStr = true; out += c; continue; }
			if (c === '{' || c === '[') {
				depth++;
				out += c;
				// Empty object/array on next char
				if (text[i + 1] === '}' || text[i + 1] === ']') continue;
				out += '\n' + INDENT.repeat(depth);
				continue;
			}
			if (c === '}' || c === ']') {
				depth = Math.max(0, depth - 1);
				out += '\n' + INDENT.repeat(depth) + c;
				continue;
			}
			if (c === ',') {
				out += c + '\n' + INDENT.repeat(depth);
				continue;
			}
			if (c === ':') {
				out += ': ';
				continue;
			}
			out += c;
		}
		return out;
	}

	// Generic multi-line JSON stitcher.
	// Concatenates same-tag+pid neighbour lines around the click, then does a
	// single string-aware forward scan to find every TOP-LEVEL JSON object/array
	// (depth-0 brace pairs). Returns the one whose character range contains the
	// clicked line — this is always the outermost JSON covering the click, so
	// you get the whole response body, not an inner field's object.
	_collectMultilineBody(bufIdx, log) {
		const sameSource = (l) => l && l.tag === log.tag && l.pid === log.pid && l.tid === log.tid;
		if (!sameSource(this.buffer[bufIdx])) return null;

		// Walk outward in BOTH directions, collecting EVERY same-source neighbour
		// in the buffer. No character cap — large JSON bodies must be stitched
		// in full even when they span thousands of chunks.
		const before = [];
		for (let i = bufIdx - 1; i >= 0; i--) {
			const l = this.buffer[i];
			if (!sameSource(l)) continue;
			before.push({ bufIdx: i, len: (l.message || '').length });
		}
		before.reverse();

		const after = [];
		for (let i = bufIdx + 1; i < this.buffer.length; i++) {
			const l = this.buffer[i];
			if (!sameSource(l)) continue;
			after.push({ bufIdx: i, len: (l.message || '').length });
		}

		const lines = []; // { bufIdx, charStart, charEnd }
		let totalLen = 0;
		for (const b of before) {
			lines.push({ bufIdx: b.bufIdx, charStart: totalLen, charEnd: totalLen + b.len });
			totalLen += b.len;
		}
		const clickedCharStart = totalLen;
		const clickedMsg = (this.buffer[bufIdx].message || '');
		lines.push({ bufIdx, charStart: clickedCharStart, charEnd: clickedCharStart + clickedMsg.length });
		totalLen += clickedMsg.length;
		const clickedCharEnd = totalLen;
		for (const a of after) {
			lines.push({ bufIdx: a.bufIdx, charStart: totalLen, charEnd: totalLen + a.len });
			totalLen += a.len;
		}

		const text = lines.map(ln => this.buffer[ln.bufIdx].message).join('');

		// Single forward pass: find every depth-0 JSON span. Pick the one
		// containing the clicked line's character range. Track the last open
		// brace whose close hasn't been seen, so we can still return a useful
		// (truncated) JSON if the body wasn't fully buffered.
		let depth = 0, inStr = false, esc = false, openPos = -1;
		let lastUnclosedAtOrBeforeClick = -1;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (esc) { esc = false; continue; }
			if (inStr) {
				if (c === '\\') esc = true;
				else if (c === '"') inStr = false;
				continue;
			}
			if (c === '"') { inStr = true; continue; }
			if (c === '{' || c === '[') {
				if (depth === 0) {
					openPos = i;
					if (i <= clickedCharEnd) lastUnclosedAtOrBeforeClick = i;
				}
				depth++;
			} else if (c === '}' || c === ']') {
				if (depth === 0) continue; // stray close — ignore
				depth--;
				if (depth === 0 && openPos >= 0) {
					const closeEnd = i + 1;
					if (clickedCharStart >= openPos && clickedCharEnd <= closeEnd) {
						const candidate = text.slice(openPos, closeEnd);
						try {
							const parsed = JSON.parse(candidate);
							if (parsed && typeof parsed === 'object') {
								let lineCount = 0;
								for (const ln of lines) {
									if (ln.charEnd > openPos && ln.charStart < closeEnd) lineCount++;
								}
								return { text: candidate, lineCount };
							}
						} catch { /* not valid JSON, keep scanning */ }
					}
					// Close consumed — this open didn't contain our click; reset.
					if (openPos === lastUnclosedAtOrBeforeClick) lastUnclosedAtOrBeforeClick = -1;
					openPos = -1;
				}
			}
		}

		// No fully balanced JSON found containing the click. If there was an
		// open brace at/before the click that never closed within the window,
		// return everything from that brace to end of window as a best-effort
		// truncated JSON. The caller pretty-prints what it can.
		if (lastUnclosedAtOrBeforeClick >= 0) {
			const slice = text.slice(lastUnclosedAtOrBeforeClick);
			let lineCount = 0;
			for (const ln of lines) {
				if (ln.charEnd > lastUnclosedAtOrBeforeClick) lineCount++;
			}
			return { text: slice, lineCount, truncated: true };
		}
		return null;
	}

	initTooltips() {
		let tip = null;
		let timer = null;
		let lastEvent = null;

		const show = () => {
			if (!lastEvent) return;
			const el = lastEvent.target.closest('[data-tooltip]');
			if (!el) return;
			const text = el.dataset.tooltip;
			if (!text) return;
			if (!tip) {
				tip = document.createElement('div');
				tip.className = 'tooltip';
				this.appendChild(tip);
			}
			tip.textContent = text;
			tip.style.display = 'block';
			// Position tooltip, clamping to stay within viewport
			const tipW = tip.offsetWidth;
			const pageW = document.documentElement.clientWidth;
			let left = lastEvent.pageX + 12;
			if (left + tipW > pageW - 8) {
				left = lastEvent.pageX - tipW - 8;
			}
			tip.style.left = Math.max(4, left) + 'px';
			tip.style.top = (lastEvent.pageY + 16) + 'px';
		};

		const hide = () => {
			clearTimeout(timer);
			timer = null;
			if (tip) tip.style.display = 'none';
		};

		this.addEventListener('mouseover', (e) => {
			const el = e.target.closest('[data-tooltip]');
			if (!el) { hide(); return; }
			lastEvent = e;
			clearTimeout(timer);
			timer = setTimeout(() => show(), 400);
		});

		this.addEventListener('mouseout', (e) => {
			const el = e.target.closest('[data-tooltip]');
			if (el) hide();
		});
	}

	// ========================
	// PACKAGES AUTOCOMPLETE
	// ========================
	fetchPackages() {
		const deviceId = this.deviceSelect.value;
		if (deviceId) this.postMessage({ type: 'packages', data: { deviceId } });
	}

	fetchTags() {
		const deviceId = this.deviceSelect.value;
		if (deviceId) this.postMessage({ type: 'fetch-tags', data: { deviceId } });
	}

	initPackageAutocomplete() {
		const input = this.packageInput;
		const dropdown = this.packageDropdown;

		this.deviceSelect.addEventListener('change', () => this.fetchPackages());

		input.addEventListener('input', () => this.showPackageDropdown(input.value));

		input.addEventListener('focus', () => {
			if (this.availablePackages.length) this.showPackageDropdown(input.value);
		});

		input.addEventListener('keydown', (e) => {
			const items = dropdown.querySelectorAll('.pkg-item');
			const active = dropdown.querySelector('.pkg-item.active');
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = (active ? active.textContent : input.value).trim();
				if (val && !this.selectedPackages.includes(val)) {
					this.selectedPackages.push(val);
					this.renderPackages();
					this._notifyPackagesChanged();
				}
				input.value = '';
				this.hidePackageDropdown();
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				const next = active ? active.nextElementSibling || items[0] : items[0];
				active?.classList.remove('active');
				next?.classList.add('active');
				next?.scrollIntoView({ block: 'nearest' });
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				const prev = active ? active.previousElementSibling || items[items.length - 1] : items[items.length - 1];
				active?.classList.remove('active');
				prev?.classList.add('active');
				prev?.scrollIntoView({ block: 'nearest' });
			} else if (e.key === 'Escape') {
				this.hidePackageDropdown();
			} else if (e.key === 'Backspace' && !input.value && this.selectedPackages.length) {
				this.selectedPackages.pop();
				this.renderPackages();
				this._notifyPackagesChanged();
			}
		});

		document.addEventListener('click', (e) => {
			if (!input.contains(e.target) && !dropdown.contains(e.target)) {
				this.hidePackageDropdown();
			}
		});
	}

	showPackageDropdown(filter) {
		const dropdown = this.packageDropdown;
		const query = (filter || '').toLowerCase();
		const filtered = this.availablePackages
			.filter(p => p.toLowerCase().includes(query) && !this.selectedPackages.includes(p));

		if (!filtered.length) { this.hidePackageDropdown(); return; }

		dropdown.innerHTML = filtered.slice(0, 50).map(p =>
			`<div class="pkg-item" onmousedown="${this.handle}.selectPackage('${p}')">${p}</div>`
		).join('');
		dropdown.style.display = 'block';
	}

	selectPackage(pkg) {
		if (!this.selectedPackages.includes(pkg)) {
			this.selectedPackages.push(pkg);
			this.renderPackages();
			this._notifyPackagesChanged();
			// Fetch version info
			const deviceId = this.deviceSelect.value;
			if (deviceId) this.postMessage({ type: 'package-info', data: { deviceId, packageName: pkg } });
		}
		this.packageInput.value = '';
		this.hidePackageDropdown();
	}

	_notifyPackagesChanged() {
		// Push the current package list to the backend so lifecycle tracking
		// updates live without needing a stop/start cycle.
		this.postMessage({ type: 'update-packages', data: { packages: this.selectedPackages.slice() } });
	}

	renderPackages() {
		this.packageChips.innerHTML = this.selectedPackages.map((p, i) =>
			`<span class="pkg-chip">${p.split('.').pop()}<span class="pkg-remove" title="${p}" onclick="${this.handle}.removePackage(${i})">\u00d7</span></span>`
		).join('');
		// Hide lifecycle badge if not exactly 1 package
		if (this.selectedPackages.length !== 1) {
			this.lifecycleStatus.style.display = 'none';
			this.lifecycleActions.style.display = 'none';
		}
		this.rebuildFilteredIndices();
	}

	removePackage(index) {
		this.selectedPackages.splice(index, 1);
		this.renderPackages();
		this._notifyPackagesChanged();
	}

	hidePackageDropdown() {
		this.packageDropdown.style.display = 'none';
	}

	_showPackageEvent(message) {
		// Briefly show package event in status bar
		const prev = this.statusText.textContent;
		this.statusText.textContent = `Package: ${message.substring(0, 60)}`;
		this.statusText.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
		setTimeout(() => {
			this.statusText.textContent = prev;
			this.statusText.style.color = '';
		}, 4000);
		// Refresh package list
		this.fetchPackages();
		// Re-fetch info for selected packages
		this.selectedPackages.forEach(pkg => {
			this.postMessage({ type: 'package-info', data: { deviceId: this.deviceSelect.value, packageName: pkg } });
		});
	}

	_showLifecycleEvent(data) {
		// Only show when exactly 1 package is selected
		if (this.selectedPackages.length !== 1) return;

		const labels = {
			'started': '▶ App Started',
			'displayed': '▶ App Displayed',
			'foreground': '▶ App in Foreground',
			'resumed': '▶ App Resumed',
			'paused': '⏸ App Paused',
			'background': '⏸ App in Background',
			'not-running': '⏹ App Not Running',
			'stopped': '⏹ App Stopped',
			'killed': '✖ App Killed',
			'died': '✖ App Died',
			'crashed': '💥 App Crashed',
			'anr': '⚠ App Not Responding',
			'force-stopped': '✖ App Force Stopped',
		};
		const label = labels[data.event] || data.event;

		// Update status badge
		this.lifecycleStatus.textContent = label;
		this.lifecycleStatus.className = `lifecycle-badge lifecycle-${data.event}`;
		this.lifecycleStatus.title = data.detail;
		this.lifecycleStatus.style.display = '';

		// Update action buttons (separate element)
		const actions = {
			'not-running': `<button class="lifecycle-action" onclick="${this.handle}.appAction('launch')">Launch</button><button class="lifecycle-action" onclick="${this.handle}.appAction('clear-data')">Clear Data</button>`,
			'killed': `<button class="lifecycle-action" onclick="${this.handle}.appAction('launch')">Launch</button>`,
			'died': `<button class="lifecycle-action" onclick="${this.handle}.appAction('launch')">Launch</button>`,
			'crashed': `<button class="lifecycle-action" onclick="${this.handle}.appAction('launch')">Relaunch</button>`,
			'force-stopped': `<button class="lifecycle-action" onclick="${this.handle}.appAction('launch')">Launch</button><button class="lifecycle-action" onclick="${this.handle}.appAction('clear-data')">Clear Data</button>`,
			'background': `<button class="lifecycle-action" onclick="${this.handle}.appAction('launch')">Bring to Front</button><button class="lifecycle-action" onclick="${this.handle}.appAction('force-stop')">Force Stop</button>`,
			'foreground': `<button class="lifecycle-action" onclick="${this.handle}.appAction('force-stop')">Force Stop</button>`,
		};
		const actionHtml = actions[data.event] || '';
		this.lifecycleActions.innerHTML = actionHtml;
		this.lifecycleActions.style.display = actionHtml ? '' : 'none';

		// Inject a lifecycle banner entry into the log stream
		const now = new Date();
		const ts = `${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
		this.queueLogEntry({
			timestamp: ts,
			pid: '',
			tid: '',
			priority: 'L',
			tag: 'Logcat Lens',
			message: label,
			pkg: data.pkg,
			_lifecycle: data.event,
		});
	}

	appAction(action) {
		if (this.selectedPackages.length !== 1) return;
		const deviceId = this.deviceSelect.value;
		const packageName = this.selectedPackages[0];
		this.postMessage({ type: `app-${action}`, data: { deviceId, packageName } });
	}

	_showPackageInfo(info) {
		// Update chip tooltip with version info
		const chips = this.packageChips.querySelectorAll('.pkg-chip');
		chips.forEach(chip => {
			const removeBtn = chip.querySelector('.pkg-remove');
			if (removeBtn && removeBtn.title === info.packageName) {
				chip.dataset.tooltip = `${info.packageName} v${info.version}${info.versionCode ? ' (' + info.versionCode + ')' : ''}`;
			}
		});
	}

	// ========================
	// TAG CHIPS
	// ========================
	initTagInput() {
		const input = this.tagTextInput;
		const dropdown = this.tagDropdown;

		input.addEventListener('keydown', (e) => {
			const items = dropdown.querySelectorAll('.tag-item');
			const active = dropdown.querySelector('.tag-item.active');

			if (e.key === 'Enter') {
				e.preventDefault();
				const val = (active ? active.textContent : input.value).trim();
				if (val && !this.tags.includes(val)) {
					this.tags.push(val);
					this.renderTags();
				}
				input.value = '';
				this.hideTagDropdown();
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				const next = active ? active.nextElementSibling || items[0] : items[0];
				active?.classList.remove('active');
				next?.classList.add('active');
				next?.scrollIntoView({ block: 'nearest' });
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				const prev = active ? active.previousElementSibling || items[items.length - 1] : items[items.length - 1];
				active?.classList.remove('active');
				prev?.classList.add('active');
				prev?.scrollIntoView({ block: 'nearest' });
			} else if (e.key === 'Escape') {
				this.hideTagDropdown();
			} else if (e.key === 'Backspace' && !input.value && this.tags.length) {
				this.tags.pop();
				this.activeTagGroup = null;
				this.tagGroupExpanded = false;
				this.renderTags();
			}
		});

		input.addEventListener('input', () => this.showTagDropdown(input.value));

		input.addEventListener('focus', () => {
			if (input.value) this.showTagDropdown(input.value);
		});

		document.addEventListener('click', (e) => {
			if (!input.contains(e.target) && !dropdown.contains(e.target)) {
				this.hideTagDropdown();
			}
			// Close tag group menu when clicking outside
			const menu = this.tagGroupMenu;
			if (menu && menu.style.display === 'block' && !menu.contains(e.target) && !e.target.closest('.tag-group-btn')) {
				menu.style.display = 'none';
			}
		});
	}

	showTagDropdown(filter) {
		const dropdown = this.tagDropdown;
		const query = (filter || '').toLowerCase();
		if (!query) { this.hideTagDropdown(); return; }

		const filtered = [...this.knownTags]
			.filter(t => t.toLowerCase().includes(query) && !this.tags.includes(t))
			.sort()
			.slice(0, 50);

		if (!filtered.length) { this.hideTagDropdown(); return; }

		dropdown.innerHTML = filtered.map(t =>
			`<div class="tag-item" onmousedown="${this.handle}.selectTag('${t.replace(/'/g, "\\'")}')">${t}</div>`
		).join('');
		dropdown.style.display = 'block';
	}

	selectTag(tag) {
		if (!this.tags.includes(tag)) {
			this.tags.push(tag);
			this.activeTagGroup = null;
			this.tagGroupExpanded = false;
			this.renderTags();
		}
		this.tagTextInput.value = '';
		this.hideTagDropdown();
	}

	hideTagDropdown() {
		this.tagDropdown.style.display = 'none';
	}

	renderTags() {
		if (this.activeTagGroup && !this.tagGroupExpanded) {
			// Show group chip with expand/clear
			this.tagChips.innerHTML = `<span class="tag-chip tag-group-active">
				<span class="tag-group-name" onclick="${this.handle}.toggleTagGroupExpand()">${this.activeTagGroup} (${this.tags.length})</span>
				<span class="tag-remove" onclick="${this.handle}.clearActiveTagGroup()">\u00d7</span>
			</span>`;
		} else {
			// Show individual tag chips
			let prefix = '';
			if (this.activeTagGroup && this.tagGroupExpanded) {
				prefix = `<span class="tag-chip tag-group-active">
					<span class="tag-group-name" onclick="${this.handle}.toggleTagGroupExpand()">${this.activeTagGroup} ▾</span>
				</span>`;
			}
			this.tagChips.innerHTML = prefix + this.tags.map((t, i) =>
				`<span class="tag-chip">${t}<span class="tag-remove" onclick="${this.handle}.removeTag(${i})">\u00d7</span></span>`
			).join('');
		}
		this.rebuildFilteredIndices();
	}

	removeTag(index) {
		this.tags.splice(index, 1);
		this.activeTagGroup = null;
		this.tagGroupExpanded = false;
		this.renderTags();
	}

	toggleTagGroupExpand() {
		this.tagGroupExpanded = !this.tagGroupExpanded;
		this.renderTags();
	}

	clearActiveTagGroup() {
		this.tags = [];
		this.activeTagGroup = null;
		this.tagGroupExpanded = false;
		this.renderTags();
	}

	// TAG GROUPS
	showTagGroupMenu() {
		const menu = this.tagGroupMenu;
		if (menu.style.display === 'block') { menu.style.display = 'none'; return; }

		const names = Object.keys(this.tagGroups);
		let html = '';
		if (this.tags.length > 0) {
			html += `<div class="tag-group-save">
				<span class="tag-group-save-label">Save current tags as group</span>
				<input type="text" id="tag-group-name-input" placeholder="Enter group name..." oninput="${this.handle}._updateSaveBtn()">
				<button id="tag-group-save-btn" onclick="${this.handle}.saveCurrentTagGroup()" disabled>Save Group</button>
			</div>`;
		}
		if (names.length) {
			html += '<div class="tag-group-list-header">Saved Groups</div><div class="tag-group-list">';
			names.forEach(name => {
				const tags = this.tagGroups[name];
				const esc = name.replace(/'/g, "\\'");
				html += `<div class="tag-group-item">
					<div class="tag-group-item-info" onclick="${this.handle}.loadTagGroup('${esc}')">
						<span class="tag-group-item-name">${name}</span>
						<span class="tag-group-item-tags">${tags.join(', ')}</span>
					</div>
					<span class="tag-group-item-delete" onclick="${this.handle}.deleteTagGroup('${esc}')" title="Delete group">&times;</span>
				</div>`;
			});
			html += '</div>';
		} else if (this.tags.length === 0) {
			html += '<div class="tag-group-empty">Add tags first, then save as a group</div>';
		}
		menu.innerHTML = html;
		menu.style.display = 'block';
		// Focus the input if present
		const input = this.querySelector('#tag-group-name-input');
		if (input) setTimeout(() => input.focus(), 50);
	}

	_updateSaveBtn() {
		const input = this.querySelector('#tag-group-name-input');
		const btn = this.querySelector('#tag-group-save-btn');
		if (btn) btn.disabled = !input?.value?.trim();
	}

	saveCurrentTagGroup() {
		const input = this.querySelector('#tag-group-name-input');
		const name = input?.value?.trim();
		if (!name || !this.tags.length) return;
		this.postMessage({ type: 'save-tag-group', data: { name, tags: [...this.tags] } });
		this.activeTagGroup = name;
		this.tagGroupExpanded = false;
		this.renderTags();
		this.tagGroupMenu.style.display = 'none';
	}

	loadTagGroup(name) {
		const group = this.tagGroups[name];
		if (!group) return;
		this.tags = [...group];
		this.activeTagGroup = name;
		this.tagGroupExpanded = false;
		this.renderTags();
		this.tagGroupMenu.style.display = 'none';
	}

	deleteTagGroup(name) {
		this.postMessage({ type: 'delete-tag-group', data: { name } });
	}

	// ========================
	// COLUMN RESIZE
	// ========================
	initColumnResize() {
		const cols = { timestamp: 160, tag: 180, pkg: 160, pid: 55, badge: 36 };
		const applyWidths = () => {
			const root = this.style;
			for (const [col, w] of Object.entries(cols)) {
				root.setProperty(`--col-${col}`, `${w}px`);
			}
		};
		applyWidths();

		this.colHeader.querySelectorAll('.col-resize').forEach(handle => {
			handle.addEventListener('mousedown', (e) => {
				e.preventDefault();
				const col = handle.dataset.col;
				const startX = e.clientX;
				const startW = cols[col];

				const onMove = (e) => {
					cols[col] = Math.max(30, startW + (e.clientX - startX));
					applyWidths();
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove);
					document.removeEventListener('mouseup', onUp);
				};
				document.addEventListener('mousemove', onMove);
				document.addEventListener('mouseup', onUp);
			});
		});
	}

	// ========================
	// SEARCH
	// ========================
	search(dir) {
		clearTimeout(this._searchDebounce);
		this._searchDebounce = setTimeout(() => this._doSearch(dir), 150);
	}

	_doSearch(dir) {
		const q = this.searchInput.value.toLowerCase();
		if (!q) return this.clearSearch();

		if (q != this.query) {
			this.query = q;
			if (this.searchFilterMode) this.rebuildFilteredIndices();
			this.matches = [];
			// Search only within currently visible (filtered) entries
			const count = this.getDisplayCount();
			for (let i = 0; i < count; i++) {
				const log = this.getLogAtDisplayIndex(i);
				if (this.matchesQuery(log, q)) {
					this.matches.push(this.getBufferIndexForDisplayIndex(i));
				}
			}
			this.currentMatch = -1;
		}

		if (this.matches.length == 0) return this.updateSearchUI();

		if (dir == 'next') {
			this.currentMatch++;
			if (this.currentMatch >= this.matches.length) this.currentMatch = 0;
		} else {
			this.currentMatch--;
			if (this.currentMatch < 0) this.currentMatch = this.matches.length - 1;
		}

		this.scrollToMatch(this.matches[this.currentMatch]);
		this.updateSearchUI();
	}

	toggleSearchFilter() {
		this.searchFilterMode = !this.searchFilterMode;
		this.searchFilterBtn.classList.toggle('active', this.searchFilterMode);
		this.rebuildFilteredIndices();
	}

	clearSearch() {
		this.matches = [];
		this.currentMatch = -1;
		this.query = '';
		this.updateSearchUI();
		if (this.searchFilterMode) this.rebuildFilteredIndices();
		// Re-render to clear active-match highlights
		if (this.softWrap) {
			this.viewport.querySelectorAll('.active-match').forEach(e => e.classList.remove('active-match'));
		} else {
			this._invalidateAllRows();
			this.renderVisibleRows();
		}
	}

	matchesQuery(log, query) {
		return log.text.includes((query || this.query).toLowerCase());
	}

	scrollToMatch(bufferIndex) {
		// Find the display index for this buffer index
		const displayIdx = this.filteredIndices.indexOf(bufferIndex);
		if (displayIdx === -1) return; // Match not visible with current filters

		if (this.softWrap) {
			// Ensure entry is in DOM range
			const domIdx = displayIdx - this._flowStart;
			if (domIdx < 0 || domIdx >= this.viewport.children.length) {
				this._rebuildFlowAround(displayIdx);
			}
			// Clear previous highlights
			this.viewport.querySelectorAll('.active-match').forEach(e => e.classList.remove('active-match'));
			const entry = this.viewport.children[displayIdx - this._flowStart];
			if (entry) {
				entry.classList.add('active-match');
				entry.scrollIntoView({ block: 'center' });
			}
		} else {
			const targetTop = displayIdx * this.ROW_HEIGHT;
			const viewHeight = this.logList.clientHeight;
			this.logList.scrollTop = targetTop - viewHeight / 2 + this.ROW_HEIGHT / 2;
			this._invalidateAllRows();
			this.renderVisibleRows();
		}

		this.autoScroll = false;
		this.updateScrollButtons();
	}

	_rebuildFlowAround(displayIdx) {
		const count = this.getDisplayCount();
		const half = Math.floor(this.SOFT_WRAP_MAX_DOM / 2);
		this._flowStart = Math.max(0, displayIdx - half);
		this._flowEnd = Math.min(count, this._flowStart + this.SOFT_WRAP_MAX_DOM);
		let html = '';
		for (let i = this._flowStart; i < this._flowEnd; i++) {
			const log = this.getLogAtDisplayIndex(i);
			if (!log) continue;
			html += `<entry class="${log.priority}${log._lifecycle ? ' lifecycle-entry lifecycle-' + log._lifecycle : ''}" data-buf-idx="${this.getBufferIndexForDisplayIndex(i)}">${this._entryHTML(log, this.getBufferIndexForDisplayIndex(i))}</entry>`;
		}
		this.viewport.innerHTML = html;
	}

	updateSearchUI() {
		const total = this.matches.length;
		const current = this.currentMatch >= 0 ? this.currentMatch + 1 : 0;
		this.searchMatches.textContent = !total ? (this.query ? 'No results' : '') : `${current} of ${total}`;
		this.prevButton.disabled = this.nextButton.disabled = !total;
	}

	// ========================
	// SCROLL CONTROLS
	// ========================
	scrollToTop() {
		this.logList.scrollTop = 0;
		this.autoScroll = false;
		this.updateScrollButtons();
	}

	scrollToBottom() {
		this.logList.scrollTop = this.logList.scrollHeight;
		this.autoScroll = true;
		this.updateScrollButtons();
	}

	updateScrollButtons() {
		this.scrollBottomBtn.classList.toggle('active', this.autoScroll);
	}

	// ========================
	// VIEW MODES
	// ========================
	_getMiddleDisplayIndex() {
		if (this.softWrap) {
			// Flow mode — find the entry element at the vertical center
			const midY = this.logList.scrollTop + this.logList.clientHeight / 2;
			const entries = this.viewport.children;
			for (let i = 0; i < entries.length; i++) {
				const top = entries[i].offsetTop;
				const bottom = top + entries[i].offsetHeight;
				if (midY >= top && midY < bottom) return i;
			}
			return Math.max(0, entries.length - 1);
		} else {
			// Virtual scroll — calculate from scroll position
			const midRow = Math.floor((this.logList.scrollTop + this.logList.clientHeight / 2) / this.ROW_HEIGHT);
			return Math.min(midRow, this.getDisplayCount() - 1);
		}
	}

	toggleSoftWrap() {
		// Save the middle display index before toggling
		const midDisplayIdx = this.getDisplayCount() > 0 ? this._getMiddleDisplayIndex() : -1;

		this.softWrap = !this.softWrap;
		this.logList.classList.toggle('soft-wrap', this.softWrap);
		this.softWrapBtn.classList.toggle('active', this.softWrap);

		if (this.softWrap) {
			this._enterFlowMode();
		} else {
			this._exitFlowMode();
		}

		// Restore scroll to the same display index
		if (midDisplayIdx >= 0 && !this.autoScroll) {
			this._scrollToDisplayIndex(midDisplayIdx);
		}
	}

	_scrollToDisplayIndex(displayIdx) {
		if (this.softWrap) {
			// Flow mode — scroll to the entry element
			const entry = this.viewport.children[displayIdx];
			if (entry) {
				this.logList.scrollTop = entry.offsetTop - this.logList.clientHeight / 2 + entry.offsetHeight / 2;
			}
		} else {
			// Virtual scroll — calculate from row height
			this.logList.scrollTop = displayIdx * this.ROW_HEIGHT - this.logList.clientHeight / 2 + this.ROW_HEIGHT / 2;
			this.renderVisibleRows();
		}
	}

	SOFT_WRAP_MAX_DOM = 500; // Max DOM entries in soft-wrap at a time
	SOFT_WRAP_LOAD_CHUNK = 200; // How many older entries to load when scrolling up

	_enterFlowMode() {
		// Clear virtual scroll entries and pool
		this._renderedEntries.clear();
		this._pool = [];
		this.viewport.innerHTML = '';
		this.viewport.style.height = 'auto';

		// Render only the last N display entries for performance
		const count = this.getDisplayCount();
		this._flowStart = Math.max(0, count - this.SOFT_WRAP_MAX_DOM);
		this._flowEnd = count;
		let html = '';
		for (let i = this._flowStart; i < this._flowEnd; i++) {
			const log = this.getLogAtDisplayIndex(i);
			if (!log) continue;
			html += `<entry class="${log.priority}${log._lifecycle ? ' lifecycle-entry lifecycle-' + log._lifecycle : ''}" data-buf-idx="${this.getBufferIndexForDisplayIndex(i)}">${this._entryHTML(log, this.getBufferIndexForDisplayIndex(i))}</entry>`;
		}
		this.viewport.innerHTML = html;

		if (this.autoScroll) this.logList.scrollTop = this.logList.scrollHeight;
	}

	_loadOlderEntries() {
		if (this._flowStart <= 0) return; // Nothing older to load

		const loadCount = Math.min(this.SOFT_WRAP_LOAD_CHUNK, this._flowStart);
		const newStart = this._flowStart - loadCount;

		// Save scroll position
		const oldHeight = this.logList.scrollHeight;

		// Prepend older entries
		let html = '';
		for (let i = newStart; i < this._flowStart; i++) {
			const log = this.getLogAtDisplayIndex(i);
			if (!log) continue;
			html += `<entry class="${log.priority}${log._lifecycle ? ' lifecycle-entry lifecycle-' + log._lifecycle : ''}" data-buf-idx="${this.getBufferIndexForDisplayIndex(i)}">${this._entryHTML(log, this.getBufferIndexForDisplayIndex(i))}</entry>`;
		}
		this.viewport.insertAdjacentHTML('afterbegin', html);
		this._flowStart = newStart;

		// Restore scroll position so view doesn't jump
		const heightDiff = this.logList.scrollHeight - oldHeight;
		this.logList.scrollTop += heightDiff;
	}

		_exitFlowMode() {
		// Clear flow entries and switch back to virtual scroll
		this.viewport.innerHTML = '';
		this._renderedEntries.clear();
		this._pool = [];
		this.updateVirtualHeight();
		this.renderVisibleRows();

		if (this.autoScroll) this.logList.scrollTop = this.logList.scrollHeight;
	}

	toggleViewMode() {
		this.viewMode = this.viewMode === 'standard' ? 'compact' : 'standard';
		const isCompact = this.viewMode === 'compact';
		this.logList.classList.toggle('compact', isCompact);
		this.colHeader.classList.toggle('compact', isCompact);
		this.viewModeBtn.classList.toggle('active', isCompact);
	}

	// ========================
	// COPY & EXPORT
	// ========================
	copyLogLine(event) {
		const entry = event.target.closest('entry');
		if (!entry) return;
		window.getSelection()?.removeAllRanges();
		const c = entry.children;
		const text = `${c[0]?.textContent || ''} ${c[1]?.textContent || ''} ${c[2]?.textContent || ''} ${c[3]?.textContent || ''} ${c[4]?.textContent || ''} ${c[5]?.textContent || ''}`.replace(/\s+/g, ' ').trim();
		this.postMessage({ type: 'copy', data: { text } });
	}

	exportLogs() {
		const count = this.getDisplayCount();
		const lines = [];
		for (let i = 0; i < count; i++) {
			const log = this.getLogAtDisplayIndex(i);
			lines.push(`${log.timestamp} ${log.pid || ''} ${log.tid || ''} ${log.priority} ${log.tag}: ${log.message}`);
		}
		this.postMessage({ type: 'export', data: { logs: lines.join('\n') } });
	}

	// ========================
	// MISC
	// ========================
	toggleLoading(force) {
		this.loadingBar.style.display = force ? '' : 'none';
	}

	render() {
		return `
			<loading id="loading-bar" class="progress" style="display: none;"></loading>

			<div id="adb-missing-overlay" class="adb-missing-overlay" style="display:none;">
				<div class="adb-missing-content">
					<div class="adb-missing-icon">&#9888;</div>
					<h3>ADB Not Found</h3>
					<p>Android Debug Bridge (ADB) is required to stream device logs.</p>
					<div class="adb-missing-actions">
						<button id="adb-install-btn" class="adb-btn primary" onclick="${this.handle}.postMessage({type:'install-adb'});this.disabled=true;this.textContent='Installing...';">Install ADB</button>
						<button class="adb-btn" onclick="${this.handle}.postMessage({type:'open-adb-download'})">Download Page</button>
						<button class="adb-btn" onclick="${this.handle}.postMessage({type:'open-adb-settings'})">Set Path</button>
					</div>
					<p class="adb-missing-hint">Already installed? Set the path in Settings &gt; Logcat Lens &gt; Adb Path</p>
				</div>
			</div>

			<sidebar>
				<button id="pause-play-button" class="ic play" data-tooltip="Pause" onclick="${this.handle}.togglePausePlay()" disabled></button>
				<div class="separator"></div>
				<button class="ic clear" data-tooltip="Clear Logs" onclick="${this.handle}.clear()"></button>
				<button class="ic scroll-top" data-tooltip="Scroll to Top" onclick="${this.handle}.scrollToTop()"></button>
				<button id="scroll-bottom-btn" class="ic scroll-bottom active" data-tooltip="Scroll to Bottom" onclick="${this.handle}.scrollToBottom()"></button>
				<button id="soft-wrap-btn" class="ic soft-wrap" data-tooltip="Soft Wrap" onclick="${this.handle}.toggleSoftWrap()"></button>
				<button id="view-mode-btn" class="ic view-mode" data-tooltip="Compact View" onclick="${this.handle}.toggleViewMode()"></button>
				<div class="separator"></div>
				<button class="ic export" data-tooltip="Export Logs" onclick="${this.handle}.exportLogs()"></button>
			</sidebar>

			<div class="content">
				<status-bar>
					<span id="status-text">Not Started</span>
					<button id="status-action-btn" class="ic play" data-tooltip="Start" onclick="${this.handle}.statusAction()"></button>
					<span id="lifecycle-status" class="lifecycle-badge" style="display:none;"></span>
					<span id="lifecycle-actions" class="lifecycle-actions" style="display:none;"></span>
				</status-bar>

				<filter-bar>
					<div class="filter-group">
						<select id="device-select">
							<option value="">Select a device...</option>
						</select>
						<button class="ic refresh" data-tooltip="Refresh Devices" onclick="${this.handle}.refreshDevices()"></button>
					</div>

					<div class="filter-group tag-group">
						<div id="tag-chips" class="tag-chips"></div>
						<input type="text" id="tag-text-input" placeholder="Tags" autocomplete="off">
						<div id="tag-dropdown" class="autocomplete-dropdown" style="display:none;"></div>
						<button class="ic tag-group-btn" data-tooltip="Tag Groups" onclick="${this.handle}.showTagGroupMenu()"></button>
						<div id="tag-group-menu" class="tag-group-menu" style="display:none;"></div>
					</div>

					<div class="filter-group package-group">
						<div class="pkg-chips-scroll"><div id="package-chips" class="tag-chips"></div></div>
						<input type="text" id="package-input" placeholder="Package" autocomplete="off">
						<div id="package-dropdown" class="autocomplete-dropdown" style="display:none;"></div>
					</div>

					<div id="level-chips" class="level-chips"></div>

					<div class="filter-group search-group">
						<input type="search" id="search-input" onsearch="${this.handle}.search('next')" placeholder="Search logs...">
						<span id="search-matches"></span>
						<button id="prev-button" class="ic arrow-up" disabled title="Previous" onclick="${this.handle}.search('prev')"></button>
						<button id="next-button" class="ic arrow-down" disabled title="Next" onclick="${this.handle}.search('next')"></button>
						<button id="search-filter-btn" class="ic search-filter" data-tooltip="Filter by Search" onclick="${this.handle}.toggleSearchFilter()"></button>
					</div>
				</filter-bar>

				<column-header id="col-header">
					<span class="col col-timestamp" data-col="timestamp">Timestamp<span class="col-resize" data-col="timestamp"></span></span>
					<span class="col col-tag" data-col="tag">Tag<span class="col-resize" data-col="tag"></span></span>
					<span class="col col-pkg" data-col="pkg">Package<span class="col-resize" data-col="pkg"></span></span>
					<span class="col col-pid" data-col="pid">PID<span class="col-resize" data-col="pid"></span></span>
					<span class="col col-badge" data-col="badge">Lvl<span class="col-resize" data-col="badge"></span></span>
					<span class="col col-message">Message</span>
				</column-header>

				<div id="pause-banner" class="pause-banner" style="display:none;">Logcat is paused</div>
				<div class="log-body">
					<main id="log-list" ondblclick="${this.handle}.copyLogLine(event)">
						<div id="viewport"></div>
					</main>

					<div id="log-detail-pane" class="log-detail-pane" style="display:none;">
						<div id="log-detail-resize" class="log-detail-resize" title="Drag to resize"></div>
						<div class="log-detail-header">
							<span id="log-detail-title">Details</span>
							<button id="log-detail-copy" class="log-detail-btn ic-only" data-tooltip="Copy" title="Copy">⧉</button>
							<button id="log-detail-close" class="log-detail-btn ic-only" data-tooltip="Close" title="Close">×</button>
						</div>
						<div id="log-detail-body" class="log-detail-body"></div>
					</div>
				</div>
			</div>

		`;
	}
}

customElements.define('logcat-lens', Logcat);
