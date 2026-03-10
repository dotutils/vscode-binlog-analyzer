import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
        const extensionTestsPath = path.resolve(__dirname, './index');
        const userDataDir = path.resolve(__dirname, '../../../.vscode-test/user-data');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            version: '1.99.0',
            launchArgs: [
                '--disable-extensions',
                '--disable-gpu',
                '--user-data-dir', userDataDir,
                '--skip-release-notes',
            ],
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
