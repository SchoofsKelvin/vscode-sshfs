
//@ts-check
'use strict';

const { join, resolve, dirname } = require('path');
const fs = require('fs');
const webpack = require('webpack');
const { WebpackPlugin } = require('./webpack.plugin');

/**
 * @template T
 * @param { (cb: (e?: Error | null, r?: T) => void) => any } func
 * @return { Promise<T> }
 */
function wrap(func) {
    return new Promise((res, rej) => {
        try {
            // @ts-ignore
            func((e, r) => e ? rej(e) : res(r));
        } catch (e) {
            rej(e);
        }
    });
}

class CopyPuttyExecutable {
    /**
     * @param {webpack.Compiler} compiler
     */
    apply(compiler) {
        const path = require.resolve('ssh2/util/pagent.exe');
        // @ts-ignore
        const target = join(compiler.options.output.path, '../util/pagent.exe');
        compiler.hooks.beforeRun.tapPromise('CopyPuttyExecutable-BeforeRun', () => new Promise((resolve, reject) => {
            fs.exists(path, exists => exists ? resolve() : reject(`Couldn't find executable at: ${path}`));
        }));
        compiler.hooks.emit.tapPromise('CopyPuttyExecutable-Emit', async () => {
            /** @type {Buffer} */
            const data = await wrap(cb => fs.readFile(path, cb));
            await wrap(cb => fs.exists(dirname(target), res => cb(null, res))).then(
                exists => !exists && wrap(cb => fs.mkdir(dirname(target), cb))
            );
            await wrap(cb => compiler.outputFileSystem.writeFile(target, data, cb));
            console.log(`[CopyPuttyExecutable] Wrote '${path}' to '${target}'`);
        });
    }
}

/**@type {webpack.Configuration}*/
const config = {
    mode: 'development',
    target: 'node',
    node: false,
    entry: './src/extension.ts',
    output: {
        path: resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
        devtoolModuleFilenameTemplate: '../[resource-path]',
        clean: true,
    },
    devtool: 'source-map',
    performance: {
        hints: 'warning'
    },
    externals: {
        vscode: 'commonjs vscode',
        request: 'commonjs request',
        '.pnp.cjs': 'commonjs ../.pnp.cjs',
        'source-map-support': 'commonjs source-map-support',
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [{
            test: /\.ts$/,
            include: /src/,
            use: [{
                loader: 'ts-loader',
            }]
        }]
    },
    plugins: [
        new CopyPuttyExecutable(),
        new WebpackPlugin(),
        new webpack.IgnorePlugin({
            resourceRegExp: /\.node$/,
        }),
    ],
    optimization: {
        splitChunks: {
            minSize: 0,
            cacheGroups: {
                default: false,
                defaultVendors: false,
            },
        },
    },
    stats: {
        ids: true,
        assets: false,
        chunks: false,
        entrypoints: true,
        modules: true,
        groupModulesByPath: true,
        modulesSpace: 50,
    },
}

module.exports = config;
