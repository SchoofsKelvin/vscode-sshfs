
//@ts-check
'use strict';

const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const PnpWebpackPlugin = require(`pnp-webpack-plugin`);
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const ESLintWebpackPlugin = require('eslint-webpack-plugin');
const ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin');
const { WebpackPlugin } = require('../webpack.plugin');

require('dotenv').config();

/**
 * @template T
 * @param arr {(T | false | undefined)[]}
 * @returns {T[]}
 */
// @ts-ignore
const truthyArray = arr => arr.filter(Boolean);

/**
 * @param options {{ mode?: 'development' | 'production'; watch?: boolean; serve?: boolean; env: object }}
 */
module.exports = (env, options) => {
  options = {
    mode: 'development',
    ...env.WEBPACK_SERVE && { serve: true },
    ...options,
  };
  console.log('options:', options);
  const isEnvDevelopment = options.mode === 'development';
  const isEnvProduction = options.mode === 'production';
  process.env.NODE_ENV = options.env.NODE_ENV = options.mode;

  // In serve mode, we serve inside VS Code through localhost:3000
  const publicPath = options.serve ? 'http://localhost:3000/' : '/';

  /** @type {webpack.Configuration & { devServer: any }} */
  const config = {
    mode: options.mode,
    target: 'web',
    bail: isEnvProduction,
    devtool: 'source-map',
    entry: './src/index.tsx',
    output: {
      path: isEnvProduction ? path.resolve('./build') : undefined,
      pathinfo: isEnvDevelopment,
      filename: 'static/js/[name].bundle.js',
      chunkFilename: 'static/js/[name].chunk.js',
      publicPath,
      devtoolModuleFilenameTemplate(info) {
        if (isEnvProduction) return path.relative('./src', info.absoluteResourcePath).replace(/\\/g, '/');
        return path.resolve(info.absoluteResourcePath).replace(/\\/g, '/');
      },
      clean: true,
    },
    optimization: {
      minimize: isEnvProduction,
      minimizer: [new CssMinimizerPlugin(), '...'],
      splitChunks: { chunks: 'all', name: isEnvDevelopment ? undefined : false },
      runtimeChunk: { name: entrypoint => `runtime-${entrypoint.name}` },
    },
    resolve: {
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
      plugins: [PnpWebpackPlugin]
    },
    resolveLoader: {
      plugins: [
        PnpWebpackPlugin.moduleLoader(module),
      ],
    },
    module: {
      rules: [
        {
          parser: {
            requireEnsure: false,
            strictExportPresence: true,
          }
        },
        {
          test: [/\.bmp$/, /\.gif$/, /\.jpe?g$/, /\.png$/],
          loader: require.resolve('url-loader'),
          options: {
            limit: 10000,
            name: 'static/media/[name].[hash:8].[ext]',
          },
        },
        {
          test: /\.(mjs|jsx?)$/,
          include: path.resolve('src'),
          loader: require.resolve('babel-loader'),
          options: {
            presets: [
              ['@babel/preset-react', { runtime: 'automatic' }],
            ],
            cacheDirectory: true,
            cacheCompression: false,
            compact: isEnvProduction,
          },
        },
        {
          test: /\.(tsx?)$/,
          use: [
            {
              loader: require.resolve('babel-loader'),
              options: {
                presets: [
                  ['@babel/preset-react', { runtime: 'automatic' }],
                ],
                cacheDirectory: true,
                cacheCompression: false,
                compact: isEnvProduction,
                plugins: [
                  options.serve && require.resolve('react-refresh/babel'),
                ].filter(Boolean),
              },
            },
            { loader: 'ts-loader' },
          ],
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
          sideEffects: true,
        },
      ],
    },
    plugins: truthyArray([
      new HtmlWebpackPlugin({ inject: true, template: 'public/index.html', publicPath }),
      options.serve && new ReactRefreshWebpackPlugin(),
      new webpack.DefinePlugin(options.env),
      new WebpackPlugin(),
      isEnvProduction && new MiniCssExtractPlugin({
        filename: 'static/css/[name].[contenthash:8].css',
        chunkFilename: 'static/css/[name].[contenthash:8].chunk.css',
      }),
      // @ts-ignore
      new ESLintWebpackPlugin({
        extensions: ['js', 'mjs', 'jsx', 'ts', 'tsx'],
        eslintPath: require.resolve('eslint'),
        failOnError: !isEnvDevelopment,
        context: path.resolve('src'),
        cache: true,
        cacheLocation: '.eslintcache',
        cwd: __dirname,
        resolvePluginsRelativeTo: __dirname,
        baseConfig: {
          extends: [require.resolve('eslint-config-react-app/base')],
          rules: {
            'react/react-in-jsx-scope': 'error',
          },
        },
      }),
    ]),
    node: false,
    performance: false,
    devServer: {
      hot: 'only',
      open: false,
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: 'all',
      headers: {
        'Access-Control-Allow-Origin': '*',
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
  };
  return config;
};
