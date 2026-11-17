/**
 * src/tracker/rooms/gitee/issues/pages.ts —— 单页读票（游标是页码字符串）
 *
 * 为什么游标是页码而不是远端 token：Gitee 的票列表只认 page/per_page，没有游标串。
 * 把页码原样当游标交回，读的人一眼能看懂；页码失效（不是正整数）时如实说「请重新加载」，
 * 而不是默默从第一页重来——那样会把旧页的内容混进新页里。
 *
 * total 与 counts 用同一套算法（翻页数），拿不全就整体失败。
 * 这里也把 per_page 钳在远端上限 100：超过上限远端会静默截到 100，而「满页」的判断会因此失效。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { ListFilter, PageOpts } from '../../../contract/inputs.js'
import type { PageResult, ReadPageResult } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestIssueList } from '../requests.js'
import { normalizeIssue } from '../model/normalize.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { PAGE_SIZE, asRows, buildListQuery, isBag, labelsOf, remoteStatesOf } from './shared.js'
import { counts } from './counts.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

// 分页契约（缺省一页 50 张、要多了按 200 封顶）是四房同一套口径，数字住在 contract/pagination.ts。
const DEFAULT_LIMIT = PAGINATION.gitee.limitDefault
const MAX_LIMIT = PAGINATION.gitee.limitMax

function limitOf(opts: PageOpts | undefined): number {
  const limit = opts && typeof opts.limit === 'number' ? opts.limit : 0
  if (!Number.isFinite(limit) || limit <= 0) return Math.min(DEFAULT_LIMIT, PAGE_SIZE)
  return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT, PAGE_SIZE))
}

export async function listPage(
  ctx: GiteeCtx,
  repo: Repo,
  filter: ListFilter | undefined,
  opts: PageOpts | undefined,
  opCtx?: GiteeCtx,
): Promise<ReadPageResult> {
  const effective = opCtx || ctx
  const logCtx = effective as OpContext
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(logCtx, 'listPage', 'listPage:repo-ref', Date.now() - startedAt)
    return failGitee('repo.refId missing', 'listPage: repo.refId missing', '')
  }
  const rawCursor = String((opts && opts.cursor) || '').trim()
  let page = 1
  if (rawCursor) {
    if (!/^[0-9]+$/.test(rawCursor) || Number(rawCursor) < 1) {
      emitReadDegraded(logCtx, 'listPage', 'listPage:cursor', Date.now() - startedAt)
      return failGitee(rawCursor, 'listPage: 游标已失效，请重新加载（cursor）', rawCursor)
    }
    page = Number(rawCursor)
  }
  const perPage = limitOf(opts)
  const f: ListFilter = filter || {}

  try {
    // 一页只问一个远端状态；契约的两态在这里取第一个远端状态（open 或 closed），
    // progressing/rejected 的票由 counts 的 total 覆盖，页内以主状态为准（注释即约定）。
    const states = remoteStatesOf(f.state)
    const remoteState = states.length ? states[0] : ''
    const res = await requestIssueList(
      effective,
      refId,
      buildListQuery({ state: remoteState, labels: labelsOf(f.labels), since: f.since, page }),
      GITEE_READ_TIMEOUT_MS,
    )
    if (res.code !== 0) {
      emitReadDegraded(logCtx, 'listPage', 'listPage:transport', Date.now() - startedAt)
      return failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'listPage: 读页失败', res, effective)
    }
    const rows = asRows(parseJsonSafe(res.stdout))
    if (!rows) {
      emitReadDegraded(logCtx, 'listPage', 'listPage:json', Date.now() - startedAt)
      return failGitee(res, 'listPage: 回包不是 JSON 数组', res, effective)
    }
    let items: Issue[] = []
    for (const row of rows) {
      if (!isBag(row)) {
        emitReadDegraded(logCtx, 'listPage', 'listPage:shape', Date.now() - startedAt)
        return failGitee(res, 'listPage: 回包数组里有一行不是对象', res, effective)
      }
      items.push(normalizeIssue(row))
    }
    if (Array.isArray(f.keys) && f.keys.length) {
      const wanted = new Set(f.keys.map((k) => String(k)))
      items = items.filter((issue) => wanted.has(issue.key))
    }
    if (f.type) items = items.filter((issue) => issue.type === f.type)

    const counted = await counts(effective, repo, f, effective)
    if (counted.ok !== true) {
      emitReadDegraded(logCtx, 'listPage', 'listPage:total', Date.now() - startedAt)
      return { ok: false, error: counted.error }
    }
    const data: PageResult = {
      items,
      nextCursor: rows.length >= perPage ? String(page + 1) : null,
      total: counted.data.total,
    }
    return { ok: true, data }
  } catch (err) {
    emitReadDegraded(logCtx, 'listPage', 'listPage:transport', Date.now() - startedAt)
    return failGitee(err, 'listPage: 读页调用失败', err, effective)
  }
}

export default listPage
