const { execSync, spawnSync } = require("child_process");
const fs = require("fs");

const tag = execSync("git describe --tags --abbrev=0").toString().trim();
console.log("Checking commits since", tag);

const args = ["-n", "1", `${tag}..HEAD`, "--abbrev=7", "--pretty=%h", "--", "CHANGELOG.md"];
function findCommit(line) {
  const result = spawnSync("git", ["log", "-S", line, ...args], { shell: false });
  if (result.status === 0) return result.stdout.toString().trim();
  throw new Error(result.stderr.toString());
}

const lines = fs.readFileSync("CHANGELOG.md").toString().split(/\r?\n/g);

let enhanced = 0;
let shouldEnhance = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith("## Unreleased")) shouldEnhance = true;
  else if (line.startsWith("## ")) break;
  if (!line.startsWith("- ")) continue;
  const commit = findCommit(line);
  if (!commit) continue;
  console.log(line, "=>", commit);
  const brackets = line.match(/ \((.*?)\)$/);
  if (brackets) {
    if (brackets[1].match(/[\da-fA-F]{7}/)) continue;
    if (!brackets[1].includes(" ")) {
      lines[i] = line.replace(/\(.*?\)$/, `(${commit}, ${brackets[1]})`);
      enhanced++;
      continue;
    }
  }
  lines[i] = `${line} (${commit})`;
  enhanced++;
}

console.log(`Enhanced ${enhanced} lines`);
fs.writeFileSync("CHANGELOG.md", lines.join("\n"));
