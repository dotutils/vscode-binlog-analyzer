# MSBuild Binlog Analyzer for VS Code

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/dotutils.binlog-analyzer?label=VS%20Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=dotutils.binlog-analyzer)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/dotutils.binlog-analyzer)](https://marketplace.visualstudio.com/items?itemName=dotutils.binlog-analyzer)

Analyze MSBuild binary logs (`.binlog`) with **GitHub Copilot Chat** and **MCP tools** — right from VS Code.

> **Preview** — This extension is under active development. Feedback welcome!

## Features

- **🤖 @binlog Chat Participant** — Ask Copilot about your build: errors, performance, targets, and more
- **📊 Build Analysis Mode** — Pre-configured Copilot Chat mode for build investigation
- **🌳 Binlog Explorer** — Sidebar tree view with projects, errors, warnings, and performance data
- **🔍 Problems Panel** — Build errors and warnings surfaced as VS Code diagnostics
- **📎 Multi-Binlog Support** — Load and compare multiple binlogs in a single session
- **✨ Fix All Issues** — One-click action to fix all build warnings/errors with Copilot agent
- **🔐 Secrets Detection** — Scan binlogs for leaked credentials, tokens, and API keys
- **🔗 Structured Log Viewer Integration** — One-click launch from the WPF [MSBuild Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog)

## Quick Start

### From Structured Log Viewer (recommended)
1. Open a `.binlog` in [MSBuild Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog)
2. Click **✨ Open in VS Code**
3. The extension activates automatically — Copilot Chat opens with `@binlog` ready

### Standalone
1. Install this extension
2. Open a project folder in VS Code
3. Run **Binlog: Load File** from the Command Palette (`Ctrl+Shift+P`)
4. Use `@binlog` in Copilot Chat to analyze your build

## Prerequisites

- **VS Code** 1.99+ with GitHub Copilot
- **.NET SDK** (for the MCP server tool)
- **[baronfel.binlog.mcp](https://www.nuget.org/packages/baronfel.binlog.mcp)** — Auto-installed on first use, or install manually:
  ```bash
  dotnet tool install -g baronfel.binlog.mcp
  ```

## Usage

### Copilot Chat (`@binlog`)
Open Copilot Chat and type `@binlog` followed by your question:

```
@binlog why did the build fail?
@binlog what are the slowest targets?
@binlog show me all errors in MyProject.csproj
```

**Slash commands:**
| Command | Description |
|---------|-------------|
| `/errors` | Analyze build errors and warnings |
| `/timeline` | Build performance analysis |
| `/targets` | MSBuild target inspection |
| `/summary` | Comprehensive build summary |
| `/secrets` | Scan for leaked secrets |
| `/compare` | Compare two loaded binlogs side by side |

### Binlog Explorer Sidebar
Click the **Binlog Analyzer** icon in the Activity Bar to see:
- **Loaded Binlogs** — with inline remove (✕) button on hover
- **Projects** — with directory paths and build times; click for details
- **Errors / Warnings** — from build diagnostics
- **Performance** — slowest targets and tasks
- **Actions** — quick access to chat, add/refresh binlogs, set workspace, fix all issues

### Fix All Issues
When errors or warnings exist, the ✨ **Fix all issues** action appears in the tree.
It sends the concrete diagnostic list to Copilot agent mode, which:
1. Opens each source file and makes the fix
2. Suppresses unfixable issues with a comment
3. Rebuilds to verify — iterates until clean

### Cross-Machine Binlogs
Binlogs from CI/CD or other machines contain source paths that don't match your local filesystem.
The extension detects this and shows a dialog. Use **Set workspace folder...** in the tree's
Actions to point VS Code at your local source code.

### Commands (`Ctrl+Shift+P`)
| Command | Description |
|---------|-------------|
| **Binlog: Load File** | Open a binlog (replaces current session) |
| **Binlog: Add File** | Add more binlogs to the current session |
| **Binlog: Remove File** | Remove a binlog from the session |
| **Binlog: Manage Loaded Binlogs** | View/add/remove loaded binlogs |
| **Binlog: Set Workspace Folder** | Point VS Code at the right source code |
| **Binlog: Fix All Build Issues** | Fix all warnings/errors with Copilot |
| **Binlog: Show Errors** | Focus the Problems panel |
| **Binlog: Scan for Secrets** | Detect leaked credentials |
| **Binlog: Redact Secrets** | Create a redacted copy of a binlog |

### Status Bar
Shows the number of loaded binlogs. Click to manage.

## How It Works

```
┌─────────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  Structured Log Viewer  │────▶│  VS Code Extension   │────▶│  baronfel.binlog.mcp│
│  (WPF)                  │     │  (this extension)    │     │  (MCP Server)       │
│                         │     │                      │     │                     │
│  • Opens binlog         │     │  • Configures MCP    │     │  • Parses binlog    │
│  • Detects workspace    │     │  • @binlog chat      │     │  • Provides tools   │
│  • Writes settings.json │     │  • Sidebar tree view │     │  • Copilot accesses │
│  • Launches VS Code     │     │  • Auto-installs tool│     │    via MCP protocol │
└─────────────────────────┘     └──────────────────────┘     └─────────────────────┘
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `binlogAnalyzer.mcpServerPath` | `""` | Custom path to the MCP server executable |
| `binlogAnalyzer.autoLoad` | `true` | Auto-load binlog diagnostics on activation |
| `binlogAnalyzer.diagnosticsSeverityFilter` | `"Warning"` | Min severity for Problems panel |

## Telemetry

This extension collects anonymized usage data to help improve the experience.
It respects VS Code's telemetry settings (`telemetry.telemetryLevel`).
No source code, file paths, or build content is collected.

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Run tests
npm test

# Watch mode
npm run watch

# Package VSIX
npx vsce package --no-dependencies --allow-missing-repository
```

## Related Projects

- [MSBuild Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog) — WPF viewer for binlog files
- [baronfel.binlog.mcp](https://github.com/baronfel/mcp-binlog-tool) — MCP server for binlog analysis
- [MSBuild Binary Log](https://learn.microsoft.com/en-us/visualstudio/msbuild/obtaining-build-logs-with-msbuild#save-a-binary-log) — Microsoft docs

## License

[MIT](LICENSE)
