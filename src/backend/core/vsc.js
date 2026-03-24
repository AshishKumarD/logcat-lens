const vscode = require('vscode');

module.exports = (() => {

	/**
	 * automatically pushes the disposable to the `subscriptions` array
	 * @param {vscode.ExtensionContext} context
	 * @param {string} name
	 * @param {(...args: any[]) => any} callback
	 */
	function registerCommand(context, name, callback) {
		context.subscriptions.push(vscode.commands.registerCommand(name, callback));
	}
	/**
	 * @param {string} command
	 * @param {any} params
	 */
	function executeCommand(command, ...params) {
		return vscode.commands.executeCommand(command, ...params);
	}

	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {string} name
	 * @param {vscode.WebviewViewProvider} provider
	 * @param {{ readonly webviewOptions?: { readonly retainContextWhenHidden?: boolean; }; }} [options]
	 */
	function registerWebViewProvider(context, name, provider, options) {
		context.subscriptions.push(vscode.window.registerWebviewViewProvider(name, provider, options));
	}

	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {string} scheme
	 * @param {vscode.TextDocumentContentProvider} provider
	 */
	function registerTextDocumentContentProvider(context, scheme, provider) {
		context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, provider));
	}

	/**
	 * @param {string} message
	 * @param {any[]} items
	 */
	function showInfoPopup(message, ...items) {
		return vscode.window.showInformationMessage(message, ...items);
	}

	/**
	 * @param {string} message
	 * @param {any[]} items
	 */
	function showWarningPopup(message, ...items) {
		return vscode.window.showWarningMessage(message, ...items);
	}

	/**
	 * @param {string} message
	 * @param {any[]} items
	 */
	function showErrorPopup(message, ...items) {
		return vscode.window.showErrorMessage(message, ...items);
	}

	/** @param {vscode.InputBoxOptions} options */
	function showInputBox(options) {
		return vscode.window.showInputBox(options);
	}

	function showQuickPick(items, options) {
		return vscode.window.showQuickPick(items, options);
	}

	function workspaceFolder() {
		return vscode.workspace.workspaceFolders?.[0];
	}
	function workspacePath() {
		const workspace = workspaceFolder();
		if (workspace) return workspace.uri.fsPath;
	}
	function joinPath(base, ...segments) {
		if (typeof base == 'string') base = vscode.Uri.file(base);
		return vscode.Uri.joinPath(base, ...segments);
	}
	/**
	 * @param {string} path
	 * @param {string | boolean} isAbsolute
	 * */
	function uri(path, isAbsolute = false) {
		return isAbsolute ? vscode.Uri.file(path) : vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, path);
	}

	function fileSystemWatcher(context, path) {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path), '**/*'));
		context.subscriptions.push(watcher);
		return watcher;
	}

	function isDark() {
		return [vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind);
	}

	async function gitExtension() {
		const ext = vscode.extensions.getExtension('vscode.git');
		const api = ext.isActive ? ext.exports : await ext.activate();

		return api.getAPI(1);
	}

	function copyToClipboard(value) {
		return vscode.env.clipboard.writeText(value);
	}

	class ReadOnlyContentProvider {
		static SCHEME = 'readonly';

		provideTextDocumentContent() {
			return '';
		}
	}

	return {
		registerCommand,
		executeCommand,

		registerWebViewProvider,
		registerTextDocumentContentProvider,

		showInfoPopup,
		showWarningPopup,
		showErrorPopup,
		showInputBox,
		showQuickPick,

		workspaceFolder,
		workspacePath,
		joinPath,
		uri,
		fileSystemWatcher,
		isDark,
		copyToClipboard,

		gitExtension,

		ReadOnlyContentProvider,
	}
})();
