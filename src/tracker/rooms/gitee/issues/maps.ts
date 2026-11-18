/**
 * src/tracker/rooms/gitee/issues/maps.ts —— 读地图薄行
 *
 * 服务端按 wayfinder-map 标签筛（state=all，开着关着都要），内存里再用 isMapLabel 复核一遍：
 * Gitee 的 labels 参数是精确匹配（大小写敏感），而人手工改过的标签可能写成 Wayfinder-Map；
 * 服务端漏掉的这些行，这里兜住。canonical 名与中划线名的换算统一交给 label-alias，
 * 本文件不再自己写死任何一个标签名。
 *
 * 一页 100 行、最多 10 页；撞上限只挂 truncated:true，不把「只读了这些」说成「就这些」。
 * 单页失败整趟失败：给出半份地图列表，比明确报错更容易让人以为地图真的只有这些。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { MapListOpResult, MapRow } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { GITEE_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestIssueList } from '../requests.js'
import { normalizeIssue } from '../model/normalize.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'
import { WAYFINDER_MAP_LABEL, isMapLabel } from '../support/label-alias.js'
import { PAGE_SIZE, asRows, buildListQuery, isBag } from './shared.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

const MAX_MAP_PAGES = 10

function hasMapLabel(issue: Issue): boolean {
  if (!Array.isArray(issue.labels)) return false
  return issue.labels.some((l) => isMapLabel(String(l && l.name ? l.name : '')))
}

export async function listMaps(ctx: GiteeCtx, repo: Repo): Promise<MapListOpResult> {
  const logCtx = ctx as OpContext
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(logCtx, 'maps', 'maps:repo-ref', Date.now() - startedAt)
    return failGitee('repo.refId missing', 'listMaps: repo.refId missing', '')
  }
  try {
    const rows: Array<{ row: MapRow; updatedAt: string; seq: number }> = []
    let truncated = false
    for (let page = 1; page <= MAX_MAP_PAGES; page += 1) {
      const res = await requestIssueList(
        ctx,
        refId,
        buildListQuery({ state: 'all', labels: WAYFINDER_MAP_LABEL, page }),
        GITEE_SLOW_READ_TIMEOUT_MS,
      )
      if (res.code !== 0) {
        emitReadDegraded(logCtx, 'maps', 'maps:transport', Date.now() - startedAt)
        return failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'listMaps: 读地图列表失败', res, ctx)
      }
      const parsed = parseJsonSafe(res.stdout)
      const list = asRows(parsed)
      if (!list) {
        emitReadDegraded(logCtx, 'maps', 'maps:json', Date.now() - startedAt)
        return failGitee(res, 'listMaps: 回包不是 JSON 数组', res, ctx)
      }
      for (const item of list) {
        if (!isBag(item)) {
          emitReadDegraded(logCtx, 'maps', 'maps:shape', Date.now() - startedAt)
          return failGitee(res, 'listMaps: 回包数组里有一行不是对象', res, ctx)
        }
        const issue = normalizeIssue(item)
        // 类型推断已经认过地图标签；这里再按小写复核一次，兜住服务端大小写敏感漏掉的行。
        if (issue.type !== 'map' && !hasMapLabel(issue)) continue
        rows.push({
          row: {
            key: String(issue.key),
            title: issue.title,
            state: issue.state,
            url: issue.url,
          },
          updatedAt: issue.updatedAt || '',
          seq: rows.length,
        })
      }
      if (list.length < PAGE_SIZE) break
      if (page === MAX_MAP_PAGES) {
        truncated = true
        emitReadDegraded(logCtx, 'maps', 'maps:truncated', Date.now() - startedAt)
      }
    }

    rows.sort((a, b) => {
      if (a.updatedAt === b.updatedAt) return a.seq - b.seq
      if (!a.updatedAt) return 1
      if (!b.updatedAt) return -1
      return a.updatedAt < b.updatedAt ? 1 : -1
    })
    return {
      ok: true,
      data: { rows: rows.map((entry) => entry.row), total: rows.length, truncated },
    }
  } catch (err) {
    emitReadDegraded(logCtx, 'maps', 'maps:transport', Date.now() - startedAt)
    return failGitee(err, 'listMaps: 调用失败', err, ctx)
  }
}

export default listMaps
