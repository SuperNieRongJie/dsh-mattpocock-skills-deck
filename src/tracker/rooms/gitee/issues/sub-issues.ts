/**
 * src/tracker/rooms/gitee/issues/sub-issues.ts —— 读一张地图票名下的子票
 *
 * Gitee 没有「列子票」端点，也没有阻塞边端点；票面上只有 parent_id（父票的数字 id）。
 * 所以做法是：先把地图票读回来拿它的数字 id，再翻页扫全仓票，按 parent_id === 地图 id 过滤。
 *
 * 有一处必须如实说清：过滤用的是数字 id，但契约的 parentKey 是字符串票号。
 * 这里能让每个子票的 parentKey 等于地图票号（因为我们知道地图是谁），
 * 但 Gitee 的 parent_url 尾段可能是数字，归一后的 parentKey 可能为空；这里用地图票号补上，
 * 语义仍然是「这张子票挂在读到的这张地图下」，不是编造。
 *
 * 翻到 MAX_SUB_ISSUES 就停，并把 capped 置 true；缺编号或形状不对的行计入 dropped，
 * 一行都算不进去时整体失败（说明这不是「没有子票」，是没读懂回包）。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { SubIssueList, SubIssueListResult } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { GITEE_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestIssueList } from '../requests.js'
import { normalizeIssue } from '../model/normalize.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'
import { PAGE_SIZE, asRows, buildListQuery, isBag } from './shared.js'
import { fetchIssueRaw } from './read.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

/** 子票硬上限：超过就不继续翻，交给 capped 说明「没取全」。 */
const MAX_SUB_ISSUES = 1000

export async function listSubIssues(
  ctx: GiteeCtx,
  repo: Repo,
  mapKey: unknown,
  opts: Record<string, never> | undefined,
  opCtx?: GiteeCtx,
): Promise<SubIssueListResult> {
  void opts
  const effective = opCtx || ctx
  const logCtx = effective as OpContext
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(logCtx, 'subIssues', 'subIssues:repo-ref', Date.now() - startedAt)
    return failGitee('repo.refId missing', 'listSubIssues: repo.refId missing', '')
  }
  const wantedMap = String(mapKey == null ? '' : mapKey).trim()
  if (!wantedMap) {
    emitReadDegraded(logCtx, 'subIssues', 'subIssues:shape', Date.now() - startedAt)
    return failGitee('map key required', 'listSubIssues: mapKey 不能为空', '')
  }

  try {
    // 地图票自己的数字 id 是过滤依据；读不到就说明这张地图不存在或没权限。
    const map = await fetchIssueRaw(effective, refId, wantedMap)
    if (!map.ok) {
      emitReadDegraded(logCtx, 'subIssues', 'subIssues:page-fail', Date.now() - startedAt)
      return { ok: false, error: map.result.error }
    }
    const mapId = typeof map.bag['id'] === 'number' && Number.isFinite(map.bag['id']) ? (map.bag['id'] as number) : null
    if (mapId === null) {
      emitReadDegraded(logCtx, 'subIssues', 'subIssues:no-id', Date.now() - startedAt)
      return failGitee(map.raw, 'listSubIssues: 地图票回包里没有数字 id，无法按 parent_id 过滤子票', map.raw)
    }

    const items: Issue[] = []
    let capped = false
    let dropped = 0
    let page = 1
    for (; page <= 20; page += 1) {
      const res = await requestIssueList(
        effective,
        refId,
        buildListQuery({ state: 'all', page }),
        GITEE_SLOW_READ_TIMEOUT_MS,
      )
      if (res.code !== 0) {
        emitReadDegraded(logCtx, 'subIssues', 'subIssues:page-fail', Date.now() - startedAt)
        return failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'listSubIssues: 第 ' + String(page) + ' 页没取回来', res, effective)
      }
      const rows = asRows(parseJsonSafe(res.stdout))
      if (!rows) {
        emitReadDegraded(logCtx, 'subIssues', 'subIssues:json', Date.now() - startedAt)
        return failGitee(res, 'listSubIssues: 回包不是 JSON 数组', res, effective)
      }
      for (const row of rows) {
        if (!isBag(row)) {
          dropped += 1
          continue
        }
        if (row['parent_id'] !== mapId) continue
        if (items.length >= MAX_SUB_ISSUES) {
          capped = true
          break
        }
        try {
          const issue = normalizeIssue(row)
          if (!issue.key || issue.key === '0') {
            dropped += 1
            continue
          }
          issue.parentKey = wantedMap
          items.push(issue)
        } catch {
          dropped += 1
        }
      }
      if (capped) break
      if (rows.length < PAGE_SIZE) break
    }

    if (items.length === 0 && dropped > 0) {
      emitReadDegraded(logCtx, 'subIssues', 'subIssues:shape', Date.now() - startedAt)
      return failGitee(map.raw, 'listSubIssues: 候选行一行都没能算进去（' + String(dropped) + ' 行缺编号或形状不对）', map.raw)
    }
    if (capped) emitReadDegraded(logCtx, 'subIssues', 'subIssues:truncated', Date.now() - startedAt)

    const data: SubIssueList = {
      items,
      total: items.length,
      fetched: items.length,
      capped,
      missing: 0,
      dropped,
    }
    return { ok: true, data }
  } catch (err) {
    emitReadDegraded(logCtx, 'subIssues', 'subIssues:transport', Date.now() - startedAt)
    return failGitee(err, 'listSubIssues: 调用失败', err, effective)
  }
}

export default listSubIssues
