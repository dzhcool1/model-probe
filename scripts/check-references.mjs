// 检测浏览器脚本里「调用了未定义的函数」。
// `node --check` 只做语法检查，删掉一个函数定义后剩下的调用点它查不出来，
// 但运行到那行就会抛 ReferenceError。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["public/app.js"];

// 剥离注释与字符串字面量，避免把文案里的 `名称(` 误判成调用。
function stripLiterals(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      out += " ";
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

// 收集所有可能被调用的名字：顶层/局部函数、箭头函数、变量、参数、解构、catch 绑定。
function collectDefined(original, stripped) {
  const defined = new Set();
  const add = (name) => { if (name) defined.add(name); };
  const addList = (list) => list.split(",").forEach((part) => add(part.trim().split(/[=:\s]/)[0]));

  for (const match of original.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(match[1]);
  for (const match of stripped.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(match[1]);
  for (const match of stripped.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) addList(match[1]);
  for (const match of stripped.matchAll(/\(([^)]*)\)\s*=>/g)) addList(match[1]);
  for (const match of stripped.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(match[1]);
  for (const match of stripped.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) addList(match[1]);
  for (const match of stripped.matchAll(/\b(?:const|let|var)\s*\[([^\]]+)\]/g)) addList(match[1]);
  for (const match of stripped.matchAll(/catch\s*\(([^)]*)\)/g)) addList(match[1]);
  return defined;
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "await", "new", "else", "do", "function", "of", "in", "case", "async"]);
const GLOBALS = new Set(["Number", "String", "Boolean", "Array", "Object", "Map", "Set", "Date", "Math", "JSON", "Promise", "Error", "TypeError", "RangeError", "Response", "Request", "URL", "URLSearchParams", "fetch", "parseInt", "parseFloat", "isNaN", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "encodeURIComponent", "decodeURIComponent", "queueMicrotask", "structuredClone", "RegExp", "Intl", "crypto", "requestAnimationFrame", "TextEncoder", "TextDecoder", "AbortController", "document", "window", "console", "CSS", "btoa", "atob", "confirm", "alert", "prompt", "import"]);

let failed = false;
for (const relative of targets) {
  const original = await readFile(path.join(root, relative), "utf8");
  const stripped = stripLiterals(original);
  const defined = collectDefined(original, stripped);
  const suspects = new Set();
  for (const match of stripped.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    const before = stripped.slice(Math.max(0, match.index - 14), match.index);
    if (/[.$\w]\s*$/.test(before)) continue; // 属性访问 / 方法调用
    if (KEYWORDS.has(name) || defined.has(name) || GLOBALS.has(name)) continue;
    suspects.add(name);
  }
  if (suspects.size) {
    failed = true;
    console.error(relative + " 调用了未定义的函数：" + [...suspects].join(", "));
  } else {
    console.log(relative + " 引用检查通过（" + defined.size + " 个符号）");
  }
}

if (failed) process.exit(1);
