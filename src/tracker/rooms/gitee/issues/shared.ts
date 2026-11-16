/**
 * src/tracker/rooms/gitee/issues/shared.ts —— 列票与读票共用的查询串拼装
 *
 * Gitee 的票状态是四态，契约是两态，而列表接口的 state 参数一次只收一个值。
 * 所以「开」要分两趟问（open、progressing），「关」也要分两趟（closed、rejected），
 * 否则就会把 progressing 或 rejected 的票漏在列表外，用户看到的数字与远端对不上。
 *
 * 为什么要拼查询串而不是用对象：CLI 没有独立的查询参数开关，查询串必须并进路径，
 * 所以这里产出的是「已经拼好的查询串」，requests.ts 原样接过去。
 */
export const PAGE_SIZE = 100

/** 单趟最多翻多少页；撞上就按「没取全」处理，绝不把残页当全量。 */
export const LIST_MAX_PAGES = 20

/** 契约两态映射成远端的两个状态值；顺序固定，日志与测试都靠它。 */
export function remoteStatesOf(state: string | undefined): string[] {
  if (state === 'closed') return ['closed', 'rejected']
  if (state === 'open') return ['open', 'progressing']
  return []
}

export function labelsOf(labels: unknown): string {
  if (!Array.isArray(labels)) return ''
  const out: string[] = []
  for (const item of labels) {
    const name = typeof item === 'string' ? item : item && typeof item === 'object' ? String((item as { name?: unknown }).name || '') : ''
    const trimmed = name.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out.join(',')
}

export interface ListQueryParts {
  state?: string
  labels?: string
  since?: string
  page: number
}

/** 拼一页的查询串；per_page 固定 100（接口上限），少写了会把「满页」判错。 */
export function buildListQuery(parts: ListQueryParts): string {
  const params: string[] = ['per_page=' + PAGE_SIZE, 'page=' + String(parts.page), 'sort=updated_at', 'direction=desc']
  if (parts.state) params.push('state=' + encodeURIComponent(parts.state))
  if (parts.labels) params.push('labels=' + encodeURIComponent(parts.labels))
  if (parts.since) params.push('since=' + encodeURIComponent(parts.since))
  return params.join('&')
}

/** 回包是不是数组；不是数组时调用方要如实失败，不能当空列表。 */
export function asRows(raw: unknown): unknown[] | null {
  return Array.isArray(raw) ? raw : null
}

export function isBag(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
}
