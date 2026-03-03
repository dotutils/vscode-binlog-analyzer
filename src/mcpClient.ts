import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Minimal MCP (Model Context Protocol) client that communicates with
 * binlog.mcp.exe over stdio using JSON-RPC 2.0 with Content-Length framing.
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

        // Initialize handshake
        const initResult = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'binlog-tree', version: '0.1.0' },
        });

        // Send initialized notification
        this.sendNotification('notifications/initialized', {});
        this.initialized = true;

        return;
    }

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
        if (!this.initialized) {
            throw new Error('MCP client not initialized');
        }
        const result = await this.sendRequest('tools/call', { name, arguments: args }) as {
            content?: Array<{ type: string; text?: string }>;
        };
        const textParts = (result.content || [])
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text!);
        return { text: textParts.join('\n') };
    }

    async listTools(): Promise<Array<{ name: string; description: string }>> {
        const result = await this.sendRequest('tools/list', {}) as {
            tools?: Array<{ name: string; description?: string }>;
        };
        return (result.tools || []).map(t => ({
            name: t.name,
            description: t.description || '',
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

            // Timeout after 30s
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
        const body = JSON.stringify(msg);
        const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
        this.proc.stdin.write(header + body);
    }

    private onData(chunk: Buffer): void {
        this.buffer += chunk.toString('utf8');
        this.parseMessages();
    }

    private parseMessages(): void {
        while (true) {
            // Look for Content-Length header
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                return;
            }

            const headerPart = this.buffer.substring(0, headerEnd);
            const match = headerPart.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                // Skip malformed data — advance past the header
                this.buffer = this.buffer.substring(headerEnd + 4);
                continue;
            }

            const contentLength = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;

            if (this.buffer.length < bodyStart + contentLength) {
                return; // Wait for more data
            }

            const body = this.buffer.substring(bodyStart, bodyStart + contentLength);
            this.buffer = this.buffer.substring(bodyStart + contentLength);

            try {
                const msg = JSON.parse(body);
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id)!;
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    } else {
                        p.resolve(msg.result);
                    }
                }
                // Ignore notifications from server
            } catch {
                // Skip parse errors
            }
        }
    }
}

export interface ToolResult {
    text: string;
}
