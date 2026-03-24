class Logcat extends HTMLElementBase {
	BUFFER_SIZE = 100000;    // Can be huge now — only JS array, not DOM
	ROW_HEIGHT = 18;         // Fixed row height in px (line-height: 1.5 * 12px)
	OVERSCAN = 20;           // Extra rows rendered above/below viewport

	buffer = [];             // All log objects
	filteredIndices = null;  // null = no filter active, array = indices into buffer that pass filters

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
	selectedLevels = new Set(['V', 'D', 'I', 'W', 'E', 'F']); // All on by default

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
		this.initPackageAutocomplete();
		this.initTagInput();
		this.initColumnResize();
		this.renderLevelChips();
		this.refreshDevices();
		this.updateStatus();
	}

	onMessage(event) {
		event = event.data;

		switch (event.type) {
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
			case 'log':
				if (!this.isPaused) this.queueLogEntry(event.data.log);
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
		this.filteredIndices = null;
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
		return this.filteredIndices ? this.filteredIndices.length : this.buffer.length;
	}

	getLogAtDisplayIndex(displayIdx) {
		if (this.filteredIndices) {
			return this.buffer[this.filteredIndices[displayIdx]];
		}
		return this.buffer[displayIdx];
	}

	getBufferIndexForDisplayIndex(displayIdx) {
		if (this.filteredIndices) {
			return this.filteredIndices[displayIdx];
		}
		return displayIdx;
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
			el.className = log.priority + (activeMatchBufIdx === bufIdx ? ' active-match' : '');
			el.style.transform = `translateY(${i * this.ROW_HEIGHT}px)`;
			el.children.length === 0
				? el.innerHTML = this._entryHTML(log)
				: this._updateEntry(el, log);

			this._renderedEntries.set(i, { el, bufIdx });
		}

		this._visibleStart = startRow;
		this._visibleEnd = endRow;
	}

	_entryHTML(log) {
		return `<timestamp>${log.timestamp}</timestamp><tag>${(log.tag || '').trim()}</tag><pkg>${log.pkg || ''}</pkg><pid>${log.pid || ''}</pid><badge>${log.priority}</badge><message>${this.escapeHtml(log.message)}</message>`;
	}

	_updateEntry(el, log) {
		const c = el.children;
		c[0].textContent = log.timestamp;
		c[1].textContent = (log.tag || '').trim();
		c[2].textContent = log.pkg || '';
		c[3].textContent = log.pid || '';
		c[4].textContent = log.priority;
		c[5].textContent = log.message;
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
	LEVEL_ORDER = ['V', 'D', 'I', 'W', 'E', 'F'];
	LEVEL_NAMES = { V: 'Verbose', D: 'Debug', I: 'Info', W: 'Warning', E: 'Error', F: 'Fatal' };

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
			return `<span class="level-chip level-${l}${active ? ' active' : ''}" onclick="${this.handle}.toggleLevel('${l}')">${l}</span>`;
		}).join('');
	}

	rebuildFilteredIndices() {
		const hasTags = this.tags.length > 0;
		const hasPkgs = this.selectedPackages.length > 0;
		const allLevels = this.selectedLevels.size === 6;
		const hasLevel = !allLevels;

		if (!hasTags && !hasPkgs && !hasLevel) {
			this.filteredIndices = null;
		} else {
			this.filteredIndices = [];
			for (let i = 0; i < this.buffer.length; i++) {
				const log = this.buffer[i];
				if (hasLevel && !this.selectedLevels.has(log.priority)) continue;
				if (hasTags && !this.tags.includes((log.tag || '').trim())) continue;
				if (hasPkgs && !this.selectedPackages.some(p => (log.pkg || '').includes(p))) continue;
				this.filteredIndices.push(i);
			}
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

		this.updateVirtualHeight();
		this._invalidateAllRows();
		this.renderVisibleRows();

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

		const allLevels = this.selectedLevels.size === 6;
		const hasLevel = !allLevels;
		const hasTags = this.tags.length > 0;
		const hasPkgs = this.selectedPackages.length > 0;
		const hasFilter = hasLevel || hasTags || hasPkgs;

		for (let i = 0; i < logs.length; i++) {
			const log = logs[i];
			const bufIdx = this.buffer.length;
			this.buffer.push(log);

			// Update filtered indices
			if (this.filteredIndices !== null) {
				let pass = true;
				if (hasLevel && !this.selectedLevels.has(log.priority)) pass = false;
				if (hasTags && !this.tags.includes((log.tag || '').trim())) pass = false;
				if (hasPkgs && !this.selectedPackages.some(p => (log.pkg || '').includes(p))) pass = false;
				if (pass) this.filteredIndices.push(bufIdx);
			} else if (hasFilter) {
				// Filters are active but filteredIndices was null (first time) — rebuild
				this.rebuildFilteredIndices();
				return; // rebuildFilteredIndices handles the rest
			}

			// Update search matches
			if (this.query && this.matchesQuery(log)) {
				this.matches.push(bufIdx);
			}
		}

		if (this.query) this.updateSearchUI();

		// Trim buffer if too large
		this.trimBuffer();

		if (this.softWrap) {
			// Flow mode — append new visible entries
			const filterSet = this.filteredIndices ? new Set(this.filteredIndices.slice(-this.SOFT_WRAP_MAX_DOM)) : null;
			let html = '';
			const startIdx = this.buffer.length - logs.length;
			for (let i = 0; i < logs.length; i++) {
				const bufIdx = startIdx + i;
				if (filterSet && !filterSet.has(bufIdx)) continue;
				const log = logs[i];
				html += `<entry class="${log.priority}">${this._entryHTML(log)}</entry>`;
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
		if (this.filteredIndices) {
			this.filteredIndices = this.filteredIndices
				.map(idx => idx - removeCount)
				.filter(idx => idx >= 0);
		}

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
		this.deviceSelect.innerHTML = devices.length
			? devices.map(d => `<option value="${d.id}">${d.model}</option>`).join('')
			: '<option value="">No devices found</option>';
		if (devices.length) {
			this.fetchPackages();
			this.fetchTags();
		}
	}

	// ========================
	// TOOLTIPS
	// ========================
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
			tip.style.left = (lastEvent.pageX + 12) + 'px';
			tip.style.top = (lastEvent.pageY + 16) + 'px';
			tip.style.display = 'block';
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
		}
		this.packageInput.value = '';
		this.hidePackageDropdown();
	}

	renderPackages() {
		this.packageChips.innerHTML = this.selectedPackages.map((p, i) =>
			`<span class="pkg-chip">${p.split('.').pop()}<span class="pkg-remove" title="${p}" onclick="${this.handle}.removePackage(${i})">\u00d7</span></span>`
		).join('');
		this.rebuildFilteredIndices();
	}

	removePackage(index) {
		this.selectedPackages.splice(index, 1);
		this.renderPackages();
	}

	hidePackageDropdown() {
		this.packageDropdown.style.display = 'none';
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
			this.renderTags();
		}
		this.tagTextInput.value = '';
		this.hideTagDropdown();
	}

	hideTagDropdown() {
		this.tagDropdown.style.display = 'none';
	}

	renderTags() {
		this.tagChips.innerHTML = this.tags.map((t, i) =>
			`<span class="tag-chip">${t}<span class="tag-remove" onclick="${this.handle}.removeTag(${i})">\u00d7</span></span>`
		).join('');
		this.rebuildFilteredIndices();
	}

	removeTag(index) {
		this.tags.splice(index, 1);
		this.renderTags();
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
			this.matches = [];
			for (let i = 0; i < this.buffer.length; i++) {
				if (this.matchesQuery(this.buffer[i], q)) this.matches.push(i);
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

	clearSearch() {
		this.matches = [];
		this.currentMatch = -1;
		this.query = '';
		this.updateSearchUI();
		// Re-render to clear active-match highlights
		this._invalidateAllRows();
		this.renderVisibleRows();
	}

	matchesQuery(log, query) {
		return log.text.includes((query || this.query).toLowerCase());
	}

	scrollToMatch(bufferIndex) {
		// Find the display index for this buffer index
		let displayIdx;
		if (this.filteredIndices) {
			displayIdx = this.filteredIndices.indexOf(bufferIndex);
			if (displayIdx === -1) return; // Match not visible with current filters
		} else {
			displayIdx = bufferIndex;
		}

		// Scroll to that row
		const targetTop = displayIdx * this.ROW_HEIGHT;
		const viewHeight = this.logList.clientHeight;
		this.logList.scrollTop = targetTop - viewHeight / 2 + this.ROW_HEIGHT / 2;
		this.autoScroll = false;
		this.updateScrollButtons();

		// Re-render to show the active-match highlight
		this._invalidateAllRows();
		this.renderVisibleRows();
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
			html += `<entry class="${log.priority}">${this._entryHTML(log)}</entry>`;
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
			html += `<entry class="${log.priority}">${this._entryHTML(log)}</entry>`;
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
		this.postMessage({ type: 'copy', data: { text: entry.textContent } });
	}

	exportLogs() {
		const text = this.buffer.map(log =>
			`${log.timestamp} ${log.pid || ''} ${log.tid || ''} ${log.priority} ${log.tag}: ${log.message}`
		).join('\n');
		this.postMessage({ type: 'export', data: { logs: text } });
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
				<main id="log-list" ondblclick="${this.handle}.copyLogLine(event)">
					<div id="viewport"></div>
				</main>
			</div>
		`;
	}
}

customElements.define('logcat-lens', Logcat);
