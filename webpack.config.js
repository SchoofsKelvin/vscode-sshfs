
//@ts-check
'use strict';

const { join, resolve, basename, dirname } = require('path');
const fs = require('fs');
const webpack = require('webpack');
const CleanWebpackPlugin = require('clean-webpack-plugin').default;

/**
 * @template T
 * @param { (cb: (e?: Error, r?: T) => void) => any } func
 * @return { Promise<T> }
 */
function wrap(func) {
    return new Promise((res, rej) => {
        try {
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
        const path = resolve('./node_modules/ssh2/util/pagent.exe');
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
    target: 'node',
    node: false,
    entry: './src/extension.ts',
    output: {
        path: resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]",
    },
    devtool: 'source-map',
    performance: {
        hints: 'warning'
    },
    externals: {
        vscode: "commonjs vscode",
        request: "commonjs request",
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
        new CleanWebpackPlugin(),
        new CopyPuttyExecutable(),
    ],
}

module.exports = config;
