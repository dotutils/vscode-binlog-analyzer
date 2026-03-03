import * as vscode from 'vscode';

// Lightweight telemetry wrapper — uses @vscode/extension-telemetry if available,
// otherwise silently no-ops. All events are anonymized and respect VS Code telemetry settings.

let reporter: TelemetryReporter | undefined;

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
        const { default: TelemetryReporterClass } = require('@vscode/extension-telemetry');
        // Using a placeholder key — replace with real Application Insights connection string for production
        const connectionString = 'InstrumentationKey=00000000-0000-0000-0000-000000000000';
        reporter = new TelemetryReporterClass(connectionString);
        context.subscriptions.push(reporter as unknown as vscode.Disposable);
    } catch {
        // Telemetry package not available — silently no-op
    }
}

/** Track extension activation */
export function trackActivation(): void {
    reporter?.sendTelemetryEvent('activation');
}

/** Track binlog loaded */
export function trackBinlogLoad(count: number, source: 'uri' | 'file' | 'settings'): void {
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

/** Track generic errors with context */
export function trackError(context: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    reporter?.sendTelemetryErrorEvent('error', {
        context,
        message: msg.substring(0, 200),
    });
}
