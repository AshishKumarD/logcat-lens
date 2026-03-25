# Contributing to Logcat Lens

Thanks for taking the time to contribute! Here's everything you need to get started.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [VS Code](https://code.visualstudio.com/) v1.90+
- [ADB](https://developer.android.com/tools/adb) installed and in your PATH

### Getting Started

```bash
git clone https://github.com/AshishKumarD/logcat-lens.git
cd logcat-lens
npm install
```

Open the project in VS Code:

```bash
code .
```

Press `F5` to launch the Extension Development Host — a new VS Code window will open with the extension loaded.

## Project Structure

```
src/
  backend/
    extension.js              # Extension entry point
    main-view-provider.js     # Webview provider
    core/
      adb-service.js          # ADB process management
      vsc.js                  # VS Code API helpers
      utils.js                # Utility functions
  frontend/
    core/
      html-element-base.js    # Base component class
    logcat/
      logcat.js               # Main UI logic
      logcat.css              # Styles
    style.css                 # Global styles
res/                          # Icons and screenshots
docs/                         # Additional documentation
```

## Making Changes

### Backend (Node.js / VS Code API)

The backend runs in VS Code's extension host. Changes to `src/backend/` require reloading the Extension Development Host (`Ctrl+R` / `Cmd+R` in the host window).

### Frontend (Webview)

The frontend runs inside a VS Code webview. It is plain JS/CSS with no build step — changes are reflected on webview reload.

## Linting

```bash
npm run lint
```

Please ensure there are no lint errors before submitting a PR.

## Submitting a Pull Request

1. Fork the repository
2. Create a branch: `git checkout -b fix/your-fix` or `feat/your-feature`
3. Make your changes
4. Run `npm run lint` and fix any issues
5. Push and open a PR against `main`
6. Fill out the PR template

## Reporting Issues

Use the [issue tracker](https://github.com/AshishKumarD/logcat-lens/issues). Please use the provided templates for bug reports and feature requests.
