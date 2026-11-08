#!/usr/bin/env node
/**
 * _direct/packfile.mjs —— 批次容器（**本机与对端共用同一份真相**，随主件一起 scp 到对端）
 *
 * ── 为什么不用 `tar`（2026-10-28 实测，别改回去）────────────────────────────────
 * 本卡原计划「打成 tar → scp → 对端解包」，实测两条路都不通：
 *   ① `tar -c -f x.tar -T list.txt` 传 **UTF-8 列表** ⇒
 *      `tar.exe: Can't convert a path to a wchar_t string: Unknown error`，rc=1，
 *      含中文名的条目一个都没进包（只进去一个 `a b.md`）。
 *   ② 传 **GBK 列表** ⇒ rc=0，但归档里存的是 **GBK 字节**（`tar -tf` 打出来是 `�ܼұ���/���Ĳ����ļ�.md`）
 *      ⇒ 对端解包是否还原成原名取决于它的代码页，**不是逐字节可证的事**。
 *   ③ 改走命令行 argv 传名（不用 `-T`）⇒ 3,500 个中文路径 × 3 字节/字 ≈ 140 KB，
 *      远超 CreateProcess 的 32,767 上限。
 * ⇒ 自己写容器：纯 Node、无外部工具、无代码页、名字按 UTF-8 存在 JSON 头里、每个文件带 sha256。
 *
 * ── 格式（全部小端）────────────────────────────────────────────────────────────
 *   offset 0   : magic 'DSHPACK1'（8 字节 ASCII）
 *   offset 8   : uint32 头长度 N
 *   offset 12  : 头 JSON（UTF-8，N 字节）
 *   offset 12+N: 载荷（各文件字节按头里 entries[i].offset 顺序紧排）
 *
 *   头 = {
 *     schemaVersion: 1, magic: 'DSHPACK1', specKey, host, createdAt, stamp,
 *     entries: [{ relPath, size, mtimeMs, sha256, offset }]   // offset 相对载荷起点
 *   }
 *
 * 🔴 本文件**只做读写**，不做任何删除/搬移；路线与规则全在 select/place/unplace 与主件里。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const PACK_MAGIC = 'DSHPACK1';
export const PACK_EXT = '.pk';
export const PACK_SCHEMA_VERSION = 1;
const HEAD_OFFSET = 12;

export function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256FileAbs(absPath) {
  return sha256Buf(fs.readFileSync(absPath));
}

/**
 * 写一个批次包。**读文件 → 算 sha → 追加**，一次读完（批次上限 32 MB，内存无压力）。
 * @param {string} file 目标包路径（本机暂存目录 / 对端暂存目录）
 * @param {{specKey?:string, host?:string, stamp?:string, files:Array<{relPath:string,absPath:string,mtimeMs?:number}>}} opts
 */
export function writePack(file, opts = {}) {
  const files = Array.isArray(opts.files) ? opts.files : [];
  const entries = [];
  const chunks = [];
  let offset = 0;
  for (const f of files) {
    if (!f || typeof f.absPath !== 'string' || typeof f.relPath !== 'string') {
      throw new Error(`writePack: files[i] 形状不对（要 {relPath, absPath}）：${JSON.stringify(f)}`);
    }
    const buf = fs.readFileSync(f.absPath);
    entries.push({
      relPath: f.relPath,
      size: buf.length,
      mtimeMs: Math.round(Number(f.mtimeMs ?? fs.statSync(f.absPath).mtimeMs)),
      sha256: sha256Buf(buf),
      offset,
    });
    chunks.push(buf);
    offset += buf.length;
  }
  const header = {
    schemaVersion: PACK_SCHEMA_VERSION,
    magic: PACK_MAGIC,
    specKey: opts.specKey ?? null,
    host: opts.host ?? os.hostname(),
    createdAt: new Date().toISOString(),
    stamp: opts.stamp ?? null,
    entries,
  };
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  const n = Buffer.alloc(4);
  n.writeUInt32LE(hb.length, 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(PACK_MAGIC, 'ascii'), n, hb, ...chunks]));
  return { file, bytes: fs.statSync(file).size, header };
}

/** 读包（整包进内存；调用方负责批次上限）。 */
export function loadPack(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < HEAD_OFFSET) throw new Error(`批次包太短（${buf.length} B）：${file}`);
  const magic = buf.subarray(0, 8).toString('ascii');
  if (magic !== PACK_MAGIC) throw new Error(`不是本格式的批次包（magic=${JSON.stringify(magic)}）：${file}`);
  const headerLen = buf.readUInt32LE(8);
  const headerEnd = HEAD_OFFSET + headerLen;
  if (headerEnd > buf.length) throw new Error(`批次包头长度越界（${headerLen}）：${file}`);
  let header;
  try { header = JSON.parse(buf.subarray(HEAD_OFFSET, headerEnd).toString('utf8')); }
  catch (e) { throw new Error(`批次包头不是合法 JSON：${e?.message ?? e}`); }
  if (!Array.isArray(header?.entries)) throw new Error('批次包头缺少 entries[]');
  return { file, buf, header, headerEnd };
}

/** 取某个条目的字节（**按头里记的 size/offset 切片**，不信任外部传进来的偏移）。 */
export function entryBuffer(pack, entry) {
  const size = Number(entry?.size);
  const offset = Number(entry?.offset);
  if (!Number.isFinite(size) || !Number.isFinite(offset) || size < 0 || offset < 0) throw new Error('条目 offset/size 非法');
  const s = pack.headerEnd + offset;
  const e = s + size;
  if (e > pack.buf.length) throw new Error(`批次包被截断（要 ${e} 字节、实有 ${pack.buf.length}）：${entry.relPath}`);
  return pack.buf.subarray(s, e);
}

export default { writePack, loadPack, entryBuffer, sha256Buf, sha256FileAbs, PACK_MAGIC, PACK_EXT };
