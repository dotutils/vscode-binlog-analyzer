import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';

// Debug output channel for MCP client diagnostics
let outputChannel: vscode.OutputChannel | undefined;
function log(msg: string) {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Binlog MCP Client');
    }
    outputChannel.appendLine(`[${new Date().toISOString().substring(11, 19)}] ${msg}`);
}

/**
 * Minimal MCP (Model Context Protocol) client that communicates with
 * BinlogInsights.Mcp over stdio using JSON-RPC 2.0 with newline-delimited JSON.
 */
export class McpClient extends EventEmitter {
    private proc: ChildProcess | null = null;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private buffer = '';
    private initialized = false;

    constructor(
        private readonly exePath: string,
        private readonly binlogPaths: string[]
    ) {
        super();
    }

    async start(): Promise<void> {
        const args = this.binlogPaths.flatMap(p => ['--binlog', p]);
        this.proc = spawn(this.exePath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
        this.proc.stderr!.on('data', () => { /* ignore debug logs */ });
        this.proc.on('exit', () => {
            this.initialized = false;
            for (const p of this.pending.values()) {
                p.reject(new Error('MCP server exited'));
            }
            this.pending.clear();
        });

        // Wait for server to start, then try handshake with quick retry
        let initialized = false;
        for (let attempt = 0; attempt < 5 && !initialized; attempt++) {
            await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 100 : 300));
            try {
                await this.sendRequest('initialize', {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'binlog-tree', version: '0.1.0' },
                });
                initialized = true;
            } catch {
                log(`Initialize attempt ${attempt + 1} failed, retrying...`);
            }
        }
        if (!initialized) {
            throw new Error('Failed to initialize MCP server after 5 attempts');
        }

        // Send initialized notification
        this.sendNotification('notifications/initialized', {});
        this.initialized = true;
        log(`MCP server initialized. Binlogs passed via --binlog args: ${this.binlogPaths.join(', ')}`);
    }

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
        if (!this.initialized) {
            throw new Error('MCP client not initialized');
        }
        // Auto-inject binlog_file if not provided
        if (!args.binlog_file && this.binlogPaths.length > 0) {
            args.binlog_file = this.binlogPaths[0];
        }
        log(`callTool: ${name} args=${JSON.stringify(args).substring(0, 200)}`);
        const result = await this.sendRequest('tools/call', { name, arguments: args }) as {
            content?: Array<{ type: string; text?: string }>;
            isError?: boolean;
        };
        const textParts = (result.content || [])
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text!);
        const text = textParts.join('\n');
        log(`callTool ${name} response (${text.length} chars): ${text.substring(0, 300)}`);
        if (result.isError || text.includes('An error occurred invoking')) {
            log(`callTool ${name} ERROR: ${text.substring(0, 500)}`);
            throw new Error(text || 'Tool call failed');
        }
        return { text };
    }

    async listTools(): Promise<Array<{ name: string; description: string; inputSchema?: any }>> {
        const result = await this.sendRequest('tools/list', {}) as {
            tools?: Array<{ name: string; description?: string; inputSchema?: any }>;
        };
        return (result.tools || []).map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema,
        }));
    }

    dispose(): void {
        if (this.proc) {
            this.proc.kill();
            this.proc = null;
        }
        this.initialized = false;
        this.pending.clear();
    }

    private sendRequest(method: string, params: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.writeMessage({ jsonrpc: '2.0', id, method, params });

            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP request '${method}' timed out`));
                }
            }, 30000);
        });
    }

    private sendNotification(method: string, params: unknown): void {
        this.writeMessage({ jsonrpc: '2.0', method, params });
    }

    private writeMessage(msg: unknown): void {
        if (!this.proc?.stdin?.writable) {
            throw new Error('MCP server stdin not writable');
        }
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }

    private onData(chunk: Buffer): void {
        this.buffer += chunk.toString('utf8');
        this.parseMessages();
    }

    private parseMessages(): void {
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) { continue; }
            try {
                const msg = JSON.parse(trimmed);
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id)!;
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    } else {
                        p.resolve(msg.result);
                    }
                }
            } catch {
                // Skip parse errors
            }
        }
    }
}

export interface ToolResult {
    text: string;
}
