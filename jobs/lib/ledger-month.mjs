// ============================================================================
// dsh-butler / lib/ledger-month.mjs —— 「月」的全部算法 · **零依赖**（不 import 任何东西）
//
// 出处：docs\方案-三层角色工作方式与主线流水-V9.md
//   §5.4 末条（L417）「**"上月"必须处理年份退位**（I-12）：1 月的上一个月是**去年 12 月**；
//        `lib\ledger-month.mjs` **今天不存在**（P1 要新建）⇒ 跨年夹具必备，否则每年 1 月静默"上月空"」
//   §14.3 R-11（L1152）「**禁止改系统月份**；`lib\ledger-month.mjs` / `ledger-read.mjs` 收 `--now <ISO>`」
//   §5.1 文件名行（L204）`<lineId>-<YYYYMM>.jsonl`（当月也带月后缀，**不是** `<lineId>.jsonl`）
//   §5.1 retention（L213）「读端只读「当月 + 上月」」
//
// 为什么不复用 `lib\mainline-ledger-writer.mjs#monthOf`：那是**写者**模块，读端 import 它会被
//   `ledger-writer-audit.mjs` 记进 `indirect`（"import 了 writer"）—— 读端零写盘这条不变量就
//   从"机械可验"退化成"要人看它到底调没调写函数"。⇒ 月算法单独一份零依赖模块，读写两侧共用；
//   写者那份 `monthOf` 保留（它只管 `YYYYMM`，与本模块的 `YYYY-MM` 差一个分隔符）。
//
// 两种月份写法，别混：
//   `YYYY-MM`  ← 本模块对外唯一形态（人能读、能比较、能跨年加减）
//   `YYYYMM`   ← 只出现在文件名里（`ledgerFileName()` 负责转换，别自己拼）
//
// 时区口径（V9 §5.4 末条 + R-11）：
//   `monthOf('2026-12-31T23:59:59+08:00')` ⇒ `2026-12`（**按字面 +08:00 的本地月**，不是 UTC 月）。
//   ⇒ 带显式偏移的 ISO **直接取字面年月**（字面值本来就是那台机器的本地时间）；
//     不带偏移的（裸 `YYYY-MM-DD` / `new Date()` / 毫秒数）才落到**本机时区**算。
//   ⚠️ 绝不"先转 UTC 再取月" —— 那会把 +08 的 1 月 1 日 00:30 算成去年 12 月。
// ============================================================================

/** `YYYY-MM` 形状 */
const MONTH_RE = /^(\d{4})-(\d{2})$/;
/** `YYYYMM` 形状（文件名里的紧凑写法） */
const COMPACT_RE = /^(\d{4})(\d{2})$/;
/**
 * ISO / 日期字面量。分组：1..3=年月日，4..6=时分秒，7=小数秒，8=偏移（`Z` / `+08:00` / `+0800`）
 * ⚠️ 时间部分整体可省（`2026-12-31` 也收）。
 */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 解析一个月份写法。**非法 ⇒ 返回 null（不抛）** —— 读端拿它做"这名字像不像月份"的探针，
 * 抛异常会让一条坏文件名炸掉整次读。
 * @param {string} s `YYYY-MM` 或 `YYYYMM`
 * @returns {string|null} 规范形 `YYYY-MM`；非法 ⇒ null
 */
export function parseMonth(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  let y; let m;
  const a = MONTH_RE.exec(raw);
  const b = a ? null : COMPACT_RE.exec(raw);
  if (a) { y = Number(a[1]); m = Number(a[2]); } else if (b) { y = Number(b[1]); m = Number(b[2]); } else return null;
  if (!Number.isInteger(y) || y < 1000 || y > 9999) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  return `${y}-${pad2(m)}`;
}

/** `YYYY-MM` ⇒ `YYYYMM`（文件名用）；非法入参直接抛（内部调用点都是已校验过的） */
export function toCompact(month) {
  const m = parseMonth(month);
  if (!m) throw new Error(`toCompact: 非法月份 = ${String(month)}`);
  return m.replace('-', '');
}

/** `YYYYMM` ⇒ `YYYY-MM`；非法 ⇒ null */
export function fromCompact(compact) {
  return parseMonth(compact);
}

/**
 * 任意时刻 ⇒ 它落在哪个月（`YYYY-MM`）。**非法入参抛**（调用点都在写/读的必经路上，
 * 静默回落成"这个月"会把错月读成对月）。
 * @param {string|number|Date} ts ISO 字面量（可带偏移）/ `YYYY-MM` / `YYYYMM` / 毫秒数 / Date
 * @returns {string} `YYYY-MM`
 */
export function monthOf(ts) {
  if (ts instanceof Date) {
    if (Number.isNaN(ts.getTime())) throw new Error('monthOf: 非法 Date');
    return `${ts.getFullYear()}-${pad2(ts.getMonth() + 1)}`;
  }
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) throw new Error(`monthOf: 非法毫秒数 = ${String(ts)}`);
    return monthOf(new Date(ts));
  }
  if (typeof ts !== 'string') throw new Error(`monthOf: 不认识的入参类型 ${typeof ts}`);
  const raw = ts.trim();
  if (!raw) throw new Error('monthOf: 空字符串');

  // 月份写法直接过（`--now 2026-12` 这类也收）
  const asMonth = parseMonth(raw);
  if (asMonth) return asMonth;

  const m = ISO_RE.exec(raw);
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]);
    if (y < 1000 || y > 9999 || mo < 1 || mo > 12) throw new Error(`monthOf: 非法日期 = ${raw}`);
    // 带偏移 ⇒ 字面值就是那台机器的本地时间 ⇒ **按字面取月**（见文件头时区口径）
    if (m[8]) return `${y}-${pad2(mo)}`;
    // 不带偏移 ⇒ 落到本机时区再取一次（跨时区换机时才能对得上"本机看到的几月"）
    const d = new Date(y, mo - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    if (Number.isNaN(d.getTime())) throw new Error(`monthOf: 非法日期 = ${raw}`);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  // 兜底：交给 Date（只认它认得的；认不出 ⇒ 抛）
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`monthOf: 认不出的时间 = ${raw}`);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/**
 * 月份加减（**年份退位的主实现**：1 月的上一个 = 去年 12 月）。
 * @param {string} month `YYYY-MM`
 * @param {number} delta 整数；负数往前
 * @returns {string} `YYYY-MM`
 */
export function addMonths(month, delta) {
  const m = parseMonth(month);
  if (!m) throw new Error(`addMonths: 非法月份 = ${String(month)}`);
  const d = Number(delta);
  if (!Number.isInteger(d)) throw new Error(`addMonths: delta 必须是整数（收到 ${String(delta)}）`);
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  const total = y * 12 + (mo - 1) + d; // 以"绝对月序"算，退位/进位自动处理
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  if (ny < 1000 || ny > 9999) throw new Error(`addMonths: 算出来年份越界（${ny}）`);
  return `${ny}-${pad2(nm)}`;
}

/** 上一个月：`prevMonth('2027-01') === '2026-12'`（V9 §5.4 末条 / I-12） */
export function prevMonth(month) {
  return addMonths(month, -1);
}

/** 下一个月：`nextMonth('2026-12') === '2027-01'` */
export function nextMonth(month) {
  return addMonths(month, 1);
}

/** 月序比较：a<b ⇒ -1 / 相等 ⇒ 0 / a>b ⇒ 1（非法入参抛） */
export function compareMonth(a, b) {
  const x = parseMonth(a);
  const y = parseMonth(b);
  if (!x) throw new Error(`compareMonth: 非法月份 = ${String(a)}`);
  if (!y) throw new Error(`compareMonth: 非法月份 = ${String(b)}`);
  return x < y ? -1 : (x > y ? 1 : 0);
}

/**
 * 主账文件名：`<lineId>-<YYYY-MM>.jsonl` ⇒ `<lineId>-<YYYYMM>.jsonl`（§5.1 L204）。
 * ⚠️ 当月文件**也带月后缀** —— 不做"每月 1 号 rename"（rename 撞被读文件抛 EPERM，E7）。
 * @param {string} lineId 受控标识符（`l-<hostTag>-<NNN>`）；空 / 带路径分隔符 ⇒ 抛
 * @param {string} month `YYYY-MM`
 */
export function ledgerFileName(lineId, month) {
  const id = String(lineId ?? '').trim();
  if (!id) throw new Error('ledgerFileName: lineId 为空');
  if (/[\\/]/.test(id)) throw new Error(`ledgerFileName: lineId 不许带路径分隔符（${id}）`);
  return `${id}-${toCompact(month)}.jsonl`;
}

/**
 * 文件名 ⇒ `{lineId, month, compact}`；不像账本文件 ⇒ **null**（不抛）。
 * 解析口径 = "尾部 `-YYYYMM.jsonl`"，前面整段就是 lineId（lineId 自身含 `-` 与数字，
 * 用贪婪 `.*` 从尾部切最稳）。
 * @param {string} fileName 不含目录的文件名
 * @returns {{lineId:string, month:string, compact:string}|null}
 */
export function parseLedgerFileName(fileName) {
  const name = String(fileName ?? '').trim();
  if (!name.toLowerCase().endsWith('.jsonl')) return null;
  const stem = name.slice(0, -'.jsonl'.length);
  const m = /^(.*)-(\d{4})(\d{2})$/.exec(stem);
  if (!m) return null;
  const lineId = m[1];
  const month = parseMonth(`${m[2]}-${m[3]}`);
  if (!lineId || !month) return null;
  return { lineId, month, compact: `${m[2]}${m[3]}` };
}

/**
 * 读端要读的月份窗口：`['<当月>', '<上月>']`（顺序 = 新→旧；跨年自动退位）。
 * ⚠️ 顺序是**语义**：`[0]` 永远 = 当月（判 `rotated-new` / `empty` 用它），
 *   `[1]` 永远 = 上月（判 `rotated-new` 的"有上月文件"用它）。
 * @param {string|number|Date} now 注入的时钟（R-11：夹具用 `--now` 造，禁改系统月份）
 * @returns {[string,string]}
 */
export function monthWindow(now = new Date()) {
  const cur = monthOf(now);
  return [cur, prevMonth(cur)];
}

export default {
  parseMonth,
  monthOf,
  addMonths,
  prevMonth,
  nextMonth,
  compareMonth,
  toCompact,
  fromCompact,
  ledgerFileName,
  parseLedgerFileName,
  monthWindow,
};
