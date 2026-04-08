import * as vscode from 'vscode';

// Lightweight telemetry wrapper — uses @vscode/extension-telemetry if available,
// otherwise silently no-ops. All events are anonymized and respect VS Code telemetry settings.

let reporter: TelemetryReporter | undefined;
let telemetryLog: vscode.OutputChannel | undefined;

function log(msg: string) {
    if (!telemetryLog) {
        telemetryLog = vscode.window.createOutputChannel('Binlog Analyzer Telemetry');
    }
    telemetryLog.appendLine(`[${new Date().toISOString().substring(11, 19)}] ${msg}`);
}

interface TelemetryReporter {
    sendTelemetryEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;
    sendTelemetryErrorEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;
    dispose(): void;
}

/**
 * Initialize telemetry. Call once during extension activation.
 * Uses a placeholder connection string — replace with real one for production.
 */
export function initTelemetry(context: vscode.ExtensionContext): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('@vscode/extension-telemetry');
        log(`Module loaded. Keys: ${Object.keys(mod).join(', ')}`);
        const TelemetryReporterClass = mod.default;
        if (!TelemetryReporterClass) {
            log('ERROR: No default export found');
            return;
        }
        const connectionString = 'InstrumentationKey=a7eb229a-c9eb-41c5-817b-62f0b74bfa78;IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com/;LiveEndpoint=https://swedencentral.livediagnostics.monitor.azure.com/;ApplicationId=dd1de234-9886-4f22-830b-36147303383e';
        reporter = new TelemetryReporterClass(connectionString);
        context.subscriptions.push(reporter as unknown as vscode.Disposable);
        log('Reporter initialized successfully');
    } catch (err) {
        log(`Failed to initialize: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    }
}

/** Track extension activation */
export function trackActivation(): void {
    log(`trackActivation — reporter: ${!!reporter}`);
    reporter?.sendTelemetryEvent('activation');
}

/** Track binlog loaded */
export function trackBinlogLoad(count: number, source: 'uri' | 'file' | 'settings'): void {
    log(`trackBinlogLoad — count: ${count}, source: ${source}`);
    reporter?.sendTelemetryEvent('binlogLoad', { source }, { count });
}

/** Track command usage */
export function trackCommand(command: string): void {
    reporter?.sendTelemetryEvent('command', { command });
}

/** Track slash command usage */
export function trackSlashCommand(command: string): void {
    reporter?.sendTelemetryEvent('slashCommand', { command });
}

/** Track MCP client errors */
export function trackMcpError(operation: string, error: string): void {
    reporter?.sendTelemetryErrorEvent('mcpError', {
        operation,
        error: error.substring(0, 200), // Truncate to avoid PII
    });
}

/** Track MCP tool auto-install */
export function trackToolInstall(success: boolean): void {
    reporter?.sendTelemetryEvent('toolInstall', { success: String(success) });
}

/** Track cross-machine binlog detection */
export function trackCrossMachine(): void {
    reporter?.sendTelemetryEvent('crossMachineBinlog');
}

/** Track tree node expansion */
export function trackTreeExpand(nodeKind: string): void {
    reporter?.sendTelemetryEvent('treeExpand', { nodeKind });
}

/** Track tree item selection (click, keyboard navigation, focus change) */
export function trackTreeSelect(nodeKind: string): void {
    reporter?.sendTelemetryEvent('treeSelect', { nodeKind });
}

/** Track BuildCheck run */
export function trackBuildCheck(resultCount: number, sdkVersion: string, durationMs: number): void {
    reporter?.sendTelemetryEvent('buildCheck', { sdkVersion }, { resultCount, durationMs });
}

/** Track enhanced diagnostics selection in Build & Collect */
export function trackEnhancedDiagnostics(options: string[]): void {
    reporter?.sendTelemetryEvent('enhancedDiagnostics', { options: options.join(',') });
}

/** Track file open from tree view */
export function trackFileOpen(source: string): void {
    reporter?.sendTelemetryEvent('fileOpen', { source });
}

/** Track click-to-analyze usage */
export function trackAnalyzeInChat(category: string): void {
    reporter?.sendTelemetryEvent('analyzeInChat', { category });
}

/** Track timeline interaction */
export function trackTimelineClick(itemName: string): void {
    reporter?.sendTelemetryEvent('timelineClick', { item: itemName.substring(0, 50) });
}

/** Track workspace folder change */
export function trackWorkspaceChange(): void {
    reporter?.sendTelemetryEvent('workspaceChange');
}

/** Track generic errors with context */
export function trackError(context: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    reporter?.sendTelemetryErrorEvent('error', {
        context,
        message: msg.substring(0, 200),
    });
}
