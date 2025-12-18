#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { recursive: true, pretty: true, includeFolders: false, dryRun: false, deep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "-i") args.input = argv[++i];
    else if (a === "--labels-output") args.labelsOutput = argv[++i];
    else if (a === "--titles-output") args.titlesOutput = argv[++i];
    else if (a === "--output" || a === "-o") args.labelsOutput = argv[++i];
    else if (a === "--no-recursive") args.recursive = false;
    else if (a === "--compact") args.pretty = false;
    else if (a === "--include-folders") args.includeFolders = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--deep") args.deep = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return [
    "用法：node tools/generate-light-index.mjs --input <翻译目录> [--labels-output <labels.json>] [--titles-output <titles.json>] [--include-folders] [--compact] [--no-recursive] [--dry-run] [--deep]",
    "",
    "输出：",
    "- labels.json：{ \"module.pack\": \"译名label\", ... }",
    "- titles.json：{ \"module.pack\": { \"titles\": {\"原名\": \"译名\"}, \"folders\": {\"原文件夹\": \"译名\"} }, ... }",
    "",
    "说明：全量读取翻译文件并抽取“标题(name)”与 folders 映射，便于启动期轻量翻译 Compendium 列表与索引标题。",
    "默认只抽取 entries 顶层的标题（对应 compendium 索引条目）。如果你需要把嵌套结构里的 name 也索引出来，用 --deep。",
  ].join("\n");
}

async function* walk(dir, recursive) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!recursive) continue;
      yield* walk(full, recursive);
      continue;
    }
    yield full;
  }
}

function isJsonFile(file) {
  return file.toLowerCase().endsWith(".json");
}

function baseNameNoExt(file) {
  return path.basename(file, path.extname(file));
}

function decodeCollectionKey(stem) {
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

function upsertNested(obj, key, factory) {
  if (!obj[key]) obj[key] = factory();
  return obj[key];
}

function sortObject(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

function extractTitlesFromEntries(entries, { deep } = { deep: false }) {
  const titles = {};
  if (!entries) return titles;

  const scanNestedTitles = (node) => {
    if (!deep) return;
    if (!node) return;
    if (Array.isArray(node)) {
      for (const v of node) scanNestedTitles(v);
      return;
    }
    if (typeof node !== "object") return;

    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") {
        if (typeof v.name === "string" && v.name.trim()) {
          titles[k] = v.name;
        }
        scanNestedTitles(v);
      }
    }
  };

  if (Array.isArray(entries)) {
    for (const row of entries) {
      if (!row || typeof row !== "object") continue;
      const originalKey = typeof row.id === "string" ? row.id : (typeof row._id === "string" ? row._id : null);
      const translated = typeof row.name === "string" ? row.name : null;
      if (originalKey && translated && translated.trim()) {
        titles[originalKey] = translated;
      }
      scanNestedTitles(row);
    }
    return titles;
  }

  if (typeof entries === "object") {
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v === "string") {
        if (v.trim()) titles[k] = v;
        continue;
      }
      if (v && typeof v === "object") {
        const translated = typeof v.name === "string" ? v.name : null;
        if (translated && translated.trim()) {
          titles[k] = translated;
        }
        scanNestedTitles(v);
      }
    }
  }

  return titles;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  const inputDir = path.resolve(args.input);
  const labelsOutput = path.resolve(args.labelsOutput ?? path.join(inputDir, "labels.json"));
  const titlesOutput = path.resolve(args.titlesOutput ?? path.join(inputDir, "titles.json"));

  const labels = {};
  const titlesIndex = {};

  const files = [];
  for await (const file of walk(inputDir, args.recursive)) files.push(file);
  files.sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    if (!isJsonFile(file)) continue;
    const name = path.basename(file).toLowerCase();
    if (name === "labels.json") continue;
    if (name === "titles.json") continue;
    if (name === "mapping.json") continue;
    if (!args.includeFolders && name.endsWith("_packs-folders.json")) continue;

    let json;
    try {
      const raw = await fs.readFile(file, "utf8");
      json = JSON.parse(raw);
    } catch {
      continue;
    }

    const stem = baseNameNoExt(file);
    const collection = decodeCollectionKey(stem);

    if (typeof json?.label === "string" && json.label.trim()) {
      labels[collection] = json.label;
    }

    const packIndex = upsertNested(titlesIndex, collection, () => ({ titles: {}, folders: {} }));
    const extractedTitles = extractTitlesFromEntries(json?.entries, { deep: args.deep });
    Object.assign(packIndex.titles, extractedTitles);

    if (json?.folders && typeof json.folders === "object" && !Array.isArray(json.folders)) {
      Object.assign(packIndex.folders, json.folders);
    }
  }

  const outLabels = JSON.stringify(sortObject(labels), null, args.pretty ? 2 : 0) + "\n";

  const normalizedTitlesIndex = {};
  let totalTitles = 0;
  let totalFolders = 0;
  for (const collection of Object.keys(titlesIndex).sort()) {
    const titles = sortObject(titlesIndex[collection].titles ?? {});
    const folders = sortObject(titlesIndex[collection].folders ?? {});
    const titleCount = Object.keys(titles).length;
    const folderCount = Object.keys(folders).length;
    if (titleCount === 0 && folderCount === 0) {
      continue;
    }

    totalTitles += titleCount;
    totalFolders += folderCount;
    normalizedTitlesIndex[collection] = { titles, folders };
  }
  const outTitles = JSON.stringify(normalizedTitlesIndex, null, args.pretty ? 2 : 0) + "\n";

  if (args.dryRun) {
    process.stdout.write(outLabels);
    process.stdout.write(outTitles);
    return;
  }

  await fs.mkdir(path.dirname(labelsOutput), { recursive: true });
  await fs.mkdir(path.dirname(titlesOutput), { recursive: true });
  await fs.writeFile(labelsOutput, outLabels, "utf8");
  await fs.writeFile(titlesOutput, outTitles, "utf8");

  console.log(`已生成：${labelsOutput}（${Object.keys(labels).length} 条）`);
  console.log(`已生成：${titlesOutput}（${Object.keys(normalizedTitlesIndex).length} 包，标题 ${totalTitles} 条，文件夹 ${totalFolders} 条）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
