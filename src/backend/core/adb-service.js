const { spawn, exec, execSync } = require('child_process');
const { platform, homedir } = require('os');
const { existsSync, mkdirSync, createWriteStream, chmodSync } = require('fs');
const { join } = require('path');
const https = require('https');
const EventEmitter = require('events');
const vscode = require('vscode');

function findAdb() {
	// 1. User-configured path takes priority
	const configured = vscode.workspace.getConfiguration('logcatLens').get('adbPath');
	if (configured && existsSync(configured)) return configured;

	// 2. ANDROID_HOME / ANDROID_SDK_ROOT env vars
	const home = homedir();
	const envDirs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean);
	for (const dir of envDirs) {
		const p = join(dir, 'platform-tools', platform() === 'win32' ? 'adb.exe' : 'adb');
		if (existsSync(p)) return p;
	}

	// 3. Common SDK install locations per platform
	const candidates = platform() === 'win32' ? [
		join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
		'C:\\Android\\sdk\\platform-tools\\adb.exe',
	] : platform() === 'darwin' ? [
		join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
		'/opt/homebrew/bin/adb',
		'/usr/local/bin/adb',
	] : [
		join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
		'/usr/local/bin/adb',
		'/usr/bin/adb',
	];

	for (const p of candidates) {
		if (existsSync(p)) return p;
	}

	// 4. Check if adb is on PATH (works when launched from terminal)
	try {
		const cmd = platform() === 'win32' ? 'where adb' : 'which adb';
		const result = execSync(cmd, { timeout: 5000 }).toString().trim().split('\n')[0];
		if (result && existsSync(result)) return result;
	} catch { /* not on PATH */ }

	// 5. Not found
	return null;
}

const PLATFORM_TOOLS_URLS = {
	darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
	linux: 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
	win32: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
};

function isAdbAvailable() {
	return findAdb() !== null;
}

async function downloadAndInstallAdb() {
	const url = PLATFORM_TOOLS_URLS[platform()];
	if (!url) {
		vscode.window.showErrorMessage('Unsupported platform for automatic ADB install.');
		return false;
	}

	const home = homedir();
	const installDir = platform() === 'win32'
		? join(home, 'AppData', 'Local', 'Android', 'Sdk')
		: platform() === 'darwin'
			? join(home, 'Library', 'Android', 'sdk')
			: join(home, 'Android', 'Sdk');
	const zipPath = join(installDir, 'platform-tools.zip');
	const adbBin = join(installDir, 'platform-tools', platform() === 'win32' ? 'adb.exe' : 'adb');

	mkdirSync(installDir, { recursive: true });

	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Logcat Lens: Installing ADB',
		cancellable: false,
	}, async (progress) => {
		progress.report({ message: 'Downloading platform-tools...' });

		await new Promise((resolve, reject) => {
			const follow = (url) => {
				https.get(url, (res) => {
					if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
						return follow(res.headers.location);
					}
					if (res.statusCode !== 200) {
						return reject(new Error(`Download failed (HTTP ${res.statusCode})`));
					}
					const total = parseInt(res.headers['content-length'], 10) || 0;
					let downloaded = 0;
					const file = createWriteStream(zipPath);
					res.on('data', (chunk) => {
						downloaded += chunk.length;
						if (total) progress.report({ message: `Downloading... ${Math.round(downloaded / total * 100)}%` });
					});
					res.pipe(file);
					file.on('finish', () => file.close(resolve));
					file.on('error', reject);
				}).on('error', reject);
			};
			follow(url);
		});

		progress.report({ message: 'Extracting...' });
		const unzipCmd = platform() === 'win32'
			? `powershell -command "Expand-Archive -Force '${zipPath}' '${installDir}'"`
			: platform() === 'darwin'
				? `ditto -xk "${zipPath}" "${installDir}"`
				: `unzip -o "${zipPath}" -d "${installDir}"`;
		try {
			await new Promise((resolve, reject) => {
				exec(unzipCmd, (err) => err ? reject(err) : resolve());
			});
		} catch (extractErr) {
			// Linux fallback: try python3 if unzip isn't installed
			if (platform() === 'linux') {
				await new Promise((resolve, reject) => {
					exec(`python3 -c "import zipfile; zipfile.ZipFile('${zipPath}').extractall('${installDir}')"`,
						(err) => err ? reject(err) : resolve());
				});
			} else {
				throw extractErr;
			}
		}

		if (platform() !== 'win32') chmodSync(adbBin, 0o755);

		// Clean up zip
		try { require('fs').unlinkSync(zipPath); } catch { /* ignore */ }

		// Auto-configure the setting and refresh cached path
		await vscode.workspace.getConfiguration('logcatLens').update('adbPath', adbBin, vscode.ConfigurationTarget.Global);
		_adbPath = adbBin;
		_adbWarningShown = false;

		vscode.window.showInformationMessage(`ADB installed to ${adbBin}`);
		return true;
	});
}

let _adbPath;
let _adbWarningShown = false;
function getAdb() {
	if (!_adbPath) _adbPath = findAdb();
	if (!_adbPath && !_adbWarningShown) {
		_adbWarningShown = true;
		vscode.window.showErrorMessage(
			'ADB not found. Install it directly, download manually, or set the path.',
			'Install ADB', 'Download Page', 'Set Path'
		).then(choice => {
			if (choice === 'Install ADB') {
				downloadAndInstallAdb();
			} else if (choice === 'Download Page') {
				vscode.env.openExternal(vscode.Uri.parse('https://developer.android.com/tools/releases/platform-tools'));
			} else if (choice === 'Set Path') {
				vscode.commands.executeCommand('workbench.action.openSettings', 'logcatLens.adbPath');
			}
		});
	}
	return _adbPath || 'adb';
}

// Reset cached path when settings change
vscode.workspace.onDidChangeConfiguration(e => {
	if (e.affectsConfiguration('logcatLens.adbPath')) _adbPath = null;
});

class ADBService extends EventEmitter {
	logcatProcess;

	_exec(cmd, opts, cb) {
		if (typeof opts === 'function') { cb = opts; opts = {}; }
		const adb = getAdb();
		return exec(cmd.replace(/\badb\b/, `"${adb}"`), opts, cb);
	}

	_spawn(args) {
		return spawn(getAdb(), args);
	}

	listDevices() {
		return new Promise((resolve, reject) => {
			this._exec('adb devices -l', (error, stdout, stderr) => {
				if (error) return reject(error);

				const lines = stdout.split('List of devices attached').pop().trim()
					.split('\n').map(l => l.trim()).filter(l => l);

				const devices = lines.map(line => {
					const matches = line.match(/(^\S+)/);
					if (!matches) return null;
					const id = matches[1];
					const modelMatch = line.match(/model:(\S+)/);
					const model = modelMatch ? modelMatch[1] : id;
					const status = line.includes('unauthorized') ? 'unauthorized'
						: line.includes('offline') ? 'offline' : 'online';
					return { id, model, status, raw: line };
				}).filter(Boolean);

				resolve(devices);
			});
		});
	}

	startDeviceTracking() {
		if (this._trackProcess) return;
		this._trackProcess = this._spawn(['track-devices']);
		this._trackProcess.stdout.on('data', () => {
			this.emit('adbevent', { type: 'adb.devices-changed' });
		});
		this._trackProcess.on('close', () => {
			this._trackProcess = null;
			this._trackRetry = setTimeout(() => this.startDeviceTracking(), 3000);
		});
		this._trackProcess.on('error', () => {
			this._trackProcess = null;
		});
	}

	stopDeviceTracking() {
		clearTimeout(this._trackRetry);
		this._trackProcess?.kill();
		this._trackProcess = null;
	}

	listPackages(deviceId) {
		return new Promise((resolve, reject) => {
			this._exec(`adb -s ${deviceId} shell pm list packages -3`, (error, stdout, stderr) => {
				if (error) return reject(error);
				const packages = stdout.split('\n')
					.map(l => l.replace('package:', '').trim())
					.filter(Boolean)
					.sort();
				resolve(packages);
			});
		});
	}

	listTags(deviceId) {
		return new Promise((resolve, reject) => {
			this._exec(`adb -s ${deviceId} logcat -d -v tag`, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
				if (error) return reject(error);
				const tags = new Set();
				stdout.split('\n').forEach(line => {
					const match = line.match(/^[VDIWEF]\/([^(\s:]+)/);
					if (match) tags.add(match[1].trim());
				});
				resolve([...tags].sort());
			});
		});
	}

	getUID(deviceId, packageName) {
		return new Promise((resolve, reject) => {
			const filter = platform() == 'win32' ? 'FINDSTR' : 'grep';
			this._exec(`adb -s ${deviceId} shell dumpsys package ${packageName} | ${filter} uid`, (error, stdout, stderr) => {
				if (error) return reject(error);

				// sample: uid=10520 gids=[] type=0 prot=signature
				const uid = stdout.trim().match(/uid=(\d+)/)?.[1];
				uid ? resolve(uid) : reject('Package not found.');
			});
		});
	}

	getAppState(deviceId, packageName) {
		return new Promise((resolve) => {
			// Check if process is running
			this._exec(`adb -s ${deviceId} shell pidof ${packageName}`, (err1, pidOut) => {
				const pid = pidOut?.trim();
				if (!pid) {
					return resolve({ packageName, state: 'not-running', pid: null });
				}
				// Check if it's the foreground app
				this._exec(`adb -s ${deviceId} shell "dumpsys activity activities | grep mResumedActivity"`, (err2, actOut) => {
					const isForeground = actOut?.includes(packageName);
					resolve({
						packageName,
						state: isForeground ? 'foreground' : 'background',
						pid,
					});
				});
			});
		});
	}

	getPackageInfo(deviceId, packageName) {
		return new Promise((resolve, reject) => {
			this._exec(`adb -s ${deviceId} shell dumpsys package ${packageName} | grep -E "versionName|versionCode"`, (error, stdout) => {
				if (error) return reject(error);
				const version = stdout.match(/versionName=(\S+)/)?.[1] || 'unknown';
				const versionCode = stdout.match(/versionCode=(\d+)/)?.[1] || '';
				resolve({ packageName, version, versionCode });
			});
		});
	}

	launchApp(deviceId, packageName) {
		return new Promise((resolve, reject) => {
			this._exec(`adb -s ${deviceId} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, (error) => {
				if (error) return reject(error);
				resolve();
			});
		});
	}

	forceStopApp(deviceId, packageName) {
		return new Promise((resolve, reject) => {
			this._exec(`adb -s ${deviceId} shell am force-stop ${packageName}`, (error) => {
				if (error) return reject(error);
				resolve();
			});
		});
	}

	clearAppData(deviceId, packageName) {
		return new Promise((resolve, reject) => {
			this._exec(`adb -s ${deviceId} shell pm clear ${packageName}`, (error) => {
				if (error) return reject(error);
				resolve();
			});
		});
	}

	refreshPidMap(deviceId) {
		this._exec(`adb -s ${deviceId} shell ps -A -o PID,NAME`, (error, stdout) => {
			if (error) return;
			this.pidMap = {};
			stdout.split('\n').forEach(line => {
				const match = line.trim().match(/^(\d+)\s+(.+)$/);
				if (match) this.pidMap[match[1]] = match[2];
			});
		});
	}

	async start({ deviceId, packages, packageName, tag, level, search }) {
		this.stop();

		if (!deviceId) throw new Error('Please connect to a device and make sure it is authorized.');

		// Store params for restart
		this.lastParams = { deviceId, packages, packageName, tag, level, search };

		// Build PID→package map and refresh every 30s
		this.pidMap = this.pidMap || {};
		this.refreshPidMap(deviceId);
		this._pidInterval = setInterval(() => this.refreshPidMap(deviceId), 30000);

		// App lifecycle tracking for single-package mode
		if (packages && packages.length === 1) {
			const pkg = packages[0];
			this._lastAppState = null;
			this._appStateRunning = true;

			const pollLoop = () => {
				if (!this._appStateRunning) return;
				this.getAppState(deviceId, pkg).then(state => {
					if (state.state !== this._lastAppState) {
						this._lastAppState = state.state;
						this.emit('adbevent', {
							type: 'adb.lifecycle',
							data: { event: state.state, pkg, detail: `${state.state} (PID: ${state.pid || 'none'})` }
						});
					}
					// Schedule next check after a short delay (serialized, no overlap)
					if (this._appStateRunning) {
						this._appStateTimeout = setTimeout(pollLoop, 100);
					}
				}).catch(() => {
					if (this._appStateRunning) {
						this._appStateTimeout = setTimeout(pollLoop, 500);
					}
				});
			};
			pollLoop();
		}

		// Always stream everything at Verbose — all filtering is client-side
		// -T 1 = only new logs from now, avoids replaying old buffer on stop/start
		const args = ['-s', deviceId, 'logcat', '-T', '1', '*:V'];

		this.logcatProcess = this._spawn(args);

		// Buffer partial lines across data chunks
		let lineBuffer = '';

		this.logcatProcess.stdout.on('data', (data) => {
			lineBuffer += data.toString();
			const lines = lineBuffer.split('\n');
			// Keep last element (may be incomplete line)
			lineBuffer = lines.pop();

			const batch = [];
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line) continue;

				const parts = line.match(/^(\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]+):\s+(.*)$/);
				if (!parts) continue;

				batch.push({
					timestamp: parts[1],
					pid: parts[2],
					tid: parts[3],
					priority: parts[4],
					tag: parts[5],
					message: parts[6],
					pkg: this.pidMap?.[parts[2]] || ''
				});
			}

			// Emit each log individually for compatibility with the message protocol
			for (let i = 0; i < batch.length; i++) {
				this.emit('adbevent', {
					type: 'adb.log',
					data: batch[i]
				});

				// Detect package install/uninstall/update events
				const tag = batch[i].tag?.trim();
				if ((tag === 'PackageManager' || tag === 'PackageInstaller') &&
					/\b(install|uninstall|remove|replace|update)\b/i.test(batch[i].message)) {
					this.refreshPidMap(deviceId);
					setTimeout(() => this.refreshPidMap(deviceId), 2000);
					this.emit('adbevent', {
						type: 'adb.package-changed',
						data: { message: batch[i].message, tag }
					});
				}

				// Detect app lifecycle events for tracked packages
				const msg = batch[i].message;
				const trackedPkgs = this.lastParams?.packages || [];
				if (trackedPkgs.length > 0) {
					let lifecycle = null;
					if (tag === 'ActivityManager') {
						for (const pkg of trackedPkgs) {
							if (msg.includes(pkg)) {
								if (/^Start proc\b/.test(msg)) {
									lifecycle = { event: 'started', pkg, detail: msg };
									this.refreshPidMap(deviceId);
									setTimeout(() => this.refreshPidMap(deviceId), 1500);
								} else if (/^Displayed\b/.test(msg)) {
									lifecycle = { event: 'displayed', pkg, detail: msg };
								} else if (/\bKilling\b/.test(msg)) {
									lifecycle = { event: 'killed', pkg, detail: msg };
									this.refreshPidMap(deviceId);
								} else if (/\bANR in\b/.test(msg)) {
									lifecycle = { event: 'anr', pkg, detail: msg };
								} else if (/\bForce stopping\b/.test(msg)) {
									lifecycle = { event: 'force-stopped', pkg, detail: msg };
								} else if (/\bProcess .* has died\b/.test(msg)) {
									lifecycle = { event: 'died', pkg, detail: msg };
									this.refreshPidMap(deviceId);
								}
								break;
							}
						}
					} else if (tag === 'ActivityTaskManager') {
						for (const pkg of trackedPkgs) {
							if (msg.includes(pkg)) {
								if (/\bmovedToFront\b|\btopResumedActivity\b|\bResume\b.*\bActivity\b/.test(msg)) {
									lifecycle = { event: 'foreground', pkg, detail: msg };
								} else if (/\bmoveToBack\b|\bPause\b.*\bActivity\b/.test(msg)) {
									lifecycle = { event: 'background', pkg, detail: msg };
								}
								break;
							}
						}
					} else if (tag === 'AndroidRuntime' && /^FATAL EXCEPTION/.test(msg)) {
						const crashPkg = this.pidMap?.[batch[i].pid];
						if (crashPkg && trackedPkgs.some(p => crashPkg.includes(p))) {
							lifecycle = { event: 'crashed', pkg: crashPkg, detail: msg };
						}
					}
					// Also detect resume/pause from the app's own Activity logs
					if (!lifecycle && trackedPkgs.length === 1) {
						const appPkg = this.pidMap?.[batch[i].pid];
						if (appPkg && trackedPkgs.some(p => appPkg.includes(p))) {
							if (/\bonResume\b/.test(msg)) {
								lifecycle = { event: 'resumed', pkg: appPkg, detail: `${tag}: ${msg}` };
							} else if (/\bonPause\b/.test(msg)) {
								lifecycle = { event: 'paused', pkg: appPkg, detail: `${tag}: ${msg}` };
							} else if (/\bonStop\b/.test(msg)) {
								lifecycle = { event: 'stopped', pkg: appPkg, detail: `${tag}: ${msg}` };
							}
						}
					}
					if (lifecycle) {
						this.emit('adbevent', { type: 'adb.lifecycle', data: lifecycle });
					}
				}
			}
		});

		this.logcatProcess.stderr.on('data', (data) => {
			console.error(`adb stderr: ${data}`);
			this.emit('adbevent', {
				type: 'adb.error',
				data: data
			});
		});

		this.logcatProcess.on('close', (code) => {
			console.log(`adb process exited with code ${code}`);
			this.emit('adbevent', {
				type: 'adb.closed',
				data: code
			});
		});
	}

	stop() {
		this.logcatProcess?.kill();
		this.logcatProcess = null;
		clearInterval(this._pidInterval);
		this._appStateRunning = false;
		clearTimeout(this._appStateTimeout);
		this._lastAppState = null;
	}

	async restart(params) {
		this.stop();
		this.clear();
		await this.start(params || this.lastParams);
	}

	clear(deviceId) {
		const device = deviceId || this.lastParams?.deviceId;
		if (device) this._exec(`adb -s ${device} logcat -c`);
		else this._exec(`adb logcat -c`);
	}
}

module.exports = ADBService;
module.exports.isAdbAvailable = isAdbAvailable;
module.exports.downloadAndInstallAdb = downloadAndInstallAdb;
module.exports.resetAdbCache = () => { _adbPath = null; _adbWarningShown = false; };
