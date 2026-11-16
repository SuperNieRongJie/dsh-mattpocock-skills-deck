/**
 * src/tracker/rooms/gitee/issues/read.ts —— 列票与读单张票
 *
 * 两处与 Gitee 的实际形状绑定、别处不要再猜的约定：
 *   · 列表一次只收一个 state，而契约的两态各对应两个远端状态，所以「开」与「关」各分两趟问；
 *   · 类型（issue/map/spec）没有对应的查询参数，只能在内存里按归一后的结果筛。
 *     这不是偷懒：Gitee 的票接口没有 issue_type 参数（swagger 里只有建票/改票的正文有），
 *     硬塞一个不存在的参数会让远端直接忽略，最后给出一份「看起来筛过、其实没筛」的列表。
 *
 * 读评论是尽力而为：评论取不回来不影响票本身，票照样返回，只留一行退化日志。
 * 但 commentCount 必须填远端给的总数——拿回来 3 条就说「一共 3 条」会让用户以为票只有 3 条评论。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { GetOpts, ListFilter } from '../../../contract/inputs.js'
import type { IssueDetailResult, IssueListResult, TrackerError } from '../../../contract/results.js'
import { LIST_TRUNCATED_REASON, TRACKER_ERROR_STAGE } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { fail } from '../../../kernel/preflight.js'
import { requestCommentList, requestIssueGet, requestIssueList } from '../requests.js'
import { normalizeIssue } from '../model/normalize.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'
import { LIST_MAX_PAGES, PAGE_SIZE, asRows, buildListQuery, isBag, labelsOf, remoteStatesOf } from './shared.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>

export type Repo = Partial<RepositoryRef> | null | undefined

function textOf(res: { stdout?: string; stderr?: string }): string {
  return String(res.stderr || '') || String(res.stdout || '')
}

/** 评论最多取多少条：契约给的是「前 N 条」，超过上限也只回上限，不把整棵树拉进来。 */
const COMMENTS_MAX = 200

function commentsWantOf(opts: GetOpts | undefined): number {
  const first = opts && opts.comments ? opts.comments.first : 0
  if (typeof first !== 'number' || !Number.isFinite(first) || first <= 0) return 0
  return Math.min(COMMENTS_MAX, Math.floor(first))
}

/**
 * 列票。
 *
 * 翻页到「这一页不满」为止；撞到页数上限就带上 truncated 标记并记一行退化日志，
 * 绝不把「只读了一部分」说成「就这些」。
 */
export async function listIssues(
  ctx: GiteeCtx,
  repo: Repo,
  filter: ListFilter | undefined,
  opCtx?: GiteeCtx,
): Promise<IssueListResult> {
  const effective = opCtx || ctx
  const logCtx = effective as OpContext
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(logCtx, 'list', 'list:repo-ref', Date.now() - startedAt)
    return fail(ERROR_KIND.NOTFOUND, 'list: repo.refId missing', '')
  }
  const f: ListFilter = filter || {}
  // Gitee 的 issues 端点不混拉取请求；要拉取请求时如实回空数组，并说明这不是「没票」。
  if (f.isPullRequest === true) {
    emitReadDegraded(logCtx, 'list', 'list:pull-request', Date.now() - startedAt)
    return { ok: true, data: [] }
  }

  try {
    const states = remoteStatesOf(f.state)
    const buckets = states.length ? states : ['']
    const items: Issue[] = []
    let truncated = false
    for (const state of buckets) {
      for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
        const res = await requestIssueList(
          effective,
          refId,
          buildListQuery({ state, labels: labelsOf(f.labels), since: f.since, page }),
          GITEE_READ_TIMEOUT_MS,
        )
        if (res.code !== 0) {
          return failGitee(res, textOf(res) || 'list: gitee api issues 失败', res, effective)
        }
        const rows = asRows(parseJsonSafe(res.stdout))
        if (!rows) {
          emitReadDegraded(logCtx, 'list', 'list:json', Date.now() - startedAt)
          return fail(ERROR_KIND.PARSE, 'list: 回包不是一个 JSON 数组（远端回的不是这个端点的形状）', res.stdout)
        }
        for (const row of rows) {
          if (!isBag(row)) {
            emitReadDegraded(logCtx, 'list', 'list:shape', Date.now() - startedAt)
            return fail(ERROR_KIND.PARSE, 'list: 回包数组里有一行不是对象', res.stdout)
          }
          items.push(normalizeIssue(row))
        }
        if (rows.length < PAGE_SIZE) break
        if (page === LIST_MAX_PAGES) {
          truncated = true
          emitReadDegraded(logCtx, 'list', LIST_TRUNCATED_REASON, Date.now() - startedAt)
        }
      }
    }

    let out = items
    if (Array.isArray(f.keys) && f.keys.length) {
      const wanted = new Set(f.keys.map((k) => String(k)))
      out = out.filter((issue) => wanted.has(issue.key))
    }
    if (f.type) out = out.filter((issue) => issue.type === f.type)
    if (f.parentKey !== undefined && f.parentKey !== null) {
      out = out.filter((issue) => issue.parentKey === String(f.parentKey))
    }
    return truncated ? { ok: true, data: out, truncated: true } : { ok: true, data: out }
  } catch (err) {
    return failGitee(err, 'list: gitee api issues 调用失败', err, effective)
  }
}

/** 单张票的原始回包；评论、写票改票都用它取当前状态。 */
export async function fetchIssueRaw(
  opCtx: GiteeCtx,
  refId: string,
  key: string,
): Promise<{ ok: true; bag: Record<string, unknown>; raw: string } | { ok: false; result: { ok: false; error: TrackerError } }> {
  const res = await requestIssueGet(opCtx, refId, key, GITEE_READ_TIMEOUT_MS)
  if (res.code !== 0) {
    return {
      ok: false,
      result: failGitee(res, textOf(res) || 'issue ' + key + ' 没取回来', res, opCtx),
    }
  }
  const parsed = parseJsonSafe(res.stdout)
  if (parsed === null) {
    const result = failGitee(res, 'issue ' + key + ' 没找到', res, opCtx)
    return { ok: false, result: { ...result, error: { ...result.error, kind: ERROR_KIND.NOTFOUND } } }
  }
  if (!isBag(parsed)) {
    return {
      ok: false,
      result: failGitee(res, 'get: 回包不是一个 JSON 对象', res, opCtx),
    }
  }
  return { ok: true, bag: parsed, raw: res.stdout }
}

/**
 * 读单张票，并按 opts.comments.first 取前若干条评论。
 *
 * 评论取失败只记一行退化日志：票本身已经拿到了，为用户的一个附带请求把整张票判成失败不划算。
 */
export async function getIssue(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  opts: GetOpts | undefined,
  opCtx?: GiteeCtx,
): Promise<IssueDetailResult> {
  const effective = opCtx || ctx
  const logCtx = effective as OpContext
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(logCtx, 'get', 'get:repo-ref', Date.now() - startedAt)
    return fail(ERROR_KIND.NOTFOUND, 'get: repo.refId missing', '')
  }
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) {
    return fail(ERROR_KIND.PARSE, 'get: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  try {
    const fetched = await fetchIssueRaw(effective, refId, wantedKey)
    if (!fetched.ok) return fetched.result
    const issue = normalizeIssue(fetched.bag)
    const total = typeof issue.commentCount === 'number' ? issue.commentCount : 0
    const want = commentsWantOf(opts)
    if (want > 0) {
      const collected = await fetchComments(effective, refId, wantedKey, want, logCtx, startedAt)
      if (collected) issue.comments = collected
    }
    issue.commentCount = total > 0 ? total : issue.comments ? issue.comments.length : 0
    return { ok: true, data: issue }
  } catch (err) {
    emitReadDegraded(logCtx, 'get', 'get:transport', Date.now() - startedAt)
    return failGitee(err, 'get: gitee api 调用失败', err, effective)
  }
}

/** 取前 want 条评论；失败回 null（调用方保留票、只丢评论）。 */
async function fetchComments(
  opCtx: GiteeCtx,
  refId: string,
  key: string,
  want: number,
  logCtx: OpContext,
  startedAt: number,
): Promise<Issue['comments'] | null> {
  const out: NonNullable<Issue['comments']> = []
  const maxPages = Math.min(LIST_MAX_PAGES, Math.ceil(want / PAGE_SIZE) + 1)
  try {
    for (let page = 1; page <= maxPages && out.length < want; page += 1) {
      const query = 'per_page=' + PAGE_SIZE + '&page=' + page + '&order=asc'
      const res = await requestCommentList(opCtx, refId, key, query, GITEE_READ_TIMEOUT_MS)
      if (res.code !== 0) {
        emitReadDegraded(logCtx, 'get', 'get:transport', Date.now() - startedAt)
        return null
      }
      const rows = asRows(parseJsonSafe(res.stdout))
      if (!rows) {
        emitReadDegraded(logCtx, 'get', 'get:json', Date.now() - startedAt)
        return null
      }
      for (const row of rows) {
        if (!isBag(row)) continue
        const one = normalizeIssue({ number: '0', body: '', comments: [row] })
        const comment = one.comments && one.comments[0]
        if (comment) out.push(comment)
        if (out.length >= want) break
      }
      if (rows.length < PAGE_SIZE) break
    }
    return out.slice(0, want)
  } catch {
    emitReadDegraded(logCtx, 'get', 'get:transport', Date.now() - startedAt)
    return null
  }
}

export default { listIssues, getIssue, fetchIssueRaw }
