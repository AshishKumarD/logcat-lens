const vscode = require('vscode');

const vsc = require('./core/vsc');
const util = require('./core/utils');
const AdbService = require('./core/adb-service');
const { isAdbAvailable, downloadAndInstallAdb, resetAdbCache } = require('./core/adb-service');

module.exports = class MainViewProvider {
	#view;
	#extensionURI;
	#paused = false;
	adb;

	constructor(context) {
		this.#extensionURI = context.extensionUri;
		this.adb = new AdbService();
		this.adb.on('adbevent', (event) => this.#onMessage(event));
		this.adb.startDeviceTracking();
	}

	release() {
		this.adb.stop();
		this.adb.stopDeviceTracking();
	}

	// MESSAGING
	async #onMessage(event) {
		try {
			switch (event.type) {
				// UI EVENTS
				case 'start':
					this.#paused = false;
					await this.adb.start(event.data);
					break;
				case 'stop':
					this.adb.stop();
					this.#paused = false;
					break;
				case 'pause':
					this.#paused = true;
					break;
				case 'resume':
					this.#paused = false;
					break;
				case 'clear':
					this.adb.clear();
					break;
				case 'restart':
					this.#paused = false;
					await this.adb.restart(event.data);
					break;
				case 'copy':
					vsc.copyToClipboard(event.data.text);
					break;
				case 'export': {
					const doc = await vscode.workspace.openTextDocument({ content: event.data.logs, language: 'log' });
					await vscode.window.showTextDocument(doc);
					break;
				}
				case 'app-launch':
					this.adb.launchApp(event.data.deviceId, event.data.packageName).catch(() => {});
					break;
				case 'app-force-stop':
					this.adb.forceStopApp(event.data.deviceId, event.data.packageName).catch(() => {});
					break;
				case 'app-clear-data':
					this.adb.clearAppData(event.data.deviceId, event.data.packageName).catch(() => {});
					break;
				case 'devices':
					this.adb.listDevices()
						.then(devices => this.#postMessage({ type: 'devices', data: { devices } }))
						.catch(err => {
							if (this.#isAdbMissingError(err)) return this.#sendAdbMissing();
							vsc.showErrorPopup(err.message || err);
						});
					break;
				case 'packages':
					this.adb.listPackages(event.data.deviceId)
						.then(packages => this.#postMessage({ type: 'packages', data: { packages } }))
						.catch(err => vsc.showErrorPopup(err.message || err));
					break;
				case 'save-tag-group': {
					const config = vscode.workspace.getConfiguration('logcatLens');
					const groups = { ...config.get('tagGroups', {}) };
					groups[event.data.name] = event.data.tags;
					await config.update('tagGroups', groups, vscode.ConfigurationTarget.Global);
					this.#postMessage({ type: 'tag-groups', data: { groups } });
					break;
				}
				case 'load-tag-groups': {
					const groups = vscode.workspace.getConfiguration('logcatLens').get('tagGroups', {});
					this.#postMessage({ type: 'tag-groups', data: { groups } });
					break;
				}
				case 'delete-tag-group': {
					const cfg = vscode.workspace.getConfiguration('logcatLens');
					const grps = { ...cfg.get('tagGroups', {}) };
					delete grps[event.data.name];
					await cfg.update('tagGroups', grps, vscode.ConfigurationTarget.Global);
					this.#postMessage({ type: 'tag-groups', data: { groups: grps } });
					break;
				}
				case 'package-info':
					this.adb.getPackageInfo(event.data.deviceId, event.data.packageName)
						.then(info => this.#postMessage({ type: 'package-info', data: info }))
						.catch(() => {});
					break;
				case 'fetch-tags':
					this.adb.listTags(event.data.deviceId)
						.then(tags => this.#postMessage({ type: 'tags', data: { tags } }))
						.catch(() => {});
					break;
				case 'check-adb':
					this.#postMessage({ type: 'adb-status', data: { available: isAdbAvailable() } });
					break;
				case 'install-adb':
					downloadAndInstallAdb().then(ok => {
						this.#postMessage({ type: 'adb-status', data: { available: !!ok } });
					});
					break;
				case 'open-adb-settings':
					vscode.commands.executeCommand('workbench.action.openSettings', 'logcatLens.adbPath');
					break;
				case 'open-adb-download':
					vscode.env.openExternal(vscode.Uri.parse('https://developer.android.com/tools/releases/platform-tools'));
					break;

				// ADB EVENTS
				case 'adb.log':
					if (!this.#paused) {
						this.#postMessage({ type: 'log', data: { log: event.data } });
					}
					break;

				case 'adb.package-changed':
					this.#postMessage({ type: 'package-changed', data: event.data });
					break;

				case 'adb.lifecycle':
					this.#postMessage({ type: 'lifecycle', data: event.data });
					break;

				case 'adb.devices-changed':
					this.adb.listDevices()
						.then(devices => this.#postMessage({ type: 'devices', data: { devices } }))
						.catch(err => {
							if (this.#isAdbMissingError(err)) this.#sendAdbMissing();
						});
					break;

				case 'adb.closed':
					this.#postMessage({ type: 'stop' });
					break;

				case 'adb.error':
					if (this.#isAdbMissingError(event.data)) return this.#sendAdbMissing();
					vsc.showErrorPopup(event.data.toString());
					this.adb.stop();
					this.#postMessage({ type: 'stop' });
					break;
			}

		} catch (err) {
			if (this.#isAdbMissingError(err)) return this.#sendAdbMissing();
			vsc.showErrorPopup(err.message || err);
			this.adb.stop();
			this.#postMessage({ type: 'stop' });
		}
	}

	#isAdbMissingError(err) {
		const msg = (err?.message || err || '').toString().toLowerCase();
		return msg.includes('not found') || msg.includes('no such file') || msg.includes('enoent');
	}

	#sendAdbMissing() {
		resetAdbCache();
		this.adb.stop();
		this.#postMessage({ type: 'adb-status', data: { available: false } });
	}

	#postMessage(message) {
		this.#view?.webview?.postMessage(message);
	}

	async resolveWebviewView(webviewView) {
		this.#view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.#extensionURI],
		}
		webviewView.webview.html = this.#render(webviewView.webview);
		webviewView.webview.onDidReceiveMessage((message) => this.#onMessage(message));
	}

	/** @param {vscode.Webview} webview */
	#render(webview) {
		const uri = (path) => webview.asWebviewUri(vscode.Uri.joinPath(this.#extensionURI, path));
		const nonce = util.getNonce();

		return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="img-src https: data:; style-src 'unsafe-inline' ${webview.cspSource};">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${uri('src/frontend/style.css')}" rel="stylesheet">
				<script nonce="${nonce}" src="${uri('src/frontend/core/html-element-base.js')}"></script>

				<link href="${uri('src/frontend/logcat/logcat.css')}" rel="stylesheet">
				<script nonce="${nonce}" src="${uri('src/frontend/logcat/logcat.js')}"></script>
			</head>

			<body data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
				<logcat-lens></logcat-lens>
			</body>
			</html>
		`;
	}
}
