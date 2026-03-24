const vsc = require('./core/vsc');
const MainViewProvider = require('./main-view-provider');

let provider;

function activate(context) {

	// Status Bar Item
	// const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	// statusBarItem.command = 'logcat-lens.open';
	// statusBarItem.text = '$(bug)';
	// statusBarItem.tooltip = 'Open Android Logcat';
	// statusBarItem.show();
	// context.subscriptions.push(statusBarItem);

	provider = new MainViewProvider(context);
	vsc.registerWebViewProvider(context, 'logcat-lens-main-view',
		provider,
		{ webviewOptions: { retainContextWhenHidden: true }
	});
}

function deactivate() {
	provider.release();
}

module.exports = {
	activate,
	deactivate
}
