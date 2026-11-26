// src/tracker/rooms/gitee/model/parent-line.ts —— Gitee 父子关系的正文兜底约定
//
// 为什么有这份文件：Gitee 的 Open API 在改票时可以带 parent_id，但个人仓库实测会静默忽略
// 这个字段（PATCH 回成功，读回来却没有父票）。远端结构字段靠不住，就把关系写成票正文里
// 一行约定好的文字，读侧再从正文里解析回来。写与读共用这一份约定，两边的判断才不会走偏。
//
// 约定只有一条，必须逐字一致：`上级地图：#<票号>`。整行只写票号，不带链接、不带标题。
// 存量票里出现过带链接的老写法 `上级地图：[标题](链接)`，读侧仍认它（只取链接尾段的票号），
// 但写侧永远只产生新写法，不再把带链接的一行写回去。
//
// 为什么认行要限定在正文开头：正文中段可能引用别的票、也可能贴日志，整篇模糊搜索会把
// 「提到票号」误判成「父子关系写着」。这里只看正文开头若干行，与票面模板把归属写在最上面一致。

/** 父票行的开头文字。读写两侧都必须用它拼，别各自抄一份字面量。 */
export const PARENT_LINE_LABEL = '上级地图：'

/** 解析时最多看正文前多少行；超过这个范围的行一律不算父票行。 */
export const PARENT_LINE_SCAN_LINES = 20

/** 规范写法的父票行：一行、只写票号、不带链接。 */
export function parentLineText(key: string): string {
  return PARENT_LINE_LABEL + '#' + String(key).trim()
}

/** 这一行是不是父票行（规范写法或存量带链接写法）。withParentLine 删旧行、读侧解析共用它。 */
function isParentLine(line: string): boolean {
  const text = String(line == null ? '' : line).trim()
  if (!text.startsWith(PARENT_LINE_LABEL)) return false
  const rest = text.slice(PARENT_LINE_LABEL.length).trim()
  if (/^#[^\s#]+$/.test(rest)) return true
  // 存量写法：`[标题](链接)`。链接里可能带括号外的空白，这里只要求方括号与圆括号配对。
  return /^\[[^\]]*\]\(\s*\S+?\s*\)$/.test(rest)
}

/** 从链接尾段的 `/issues/<尾段>` 取票号；尾段是纯数字或空时取不到，回 null。 */
function keyFromUrl(url: string): string | null {
  const m = /\/issues\/([^\/?#]+)\/?$/.exec(String(url || '').trim())
  if (!m) return null
  let tail = m[1]
  try {
    tail = decodeURIComponent(tail)
  } catch (e) {
    // 链接里的百分号编码坏了就按原样用；票号本来就只该是字母数字。
  }
  tail = tail.trim()
  if (!tail || /^[0-9]+$/.test(tail)) return null
  return tail
}

/**
 * 从票正文里解析父票票号。只看开头 PARENT_LINE_SCAN_LINES 行，遇到第一行父票行就停。
 *
 * 规范写法取 `#` 后面的票号；存量带链接写法取链接尾段（纯数字不算票号：那是 Gitee 的内部
 * 数字 id，不是能拿去查票的票号）。两样都不是时回 null，绝不编一个票号。
 */
export function parentKeyFromBody(body: unknown): string | null {
  const text = typeof body === 'string' ? body : ''
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const limit = Math.min(lines.length, PARENT_LINE_SCAN_LINES)
  for (let i = 0; i < limit; i++) {
    const line = lines[i].trim()
    if (!line.startsWith(PARENT_LINE_LABEL)) continue
    const rest = line.slice(PARENT_LINE_LABEL.length).trim()
    const plain = /^#([^\s#]+)$/.exec(rest)
    if (plain) return plain[1].trim()
    const linked = /^\[[^\]]*\]\(\s*(\S+?)\s*\)$/.exec(rest)
    if (linked) {
      const fromUrl = keyFromUrl(linked[1])
      if (fromUrl) return fromUrl
    }
  }
  return null
}

/**
 * 把正文改成「父票指向 key」的样子：删掉正文里所有父票行，再在开头那段 HTML 注释之后插入一行。
 *
 * 为什么要先删全部旧行：改挂另一张地图时，正文里留着一旧一新两行，读侧按第一行认，就会把
 * 关系判成旧的。重复挂同一张地图也要稳定：同样的输入两次调用得到同样的正文，只有一行。
 *
 * 为什么插在开头注释之后：票面最前面可能有一行类型标记 `<!-- DSH-ISSUE-KIND: … -->` 或幂等锚，
 * 它们必须留在开头才读得到（markerKindInHeader 只看第一个标题之前、最多前 10 行）；父票行紧随其后。
 */
export function withParentLine(body: unknown, key: string): string {
  const text = typeof body === 'string' ? body : ''
  const lines = text.split(/\r?\n/).filter(function (line) { return !isParentLine(line) })
  if (lines.every(function (line) { return line.trim() === '' })) lines.length = 0
  let at = 0
  while (at < lines.length && lines[at].trim() === '') at++
  if (at < lines.length && lines[at].trim().startsWith('<!--')) {
    while (at < lines.length && lines[at].indexOf('-->') < 0) at++
    at++
  }
  lines.splice(at, 0, parentLineText(key))
  return lines.join('\n')
}

export default { PARENT_LINE_LABEL, PARENT_LINE_SCAN_LINES, parentLineText, parentKeyFromBody, withParentLine }
