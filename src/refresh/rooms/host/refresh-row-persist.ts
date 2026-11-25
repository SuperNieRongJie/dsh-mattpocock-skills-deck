// src/refresh/rooms/host/refresh-row-persist.ts —— 一趟刷新收集到的票行，整批写进本地快照库，并交回「写完之后库是第几版」。
// 门禁归属: src/refresh/rooms/host
//
// 为什么这件事单独成文件：它有两个下游读者。界面侧要「写进去的那一版」（客户端按库版本决定列表复不复用旧画面），
// 库层要知道「这一趟从哪一版接着写」（并发写同一工作区时靠它续号）。两者口径不同，却必须一起看才能说清楚，
// 所以整段写库逻辑（成功/降级/失败三档）住在一处，调用方只拿一个返回值。
//
// 返回值的含义只有两种：
//   - 非负整数：这一趟写库成功，这就是写完之后库的版本号。0 是合法版本，不能被当成「没有」。
//   - null：这一趟没有可报的库版本。不是写失败，而是三种「这趟本来就不该落库」：没行可写、库口没接、
//     库层自己降级（只读 / 开不出库 / 旧租约挡住本地写）。此时调用方退回它原先的口径（记发请求之前读到的那一版）。
// 真正的写失败仍然抛错：宁可让用户看到一次失败，也不能让界面显示一份重启后会消失的数据。
//
// 降级为什么不抛错：只读、开不出、旧租约这三种都不是「写了一半」，数据已经在内存里组装好了，照常交给界面只是不落库。
// 其中 legacy-writer（#1932）最容易被误伤——本地库里还有一条未过期的旧租约，说明可能还有旧版本窗口在写这个工作区，
// 这时拒绝本地写是对的，但让整趟刷新失败就错了：用户每按一次刷新都会弹一条红色失败提示，而提示里没有一句说得出
// 「重启所有窗口」这件事。反例就按这个判：把 legacy-writer 当普通写失败抛错，升级现场会整片见红。

/** 写库入参：行、身份、以及可选的续号起点。字段名与快照库 recordIssueRows 的入参一一对应。 */
export type PersistRefreshRowsOptions = {
  /** 这一趟收集到的票行；写完会被清空（调用方靠这一点保证同一批行不会被写第二遍）。 */
  rows: unknown[]
  /** 工作区根目录（快照库按它分桶）。 */
  workspaceRoot: string
  /** 后端 id（github / gitee / gitlab / markdown …）。 */
  backend: string
  /** 仓库身份；空串是允许的（库层按工作区兜底）。 */
  repoIdentity: string
  /** 上一份快照的版本号：交给库层续号用，避免并发写同一工作区时版本号回落。没有上一份就不传。 */
  startMergeVersion?: number
  /** 开库的口；没接就没有本地库，这一趟直接不落库。 */
  getSnapshotLibrary?: (() => Promise<unknown> | unknown) | null
}

/**
 * 把这一趟的行整批写进本地快照库，回「写完之后库是第几版」；没有可报的版本时回 null（见文件头三档说明）。
 *
 * 只认非负整数版本：库层给的 mergeVersion 是浮点、负数、字符串都按「库层没给版本」处理，回 null 而不是硬转，
 * 免得把一个不可信的数记进客户端的版本簿（那会让列表按一个不存在的版本复用旧画面）。
 */
export async function persistRefreshRows(options: PersistRefreshRowsOptions): Promise<number | null> {
  const rows = Array.isArray(options && options.rows) ? options.rows : []
  const openLibrary = options && options.getSnapshotLibrary
  if (!rows.length || typeof openLibrary !== 'function') return null
  // 先把行从收集数组里摘出来：后面无论成功、降级还是抛错，这一批都不会被下一次写库重复带走。
  const pending = rows.splice(0, rows.length)
  let lib: any = null
  try { lib = await Promise.resolve(openLibrary()) } catch (e) { lib = null }
  if (!lib || typeof lib.recordIssueRows !== 'function') return null
  const payload: any = {
    workspaceRoot: options.workspaceRoot,
    backend: String(options.backend),
    repoIdentity: String(options.repoIdentity || ''),
    rows: pending,
    atomic: true,
  }
  if (options.startMergeVersion !== undefined) payload.startMergeVersion = options.startMergeVersion
  const result: any = await lib.recordIssueRows(payload)
  if (result && result.ok === true) {
    const merged = result.mergeVersion
    return (typeof merged === 'number' && Number.isInteger(merged) && merged >= 0) ? merged : null
  }
  const reason = String((result && result.reason) || 'unknown')
  // 三种已知降级（只读 / 开不出库 / 旧租约挡住本地写）不落库但不算失败，理由见文件头。
  if (reason === 'readonly' || reason === 'unavailable' || reason === 'legacy-writer') return null
  throw new Error('这轮刷新没写进本地快照库（' + reason + '），为避免重启后回到旧数据，这次刷新按失败处理。')
}
