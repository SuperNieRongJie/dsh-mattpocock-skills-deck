/**
 * src/tracker/rooms/gitee/issues/counts.ts —— 数票：开多少、关多少
 *
 * Gitee 没有票统计端点（swagger 里 issues 只有列表、详情、评论、建、改），所以只能翻页数。
 * 这不是理想做法，但它是唯一能给出真数的方法；因此这里把「数不全」当成失败：
 * 翻到页数上限还没到底，就整体 fail，绝不把已经数到的部分当答案交出去。
 *
 * 契约两态各对应两个远端状态（open+progressing / closed+rejected），
 * 所以每一档都要把两个状态各数一遍，否则 rejected 的票会被漏掉。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { ListFilter } from '../../../contract/inputs.js'
import type { CountsResult } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { GITEE_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestIssueList } from '../requests.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { PAGE_SIZE, asRows, buildListQuery, labelsOf, remoteStatesOf } from './shared.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

/** 单档最多翻多少页；100 条一页、50 页就是 5000 张票，够用且能保证结果不会无限期挂着。 */
const COUNT_MAX_PAGES = PAGINATION.gitee.countMaxPages

type CountOutcome = { ok: true; count: number } | { ok: false; error: CountsResult }

/**
 * 数一个契约档（open 或 closed）对应的两个远端状态。
 *
 * 每次请求都用同一份 labels/since 过滤，保证「数出来的」与「列表看到的」是同一批票。
 */
async function countBucket(
  opCtx: GiteeCtx,
  refId: string,
  state: 'open' | 'closed',
  filter: ListFilter,
  logCtx: OpContext,
  startedAt: number,
): Promise<CountOutcome> {
  let total = 0
  for (const remoteState of remoteStatesOf(state)) {
    for (let page = 1; page <= COUNT_MAX_PAGES; page += 1) {
      const res = await requestIssueList(
        opCtx,
        refId,
        buildListQuery({ state: remoteState, labels: labelsOf(filter.labels), since: filter.since, page }),
        GITEE_SLOW_READ_TIMEOUT_MS,
      )
      if (res.code !== 0) {
        emitReadDegraded(logCtx, 'counts', 'counts:transport', Date.now() - startedAt)
        return { ok: false, error: failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'counts: 数票失败', res, opCtx) }
      }
      const rows = asRows(parseJsonSafe(res.stdout))
      if (!rows) {
        emitReadDegraded(logCtx, 'counts', 'counts:json', Date.now() - startedAt)
        return { ok: false, error: failGitee(res, 'counts: 回包不是 JSON 数组', res, opCtx) }
      }
      total += rows.length
      if (rows.length < PAGE_SIZE) break
      if (page === COUNT_MAX_PAGES) {
        emitReadDegraded(logCtx, 'counts', 'counts:cap', Date.now() - startedAt)
        return {
          ok: false,
          error: failGitee(
            res,
            'counts: 翻到 ' + String(COUNT_MAX_PAGES * PAGE_SIZE) + ' 张票还没数完，拒绝拿残数当答案',
            res,
            opCtx,
          ),
        }
      }
    }
  }
  return { ok: true, count: total }
}

export async function counts(
  ctx: GiteeCtx,
  repo: Repo,
  filter: ListFilter | undefined,
  opCtx?: GiteeCtx,
): Promise<CountsResult> {
  const effective = opCtx || ctx
  const logCtx = effective as OpContext
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(logCtx, 'counts', 'counts:repo-ref', Date.now() - startedAt)
    return failGitee('repo.refId missing', 'counts: repo.refId missing', '')
  }
  const f: ListFilter = filter || {}
  // 类型没有可用的远端筛选参数；按类型数出来的数只能是假的，所以如实说做不到。
  if (f.type) {
    emitReadDegraded(logCtx, 'counts', 'counts:shape', Date.now() - startedAt)
    return failGitee(
      'type filter unsupported',
      'counts: Gitee 的票接口没有按类型筛选的参数，给不出按类型的计数（拒绝数一个不分类的总数冒充）',
      String(f.type),
    )
  }
  try {
    if (f.state === 'open') {
      const open = await countBucket(effective, refId, 'open', f, logCtx, startedAt)
      if (!open.ok) return open.error
      return { ok: true, data: { open: open.count, closed: 0, total: open.count } }
    }
    if (f.state === 'closed') {
      const closed = await countBucket(effective, refId, 'closed', f, logCtx, startedAt)
      if (!closed.ok) return closed.error
      return { ok: true, data: { open: 0, closed: closed.count, total: closed.count } }
    }
    const open = await countBucket(effective, refId, 'open', f, logCtx, startedAt)
    if (!open.ok) return open.error
    const closed = await countBucket(effective, refId, 'closed', f, logCtx, startedAt)
    if (!closed.ok) return closed.error
    return { ok: true, data: { open: open.count, closed: closed.count, total: open.count + closed.count } }
  } catch (err) {
    emitReadDegraded(logCtx, 'counts', 'counts:transport', Date.now() - startedAt)
    return failGitee(err, 'counts: 数票调用失败', err, effective)
  }
}

export default counts
