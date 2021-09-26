
const sm = require('source-map');
const rl = require('readline');
const fs = require('fs');

/** @type {Record<string, Promise<sm.BasicSourceMapConsumer>>} */
const maps = {};

for (const file of fs.readdirSync('./dist')) {
    if (!file.endsWith('.js.map')) continue;
    const name = file.replace('.js.map', '.js');
    /** @type {sm.RawSourceMap} */
    const json = JSON.parse(fs.readFileSync(`./dist/${file}`));
    json.sourceRoot = 'src';
    maps[name] = new sm.SourceMapConsumer(json);
    console.log('Added map for', name, 'wrapping', json.sources.length, 'source files');
}

console.log();

const SOURCE_NAME_REGEX = /^\s*at .*? \(.*?[/\\]dist[/\\]((?:\d+\.)?extension\.js):(\d+):(\d+)\)$/;
const SOURCE_ANOM_REGEX = /^\s*at .*?[/\\]dist[/\\]((?:\d+\.)?extension\.js):(\d+):(\d+)$/;

let error = '';
rl.createInterface(process.stdin).on('line', async l => {
    if (l) return error += l + '\n';
    for (let stack of error.split('\n')) {
        const named = stack.match(SOURCE_NAME_REGEX);
        const mat = named || stack.match(SOURCE_ANOM_REGEX);
        if (mat) {
            let [, file, line, column] = mat;
            line = parseInt(line);
            column = parseInt(column);
            const map = await maps[file];
            if (!map) {
                stack += ' [MISSING]';
                console.log(stack);
                continue;
            }
            const pos = map.originalPositionFor({ line, column });
            if (!pos.line) {
                stack += ' [MISMAPPED]';
                console.log(stack);
                continue;
            }
            const ws = stack.match(/^\s*/)[0];
            if (named && pos.name) {
                stack = `${ws}at ${pos.name} (${pos.source}:${pos.line}:${pos.column})`;
            } else {
                stack = `${ws}at ${pos.source}:${pos.line}:${pos.column}`;
            }
        }
        console.log(stack);
    }
    console.log();
    error = '';
});
