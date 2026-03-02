import * as vscode from 'vscode';

export class BinlogTreeDataProvider implements vscode.TreeDataProvider<BinlogTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BinlogTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private binlogPaths: string[] = [];

    setBinlogPaths(paths: string[]) {
        this.binlogPaths = paths;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: BinlogTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: BinlogTreeItem): BinlogTreeItem[] {
        if (element) {
            return []; // No children for individual items
        }

        const items: BinlogTreeItem[] = [];

        if (this.binlogPaths.length === 0) {
            // Empty state — prompt to load
            const loadItem = new BinlogTreeItem(
                'Load a binlog file...',
                vscode.TreeItemCollapsibleState.None
            );
            loadItem.command = { command: 'binlog.loadFile', title: 'Load File' };
            loadItem.iconPath = new vscode.ThemeIcon('add');
            loadItem.description = 'Click to open';
            items.push(loadItem);
            return items;
        }

        // Loaded binlogs section
        for (let i = 0; i < this.binlogPaths.length; i++) {
            const p = this.binlogPaths[i];
            const fileName = p.split(/[/\\]/).pop() || p;
            const item = new BinlogTreeItem(
                fileName,
                vscode.TreeItemCollapsibleState.None
            );
            item.description = i === 0 ? 'primary' : 'attached';
            item.tooltip = p;
            item.iconPath = new vscode.ThemeIcon(i === 0 ? 'file-binary' : 'link');
            item.contextValue = 'binlogFile';
            items.push(item);
        }

        // Separator — actions
        const sep = new BinlogTreeItem('─────────', vscode.TreeItemCollapsibleState.None);
        sep.description = '';
        items.push(sep);

        // Quick actions
        const chatItem = new BinlogTreeItem(
            'Ask @binlog in Copilot Chat',
            vscode.TreeItemCollapsibleState.None
        );
        chatItem.command = { command: 'workbench.action.chat.open', title: 'Chat', arguments: ['@binlog '] };
        chatItem.iconPath = new vscode.ThemeIcon('comment-discussion');
        items.push(chatItem);

        const addItem = new BinlogTreeItem(
            'Add more binlogs...',
            vscode.TreeItemCollapsibleState.None
        );
        addItem.command = { command: 'binlog.addFile', title: 'Add' };
        addItem.iconPath = new vscode.ThemeIcon('add');
        items.push(addItem);

        const errorsItem = new BinlogTreeItem(
            'Show build errors',
            vscode.TreeItemCollapsibleState.None
        );
        errorsItem.command = { command: 'binlog.showErrors', title: 'Errors' };
        errorsItem.iconPath = new vscode.ThemeIcon('error');
        items.push(errorsItem);

        const secretsItem = new BinlogTreeItem(
            'Scan for secrets',
            vscode.TreeItemCollapsibleState.None
        );
        secretsItem.command = { command: 'binlog.scanSecrets', title: 'Secrets' };
        secretsItem.iconPath = new vscode.ThemeIcon('shield');
        items.push(secretsItem);

        const folderItem = new BinlogTreeItem(
            'Open project folder...',
            vscode.TreeItemCollapsibleState.None
        );
        folderItem.command = { command: 'binlog.openProjectFolder', title: 'Folder' };
        folderItem.iconPath = new vscode.ThemeIcon('folder-opened');
        folderItem.description = 'cross-machine';
        items.push(folderItem);

        return items;
    }
}

class BinlogTreeItem extends vscode.TreeItem {
    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
        super(label, collapsibleState);
    }
}
