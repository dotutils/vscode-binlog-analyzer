# MSBuild Binlog Analyzer for VS Code

Analyze MSBuild binary logs (`.binlog`) with **GitHub Copilot Chat** and **MCP tools** — right from VS Code.

## Features

- **🤖 @binlog Chat Participant** — Ask Copilot about your build: errors, performance, targets, and more
- **📊 Build Analysis Mode** — Pre-configured Copilot Chat mode for build investigation
- **🔍 Problems Panel** — Build errors and warnings surfaced as VS Code diagnostics
- **📎 Multi-Binlog Support** — Load and compare multiple binlogs in a single session
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
- **[baronfel.binlog.mcp](https://www.nuget.org/packages/baronfel.binlog.mcp)** — The MCP server for binlog analysis
  ```bash
  dotnet tool install -g baronfel.binlog.mcp
  ```
  > The extension auto-installs this tool if it's missing.

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

### Commands (`Ctrl+Shift+P`)
| Command | Description |
|---------|-------------|
| **Binlog: Load File** | Open a binlog (replaces current session) |
| **Binlog: Add File** | Add more binlogs to the current session |
| **Binlog: Manage Loaded Binlogs** | View/add/remove loaded binlogs |
| **Binlog: Open Project Folder** | Point VS Code at the right source code (for cross-machine binlogs) |
| **Binlog: Show Errors** | Focus the Problems panel |
| **Binlog: Scan for Secrets** | Detect leaked credentials |
| **Binlog: Redact Secrets** | Create a redacted copy of a binlog |

### Binlog Explorer Sidebar
Click the **Binlog Analyzer** icon in the Activity Bar to see loaded binlogs, quick actions, and status.

### Status Bar
Shows the number of loaded binlogs. Click to manage.

## Cross-Machine Binlogs

Binlogs from CI/CD or other machines contain source paths that don't match your local filesystem. The extension detects this and prompts you to open the correct local project folder. Copilot Chat can still analyze the binlog structure without local source files.

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
| `binlogAnalyzer.activeBinlogs` | `[]` | Binlog paths (set automatically by Structured Log Viewer) |
| `binlogAnalyzer.redaction.*` | — | Secrets redaction options |

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Package VSIX
npx vsce package --no-dependencies
```

## Related Projects

- [MSBuild Structured Log Viewer](https://github.com/KirillOsenkov/MSBuildStructuredLog) — WPF viewer for binlog files
- [baronfel.binlog.mcp](https://github.com/baronfel/binlog-mcp) — MCP server for binlog analysis
- [MSBuild Binary Log](https://learn.microsoft.com/en-us/visualstudio/msbuild/obtaining-build-logs-with-msbuild#save-a-binary-log) — Microsoft docs

## License

[MIT](LICENSE)
