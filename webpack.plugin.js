//@ts-check
"use strict";

const webpack = require("webpack");
const { createHash } = require("crypto");

const _formatIdCache = new Map();
/** @type {(id: string, rootPath: string) => string} */
function formatId(id, rootPath) {
  // Make sure all paths use /
  id = id.replace(/\\/g, "/");
  // For `[path]` we unwrap, format then rewrap
  if (id[0] === "[" && id.endsWith("]")) {
    return `[${formatId(id.slice(1, id.length - 1), rootPath)}]`;
  }
  // When dealing with `path1!path2`, format each segment separately
  if (id.includes("!")) {
    id = id
      .split("!")
      .map((s) => formatId(s, rootPath))
      .join("!");
  }
  // Make the paths relative to the project's rooth path if possible
  if (id.startsWith(rootPath)) {
    id = id.slice(rootPath.length);
    id = (id[0] === "/" ? "." : "./") + id;
  }
  let formatted = _formatIdCache.get(id);
  if (formatted) return formatted;
  // Check if we're dealing with a Yarn directory
  let match = id.match(/^.*\/(\.?Yarn\/Berry|\.yarn)\/(.*)$/i);
  if (!match) {
    _formatIdCache.set(id, (formatted = id));
    return formatted;
  }
  const [, yarn, filepath] = match;
  // Check if we can extract the package name/version from the path
  match =
    filepath.match(/^unplugged\/([^/]+?)\-[\da-f]{10}\/node_modules\/(.*)$/i) ||
    filepath.match(/^cache\/([^/]+?)\-[\da-f]{10}\-\d+\.zip\/node_modules\/(.*)$/i);
  if (!match) {
    formatted = `/${yarn.toLowerCase() === ".yarn" ? "." : ""}yarn/${filepath}`;
    _formatIdCache.set(id, formatted);
    return formatted;
  }
  const [, name, path] = match;
  formatted = `${yarn.toLowerCase() === ".yarn" ? "." : "/"}yarn/${name}/${path}`;
  _formatIdCache.set(id, formatted);
  return formatted;
}
module.exports.formatId = formatId;

class WebpackPlugin {
  _hashModuleCache = new Map();
  /** @type {(mod: webpack.Module, rootPath: string) => string} */
  hashModule(mod, rootPath) {
    // Prefer `nameForCondition()` as it usually gives the actual file path
    // while `identifier()` can have extra `!` or `|` suffixes, i.e. a hash that somehow differs between devices
    const identifier = formatId(mod.nameForCondition() || mod.identifier(), rootPath);
    let hash = this._hashModuleCache.get(identifier);
    if (hash) return hash;
    hash = createHash("sha1").update(identifier).digest("hex");
    this._hashModuleCache.set(identifier, hash);
    return hash;
  }
  /** @param {webpack.Compiler} compiler */
  apply(compiler) {
    // Output start/stop messages making the $ts-webpack-watch problemMatcher (provided by an extension) work
    let compilationDepth = 0; // We ignore nested compilations
    compiler.hooks.beforeCompile.tap("WebpackPlugin-BeforeCompile", (params) => {
      if (compilationDepth++) return;
      console.log("Compilation starting");
    });
    compiler.hooks.afterCompile.tap("WebpackPlugin-AfterCompile", () => {
      if (--compilationDepth) return;
      console.log("Compilation finished");
    });
    compiler.hooks.compilation.tap("WebpackPlugin-Compilation", (compilation) => {
      const rootPath = (compilation.options.context || "").replace(/\\/g, "/");
      compilation.options.optimization.chunkIds = false;
      // Format `../../../Yarn/Berry/` with all the `cache`/`unplugged`/`__virtual__` to be more readable
      // (i.e. `/yarn/package-npm-x.y.z/package/index.js` for global Yarn cache or `/.yarn/...` for local)
      compilation.hooks.statsPrinter.tap("WebpackPlugin-StatsPrinter", (stats) => {
        /** @type {(id: string | {}, context: any) => string} */
        const tapModId = (id, context) => (typeof id === "string" ? formatId(context.formatModuleId(id), rootPath) : "???");
        stats.hooks.print.for("module.name").tap("WebpackPlugin-ModuleName", tapModId);
      });
      // Include an `excludeModules` to `options.stats` to exclude modules loaded by dependencies
      compilation.hooks.statsNormalize.tap("WebpackPlugin-StatsNormalize", (stats) => {
        (stats.excludeModules || (stats.excludeModules = [])).push((name, { issuerPath }) => {
          if (name.startsWith('external "')) return true;
          const issuer = issuerPath && (issuerPath[issuerPath.length - 1].name || "").replace(/\\/g, "/");
          if (!issuer) return false;
          const lower = formatId(issuer, rootPath).toLowerCase();
          if (lower.startsWith("/yarn/")) return true;
          if (lower.startsWith(".yarn/")) return true;
          return false;
        });
      });
      // Determines how chunk IDs are generated, which is now actually deterministic
      // (we make sure to clean Yarn paths to prevent issues with `../../Yarn/Berry` being different on devices)
      compilation.hooks.chunkIds.tap("WebpackPlugin-ChunkIds", (chunks) => {
        const chunkIds = new Map();
        const overlapMap = new Set();
        let minLength = 4; // show at least 3 characters
        // Calculate the hashes for all the chunks
        for (const chunk of chunks) {
          if (chunk.id) {
            console.log(`Chunk ${chunk.id} already has an ID`);
          }
          // We're kinda doing something similar to Webpack 5's DeterministicChunkIdsPlugin but different
          const modules = compilation.chunkGraph.getChunkRootModules(chunk);
          const hashes = modules.map((m) => this.hashModule(m, rootPath)).sort();
          const hasher = createHash("sha1");
          for (const hash of hashes) hasher.update(hash);
          const hash = hasher.digest("hex");
          // With a 160-bit value, a clash is very unlikely, but let's check anyway
          if (chunkIds.has(hash)) throw new Error("Hash collision for chunk IDs");
          chunkIds.set(chunk, hash);
          chunk.id = hash;
          // Make sure the minLength remains high enough to avoid collisions
          for (let i = minLength; i < hash.length; i++) {
            const part = hash.slice(0, i);
            if (overlapMap.has(part)) continue;
            overlapMap.add(part);
            minLength = i;
            break;
          }
        }
        // Assign the shortened (collision-free) hashes for all the chunks
        for (const [chunk, hash] of chunkIds) {
          chunk.id = hash.slice(0, minLength);
          chunk.ids = [chunk.id];
        }
      });
    });
  }
}
module.exports.WebpackPlugin = WebpackPlugin;
