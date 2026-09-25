/* 计算不可变发布目录的实际文件指纹；不包含 releases/current.json 指针。 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const releaseRoot = path.resolve(process.argv[2] || process.cwd());

function collectFiles(directory, relative = "") {
  const entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(directory, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files;
}

const files = collectFiles(releaseRoot).sort();
const digest = crypto.createHash("sha256");
for (const relative of files) {
  digest.update(relative);
  digest.update(fs.readFileSync(path.join(releaseRoot, relative)));
}

process.stdout.write(JSON.stringify({
  sha256: digest.digest("hex").toUpperCase(),
  fileCount: files.length,
}));
