// @ts-check
/* eslint-disable */

/**
 * esbuild configuration for bundling the extension into a single CommonJS
 * file at `dist/extension.js`. This dramatically reduces VSIX size and
 * activation latency vs shipping raw `out/` from `tsc`.
 *
 * Run modes:
 *   node esbuild.config.js           — production bundle (minified)
 *   node esbuild.config.js --watch   — incremental rebuild for dev
 *   node esbuild.config.js --dev     — dev bundle (no minify, sourcemaps)
 */

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

/** @type {import('esbuild').BuildOptions} */
const options = {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    external: ['vscode'],
    logLevel: 'info',
    loader: { '.ts': 'ts' },
};

(async () => {
    if (watch) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
        console.log('[esbuild] watching for changes…');
    } else {
        await esbuild.build(options);
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
