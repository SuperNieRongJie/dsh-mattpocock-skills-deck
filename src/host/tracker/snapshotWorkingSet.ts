// src/host/tracker/snapshotWorkingSet.ts —— 首屏工作集：开放池 + 开放地图子票 + 已关闭地图容器行（#1796）
//
// 为什么单开这一个文件：composeSnapshot 原来只拿一趟「开放票与已关闭票混排、按更新时间倒序、500 条封顶」
// 的列表当首屏，编号靠后的未关闭票会被大量已关闭票挤出窗口（#1796 的现场：30 张未关闭票里有 8 张
// 排在第 776～1282 名，根本进不来）。修法是把首屏改成四份来源的并集：
//   1) 开放工作集：list({state:'open'}) 由后端先筛状态，未关闭票不再和已关闭历史挤同一个窗口；
//   2) 开放容器的子票：开放工作集只装得下开放票，已关闭的子票要靠 listSubIssues 逐张开放容器拉全，
//      地图详情才数得清「共 N 张」（#1796 code review 补：规格容器同理 —— 它的实施票做完了就关，
//      不补回来会让做完了的规格看着一张子票都没有）；
//   3) 已关闭地图的容器行：开放工作集里没有它们，热启动沿用上一份快照里的容器行，冷启动补一页薄行，
//      列表页签上的容器行才不会凭空消失；
//   4) 远端关掉的票（#9）：一张票在远端关掉以后就不再进开放工作集，若没人记着它，它会只从列表上
//      消失 —— 既进不了「已关闭」也进不了「全部」。所以上一份快照里有、这一趟并集里没有的顶票，
//      在这里按已关闭补回来（只读上一份快照，不再向远端要一次）。
//   前三件与第四件在首屏都只读、不再向远端要关闭票；刷新那一轮例外：它多要一页「已关闭」票
//   （#12），把「从没进过开放池」的关闭票也补进快照库，顶部的「已关闭 N」才与库里实际票数一致。
// 这几件事都只读后端、只回事实；组装、计数与 partial 判定仍留在 composeSnapshot（本文件不写 deck，
// 也不碰缓存与版号），所以它没有第二个读者，边界清楚。
//
// 什么约定不能改：
//   1. 失败只跳过不抛：某张地图的子票拉不到，其余来源照常返回；失败与不完整的次数如实交给调用方记日志、
//      判「这一份来源全不全」。
//   2. 不猜数：listSubIssues 回 unsupported（确实不提供子票的后端）既不算失败也不造假行；没有 listPage 的
//      后端只是补不出已关闭容器行，不做任何替代。
//   3. 行身份用 (effortId, key) 这一对（tracker/kernel 的 idOfParts）：同一张票只出现一次；同一张票在
//      开放池里已有、子票里也回来时以池里那份为准，只补它缺的 parentKey。
//   4. 向 listSubIssues 点名容器所属的工作单元：本地 Markdown 后端的容器编号在每个工作单元里都是
//      00，只传编号分不清是哪一张地图/规格（#1826）。范围放进仓库引用的 effortId 里，且克隆一份
//      引用再传，不改调用方手里那份；其它后端忽略这个字段。
//   5. 已关闭地图容器行是薄行：显式给 body:''，让组装层的正文解析不依赖「这一行有没有正文」。
//   6. 相对导入保留 .js 后缀（构建后由 scripts/ts-hook.mts 改指同名 .ts，本文件不改说明符）。

import { effortOf, idOfParts } from '../../tracker/kernel/identity-keys.js'
import { ERROR_KIND } from '../../tracker/contract/vocabulary.js'

// 类型只做编译期约束，不产生运行时引用。
import type { RepositoryRef } from '../../shared/tracker/shape.js'

/** 冷启动补已关闭地图容器行时一页要多少张：与规格 §6.3「最近 100 条」同一个数，不多取。 */
const CLOSED_MAP_PAGE_LIMIT = 100
/**
 * 刷新轮补关闭池时一页要多少张（#12）：与后端翻页上限同一个数（各后端自己再钳一次）。
 *
 * 为什么要有这个上限：关闭票在 Gitee 这类后端上可能成千上万张，刷新是每轮都跑的定时动作，
 * 不能把整仓关闭票都拉回来。一页就够把「最近关掉的、从没进过开放池的票」补进快照库，
 * 剩下一轮一轮往下补；每轮只发这一次请求，次数写进日志可数。
 */
const CLOSED_POOL_PAGE_LIMIT = 100
/** 探索地图的标签（小写真源；listPage 的标签筛选按契约原样下推）。 */
const MAP_LABEL = 'wayfinder:map'

/** 组装首屏工作集的入参：门面、仓库、上下文、开放池，以及两份「上一次/这一次已有」的容器行。 */
export interface WorkingSetInput {
  /** 取数门面（composeSnapshot 给的 trackerFor；可能缺 listPage / listSubIssues，本文件按缺席处理）。 */
  tracker: any
  ref: RepositoryRef
  ctx?: any
  /** 这一趟 list({state:'open'}) 拿回来的开放工作集（原样，不在这里改）。 */
  pool: any[]
  /** 用 pool 先组装一遍得到的容器行（composeSnapshot 把 assembleSnapshot(ref, pool).maps 交进来）。 */
  openContainers?: any[]
  /** 上一份快照的 maps：热启动时从这里取已关闭地图容器行。 */
  previousMaps?: any[]
  /**
   * 上一份快照的整份内容（组装过的那份）：用来补「上一趟还看得见、这一趟开放池里没有」的票行（#9）。
   * 传 null 或省略表示没有上一份快照，这一类行一张都不补。
   */
  previousSnapshot?: any
  /**
   * 这一趟开放池这份来源全不全（列表没被截断、没掉到 REST 降级）。
   * 缺省按「全」处理；显式给 false 时本文件一张都不补 —— 来源不全时缺行说明不了票已关闭。
   */
  openListComplete?: boolean
  /**
   * 刷新轮才开（#12）：从远端补一页已关闭票，让「从没进过开放池」的关闭票也进快照库。
   *
   * 首屏一律不传：首屏取数次数被票 #9 的验收锁死（只有 list 一次 + 已关闭容器行那一页），
   * 这里多要一页就是多一次远端调用。只在刷新那一轮由 composeSnapshot 打开。
   */
  closedPool?: boolean
}

/** 组装结果：并集行 + 这一趟向远端多要了几次、失败了几个、已关闭容器行从哪来。 */
export interface WorkingSetResult {
  /** 组装层要吃的行：开放池 + 开放容器子票 + 已关闭地图容器薄行（已按身份去重）。 */
  rows: any[]
  /** 这一趟拉过子票的开放容器张数（探索地图与规格都算：两类容器的子票都是实施票）。 */
  openContainers: number
  /** 子票行一共拉回多少张（失败的地图不计）。 */
  subIssues: number
  /** 子票拉取硬失败的地图张数（unsupported 不计；>0 表示这一份来源不全）。 */
  subIssuesFailed: number
  /** 子票撞到上限或与后端总数对不上的地图张数（>0 表示子票不全，但开放工作集本身没缺）。 */
  subIssuesIncomplete: number
  /**
   * 子票拉取硬失败的容器清单，形如 `641:transport;1588:unknown`（票号 + 错误档，缺档记 unknown）；
   * 空串表示没有失败。只记编号与错误档：日志纪律要求这类行状态只记编号与计数，不记正文与远端原文。
   */
  failed: string
  /** 补回来的已关闭地图容器行张数。 */
  closedMapRows: number
  /** 已关闭地图容器行从哪来：上一份快照 / 冷启动补的一页 / 没有。 */
  closedMapSource: 'previous' | 'page' | 'none'
  /**
   * 按「上一份快照里有、这一趟并集里没有」补回来的已关闭票行张数（普通票与容器行都算，#9）。
   * 这张数进常驻日志：事后要分得清「这张票为什么出现在已关闭里」是补回来的还是后端真回了它。
   */
  carriedClosedRows: number
  /** 这一趟真的向远端发了几次关闭池查询（0 或 1；只有刷新轮才可能是 1）。 */
  closedPoolQueries: number
  /** 关闭池那一页回了多少张（失败时为 0）。 */
  closedPoolRows: number
  /** 关闭池那一页里真的补进并集的张数（已有、拉取请求、容器下的子票都不算）。 */
  closedPoolAdded: number
  /**
   * 关闭池查询的失败档（空串表示没失败或没发）：错误档原样，异常记 thrown。
   * 只记档名不记远端原文 —— 日志纪律要求这类行说清「哪一步、什么档」，不带正文。
   */
  closedPoolError: string
}

/** 这一行的票号：key 优先，number 兜底；两个都没有时回空串（组装层会把它当没有编号的行丢掉）。 */
function keyOfRow(row: any): string {
  try {
    if (!row) return ''
    const k: any = row.key !== undefined && row.key !== null && row.key !== '' ? row.key : row.number
    return k === undefined || k === null ? '' : String(k)
  } catch (e) {
    return ''
  }
}

/** 行身份：与组装层同一把尺子 (effortId, key)。 */
function rowIdOf(row: any): string {
  return idOfParts(effortOf(row), keyOfRow(row))
}

/** 是不是已关闭（大小写无关，缺状态按未关闭处理——与组装层 isClosedRow 同口径）。 */
function isClosedRow(row: any): boolean {
  try {
    return String((row && row.state) || '').toUpperCase() === 'CLOSED'
  } catch (e) {
    return false
  }
}

/** 编号归一：已有 number 原样用；没有时按数字 key 折成数字，折不动就省略（薄行只需要 key 可读）。 */
function numberOfRow(row: any): number | null {
  try {
    if (row && typeof row.number === 'number' && isFinite(row.number)) return row.number
    const k: string = keyOfRow(row)
    if (/^[0-9]+$/.test(k)) {
      const n = parseInt(k, 10)
      if (!isNaN(n)) return n
    }
  } catch (e) {
    /* 拿不到就当没有 */
  }
  return null
}

/**
 * 把一条子票并进并集：缺 parentKey 的补上所属地图、缺 effortId 的补上容器的工作单元标识，
 * 然后按身份去重；池里已有同一张票时只补它缺的 parentKey，不拿子票行覆盖池里的完整行。
 */
function mergeTicketRow(rows: any[], seen: Record<string, number>, item: any, map: any): void {
  if (!item || typeof item !== 'object') return
  const key: string = keyOfRow(item)
  if (!key) return
  const row: any = Object.assign({}, item)
  row.key = key
  const mapKey: string = keyOfRow(map)
  if ((row.parentKey === undefined || row.parentKey === null || row.parentKey === '') && mapKey) row.parentKey = mapKey
  const mapEffort: string = effortOf(map)
  if ((row.effortId === undefined || row.effortId === null || row.effortId === '') && mapEffort) row.effortId = mapEffort
  const id: string = rowIdOf(row)
  const at: number = seen[id] || 0
  if (at > 0) {
    const existing: any = rows[at - 1]
    if (existing && (existing.parentKey === undefined || existing.parentKey === null || existing.parentKey === '') && row.parentKey) {
      existing.parentKey = row.parentKey
    }
    return
  }
  seen[id] = rows.length + 1
  rows.push(row)
}

/** 已关闭地图容器行：只带列表画一行所需的事实，正文显式给空串（薄行，不冒充详情）。 */
function thinClosedMapRow(row: any): any {
  const out: any = {}
  out.key = keyOfRow(row)
  const n = numberOfRow(row)
  if (n !== null) out.number = n
  out.effortId = effortOf(row)
  out.type = 'map'
  out.state = 'CLOSED'
  out.title = String(row && row.title !== undefined && row.title !== null ? row.title : '')
  out.body = ''
  out.isPullRequest = false
  return out
}

/** 把已关闭容器行并进并集：同一身份只收一次，返回真的并进去几张。 */
function appendClosedRows(rows: any[], seen: Record<string, number>, list: any[]): number {
  let added = 0
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    if (m.type !== 'map' || !isClosedRow(m)) continue
    const row: any = thinClosedMapRow(m)
    if (!row.key) continue
    const id: string = rowIdOf(row)
    if (seen[id]) continue
    seen[id] = rows.length + 1
    rows.push(row)
    added++
  }
  return added
}

/**
 * 上一份快照里可能压着「上一趟还看得见的票」的两处地方：maps（容器行）与 issues（没挂容器的普通票）。
 * 为什么容器行也要看：容器上一趟还开着、这一趟在远端关掉了，开放池里没有它，而已关闭容器行那条来源
 * 只收「上一趟就已经关闭」的行 —— 不在这里补，整行会消失。
 */
function previousRowsOf(previousSnapshot: any): any[] {
  const out: any[] = []
  try {
    const snap: any = previousSnapshot || {}
    if (Array.isArray(snap.maps)) for (const m of snap.maps) out.push(m)
    if (Array.isArray(snap.issues)) for (const r of snap.issues) out.push(r)
  } catch (e) {
    return []
  }
  return out
}

/**
 * 补回来的关闭票薄行：只带列表画一行所需的事实（票号、类型、标题、链接、标签、更新时间），
 * 状态一律写成已关闭，正文显式给空串 —— 与已关闭地图容器薄行同一套约定，薄行不冒充详情。
 */
function thinCarriedRow(row: any): any {
  const out: any = {}
  out.key = keyOfRow(row)
  const n = numberOfRow(row)
  if (n !== null) out.number = n
  out.effortId = effortOf(row)
  const type: string = row && typeof row.type === 'string' ? row.type : ''
  out.type = type === 'map' || type === 'spec' ? type : 'issue'
  out.state = 'CLOSED'
  out.title = String(row && row.title !== undefined && row.title !== null ? row.title : '')
  if (row && typeof row.url === 'string' && row.url) out.url = row.url
  if (row && Array.isArray(row.labels)) out.labels = row.labels.slice()
  if (row && typeof row.updatedAt === 'string' && row.updatedAt) out.updatedAt = row.updatedAt
  out.body = ''
  out.isPullRequest = false
  return out
}

/**
 * #9：把「上一份快照里有、这一趟并集里没有」的票按已关闭补进并集，返回真的补进去几张。
 *
 * 为什么这条规则成立：一张票在远端被关掉以后，开放工作集（list({state:'open'})）里就没有它了；
 * 已关闭票这一趟没人去要（首屏不新增查询），唯一还记着它的地方就是上一份快照。
 * 三条不补的边界：
 *   1. 拉取请求不补：合并/关闭的拉取请求有自己的增量抓取与页签，不归这张票管；
 *   2. 挂在容器下面的子票不补：容器关掉以后后端本来就不提供它的子票（#691），缺行证明不了这张票关了；
 *   3. 已经在并集里的不补：按 (effortId, key) 身份去重，同一张票只出现一行。
 */
function appendCarriedClosedRows(rows: any[], seen: Record<string, number>, previousSnapshot: any): number {
  let added = 0
  for (const prev of previousRowsOf(previousSnapshot)) {
    if (!prev || typeof prev !== 'object') continue
    if (prev.isPullRequest === true) continue
    const parentKey: any = prev.parentKey
    if (parentKey !== undefined && parentKey !== null && parentKey !== '') continue
    const row: any = thinCarriedRow(prev)
    if (!row.key) continue
    const id: string = rowIdOf(row)
    if (seen[id]) continue
    seen[id] = rows.length + 1
    rows.push(row)
    added++
  }
  return added
}

/**
 * 把关闭池那一页里的票按已关闭补进并集，返回真的补进去几张（#12）。
 *
 * 为什么不复用 appendClosedRows：那一条只收 type==='map' 的容器行（#9 补的是地图这一档），
 * 关闭池要补的是「所有没在开放池里出现过的已关闭票」，规格、实施票、普通票都算。
 * 三条不补的边界与 appendCarriedClosedRows 相同：
 *   1. 拉取请求不补：它不是工单，快照库的计数口径也不数它（counts.ts 的 is_pull_request 过滤）；
 *   2. 挂在容器下面的子票不补：容器关掉以后后端不提供它的子票（#691），一页里混进来的子票
 *      在组装层找不到父容器，补进来只会在库里留一行界面画不出来的孤儿行；
 *   3. 已经在并集里的不补：按 (effortId, key) 身份去重，同一张票只出现一行。
 * 只收 state 确实是 CLOSED 的行：关闭池这条查询理论上只回关闭票，但「状态没解析出来」的行
 * 不能当成关闭票写进库，否则顶部的「已关闭 N」会多于实际。
 */
function appendClosedPoolRows(rows: any[], seen: Record<string, number>, list: any[]): number {
  let added = 0
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (!isClosedRow(item)) continue
    if (item.isPullRequest === true) continue
    const parentKey: any = item.parentKey
    if (parentKey !== undefined && parentKey !== null && parentKey !== '') continue
    const row: any = thinCarriedRow(item)
    if (!row.key) continue
    const id: string = rowIdOf(row)
    if (seen[id]) continue
    seen[id] = rows.length + 1
    rows.push(row)
    added++
  }
  return added
}

/** 关闭池查询的失败档：异常与空回包也要能分辨，不能都记成 unknown。 */
function closedPoolFailureKind(res: any): string {
  if (!res) return 'thrown'
  const kind: any = res.error ? res.error.kind : null
  return typeof kind === 'string' && kind ? kind : 'unknown'
}

/**
 * 组装首屏工作集（纯装配 + 只读远端）。
 *
 * 进：开放池（list({state:'open'}) 的原样行）、用开放池先组装出来的容器行、上一份快照（容器行与整份票行）。
 * 出：组装层要吃的并集行，以及「这一趟子票拉了几张、坏在哪几张、已关闭容器行从哪来」的事实；
 *   这些事实由 composeSnapshot 记进常驻日志 snapshot.workingSet（附录 #149），所以本文件的返回字段都有读者。
 * 异常策略：远端失败只跳过不抛（快照这条路可用性优先）；调不通的失败数交给调用方决定 partial 与日志。
 */
export async function assembleWorkingSet(input: WorkingSetInput): Promise<WorkingSetResult> {
  const args: any = input || {}
  const tracker: any = args.tracker || null
  const ref: RepositoryRef = args.ref
  const ctx: any = args.ctx || {}
  const pool: any[] = Array.isArray(args.pool) ? args.pool : []
  const containers: any[] = Array.isArray(args.openContainers) ? args.openContainers : []
  const previousMaps: any[] = Array.isArray(args.previousMaps) ? args.previousMaps : []

  // 池里的行先拷一份：本文件只往并集上加行，不改调用方手里的列表。
  const rows: any[] = pool.map(function (r: any) { return r && typeof r === 'object' ? Object.assign({}, r) : r })
  const seen: Record<string, number> = {}
  for (let i = 0; i < rows.length; i++) {
    const id: string = rowIdOf(rows[i])
    if (id && !seen[id]) seen[id] = i + 1
  }

  let openContainers = 0
  let subIssues = 0
  let subIssuesFailed = 0
  let subIssuesIncomplete = 0
  // 失败清单要能说出「哪张容器、什么错误档」：只记编号与错误档，不记远端原文（日志纪律）。
  const failedContainers: string[] = []

  // 拉探索地图与规格两类容器的子票：两类容器的子票都是「做完了就关」的实施票，已关闭的那部分不再进首屏
  //   （#1796 首屏只装开放票），只能靠这一趟补回来 —— 不补的话，做完了的规格会显示成一张子票都没有。
  //   只补开放容器：已关闭容器的子票按 #691 的边界不抓。
  const openContainerRows: any[] = containers.filter(function (m: any) { return m && (m.type === 'map' || m.type === 'spec') && !isClosedRow(m) })
  const canFetch = !!(tracker && typeof tracker.listSubIssues === 'function')
  if (canFetch) {
    for (const container of openContainerRows) {
      const containerKey: string = keyOfRow(container)
      if (!containerKey) continue
      openContainers++
      let res: any = null
      try {
        // #1826：容器编号在本地 Markdown 后端里每个工作单元都是 00，把这一行容器的工作单元一起放进
        //   仓库引用，后端才分得清是哪一个 00 号容器（克隆引用，不改调用方手里那一份）。
        const containerEffort: string = effortOf(container)
        const scopedRef: any = containerEffort ? Object.assign({}, ref, { effortId: containerEffort }) : ref
        res = await tracker.listSubIssues(scopedRef, containerKey, {}, ctx)
      } catch (e) {
        res = null
      }
      if (!res || res.ok !== true) {
        const kind: any = res && res.error ? res.error.kind : null
        // unsupported 是「这个后端不提供子票」，不是故障：不算失败、不报警，只是这一类行补不出来。
        if (kind !== ERROR_KIND.UNSUPPORTED) {
          subIssuesFailed++
          failedContainers.push(containerKey + ':' + (typeof kind === 'string' && kind ? kind : 'unknown'))
        }
        continue
      }
      const data: any = res.data || {}
      const items: any[] = Array.isArray(data.items) ? data.items : []
      subIssues += items.length
      if (data.capped === true || (typeof data.missing === 'number' && data.missing > 0)) subIssuesIncomplete++
      for (const item of items) mergeTicketRow(rows, seen, item, container)
    }
  }

  // 已关闭地图容器行：热启动先看上一份快照（不用再问远端），没有才冷启动补一页薄行。
  let closedMapRows = appendClosedRows(rows, seen, previousMaps)
  let closedMapSource: 'previous' | 'page' | 'none' = closedMapRows > 0 ? 'previous' : 'none'
  if (closedMapRows === 0 && tracker && typeof tracker.listPage === 'function') {
    let page: any = null
    try {
      page = await tracker.listPage(ref, { state: 'closed', labels: [MAP_LABEL] }, { limit: CLOSED_MAP_PAGE_LIMIT }, ctx)
    } catch (e) {
      page = null
    }
    if (page && page.ok === true) {
      const items: any[] = page.data && Array.isArray(page.data.items) ? page.data.items : []
      closedMapRows = appendClosedRows(rows, seen, items)
      if (closedMapRows > 0) closedMapSource = 'page'
    }
  }

  // #9：远端把票关掉以后，它不再进开放池 —— 只从列表上消失，既进不了「已关闭」也进不了「全部」。
  //   这里把上一份快照里有、这一趟并集里没有的顶票按已关闭补回来，不发任何远端请求（首屏取数次数不变）。
  //   只在开放池这份来源完整时补：列表被截断或降级时，缺行可能只是这一趟没取到，不能当成关闭。
  const carriedClosedRows: number = args.openListComplete === false
    ? 0
    : appendCarriedClosedRows(rows, seen, args.previousSnapshot)

  // #12：刷新轮再补一页「已关闭」票。上面那条补回规则只能补「上一份快照里见过」的票；
  //   一张建好就关、或本机从来没同步到过它的票，上一份快照里也没有，顶部的「已关闭 N」
  //   就会一直小于库里实际关闭票数。这一页是唯一的关闭票来源，所以只在刷新轮打开。
  //   代价有界：每轮最多一次 listPage，回包条数受 CLOSED_POOL_PAGE_LIMIT 与后端页大小双重限制；
  //   发起次数、回包条数、补入条数、失败档都交给 composeSnapshot 记进 snapshot.workingSet。
  let closedPoolQueries = 0
  let closedPoolRows = 0
  let closedPoolAdded = 0
  let closedPoolError = ''
  if (args.closedPool === true && tracker && typeof tracker.listPage === 'function') {
    closedPoolQueries++
    let page: any = null
    try {
      page = await tracker.listPage(ref, { state: 'closed' }, { limit: CLOSED_POOL_PAGE_LIMIT }, ctx)
    } catch (e) {
      page = null
    }
    if (page && page.ok === true) {
      const items: any[] = page.data && Array.isArray(page.data.items) ? page.data.items : []
      closedPoolRows = items.length
      closedPoolAdded = appendClosedPoolRows(rows, seen, items)
    } else {
      closedPoolError = closedPoolFailureKind(page)
    }
  }

  return {
    rows,
    openContainers,
    subIssues,
    subIssuesFailed,
    subIssuesIncomplete,
    failed: failedContainers.join(';'),
    closedMapRows,
    closedMapSource,
    carriedClosedRows,
    closedPoolQueries,
    closedPoolRows,
    closedPoolAdded,
    closedPoolError,
  }
}
