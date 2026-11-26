/**
 * src/tracker/rooms/gitee/model/blocked-by-section.ts —— 票正文末尾的「## Blocked by」小节
 *
 * Gitee 的 Open API 里没有任何表达「这张票被谁阻塞」的字段或端点，所以这条关系只能写进票正文，
 * 读侧再从同一处解析回来。写与读必须共用这一份约定，任何一边单改都会让另一边的历史数据读不出来。
 *
 * 约定（规格 #7）：阻塞关系写在票正文末尾的 `## Blocked by` 小节里，条目形如 `- 标题（#票号）`。
 * 票号才是判据，标题那一段只供人看，所以读侧不拿标题做匹配；标题缺失时写出来就是 `- #票号`。
 * 存量票的条目可能是带链接的老写法 `- [标题](https://gitee.com/owner/repo/issues/票号)`，读侧照样认。
 *
 * 为什么只在末尾写：小节同时是给人看的正文的一部分，写在末尾不会把标题和简介顶开；
 * 读侧不按「只在末尾」死判，因为存量票的小节可能夹在正文中间，宁可读得出来也不要漏掉关系。
 */

/** 小节的标题行。写侧只写这一种形状，读侧认它带不带冒号、带不带空格。 */
export const BLOCKED_BY_HEADING = '## Blocked by'

/** 一条阻塞关系：票号必填，标题可能为空（存量票或人手写时没写标题）。 */
export interface BlockedByEntry {
  key: string
  title: string
}

const ANY_HEADING = /^#{1,6}\s/
const SECTION_HEADING = /^#{1,6}\s+blocked\s+by\s*[:：]?\s*$/i
const LIST_ITEM = /^\s*[-*+]\s+(.*)$/
// 规范条目「标题（#票号）」：标题可以有括号，所以从右往左找最后一个（#…），且票号里不许有空白。
const KEYED_ENTRY = /^(.*?)[（(]\s*#([^\s#()（）]+)\s*[）)]\s*$/
// 存量条目「[标题](链接)」：票号取链接尾段，纯数字尾段是远端内部 id，不冒充票号。
const LINK_ENTRY = /^(?:\[([^\]]*)\])?\(\s*(\S+?)\s*\)\s*$/
// 人可能只写了裸票号。
const BARE_ENTRY = /^#([^\s#]+)$/

function isAnyHeading(line: string): boolean {
  return ANY_HEADING.test(line.trim())
}

function isSectionHeading(line: string): boolean {
  return SECTION_HEADING.test(line.trim())
}

/** 从票链接里取票号；尾段是纯数字时取不到——那是远端内部 id，拿它当票号会指向不存在的票。 */
function keyFromLink(url: string): string {
  const tail = String(url || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || ''
  if (!tail || /^\d+$/.test(tail)) return ''
  return tail
}

/**
 * 解析一条列表项。认三种写法：规范「标题（#票号）」、存量「[标题](链接)」、裸「#票号」。
 * 一条都认不出时返回 null，调用方据此跳过——小节里可能有分隔线或说明文字，不该因此整段失败。
 */
function parseEntry(rawItem: string): BlockedByEntry | null {
  const item = String(rawItem || '').trim()
  if (!item) return null
  const keyed = KEYED_ENTRY.exec(item)
  if (keyed) return { key: keyed[2].trim(), title: keyed[1].trim() }
  const link = LINK_ENTRY.exec(item)
  if (link) {
    const key = keyFromLink(link[2])
    if (!key) return null
    return { key: key, title: String(link[1] || '').trim() }
  }
  const bare = BARE_ENTRY.exec(item)
  if (bare) return { key: bare[1].trim(), title: '' }
  return null
}

/**
 * 读出正文里 `## Blocked by` 小节的全部条目，按票号去重、保持出现顺序。
 * 同一张票在小节里写了两遍时只算一条：判据是票号，重复的那行没有额外信息。
 */
export function blockedByEntriesFromBody(body: string): BlockedByEntry[] {
  const lines = String(body || '').split(/\r?\n/)
  const entries: BlockedByEntry[] = []
  const seen = new Set<string>()
  let inSection = false
  for (const line of lines) {
    if (isAnyHeading(line)) {
      inSection = isSectionHeading(line)
      continue
    }
    if (!inSection) continue
    const item = LIST_ITEM.exec(line)
    if (!item) continue
    const entry = parseEntry(item[1])
    if (!entry || seen.has(entry.key)) continue
    seen.add(entry.key)
    entries.push(entry)
  }
  return entries
}

/** 只要票号时用这个：判据点、环检、写后读回核对都只需要票号。 */
export function blockedByKeysFromBody(body: string): string[] {
  return blockedByEntriesFromBody(body).map((entry) => entry.key)
}

/** 标题里出现换行会把一条关系拆成两行，写之前压成一行；空标题时只写票号。 */
function lineOfEntry(entry: BlockedByEntry): string {
  const title = String(entry.title || '').replace(/\s+/g, ' ').trim()
  return title ? '- ' + title + '（#' + entry.key + '）' : '- #' + entry.key
}

/**
 * 把阻塞小节整段换成给定条目，其余正文原样保留。
 *
 * 三条不能改的行为：
 * 1. 先删掉已有的整个小节（标题行到下一个标题行之前），否则重复写会出现两个小节、读侧只认第一个；
 * 2. 正文尾部空行先去掉，再空一行接小节——不然反复写会让票面末尾的空行越积越多；
 * 3. entries 为空时只删不加：取消全部阻塞关系就是这个意思，不需要留一个空标题。
 */
export function withBlockedBySection(body: string, entries: BlockedByEntry[]): string {
  // 同一张票写两遍没有额外信息，反而会让读侧与写后核对各看一份：按票号去重，保留第一次出现的顺序。
  const unique: BlockedByEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries || []) {
    const key = String(entry && entry.key ? entry.key : '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push({ key: key, title: String(entry.title || '') })
  }
  const lines = String(body || '').split(/\r?\n/)
  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!isSectionHeading(lines[i])) {
      kept.push(lines[i])
      continue
    }
    i += 1
    while (i < lines.length && !isAnyHeading(lines[i])) i += 1
    // 命中的那一行属于下一个小节，交给外层循环重新判断。
    i -= 1
  }
  while (kept.length > 0 && !kept[kept.length - 1].trim()) kept.pop()
  const base = kept.join('\n')
  if (unique.length === 0) return base
  const section = BLOCKED_BY_HEADING + '\n' + unique.map(lineOfEntry).join('\n')
  return base ? base + '\n\n' + section : section
}

export default {
  BLOCKED_BY_HEADING,
  blockedByEntriesFromBody,
  blockedByKeysFromBody,
  withBlockedBySection,
}
