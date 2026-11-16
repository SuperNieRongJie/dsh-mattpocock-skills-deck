/**
 * src/tracker/rooms/gitee/labels/list.ts —— 读全仓库标签
 *
 * Gitee 的 `GET /repos/{owner}/{repo}/labels` 没有分页参数（swagger 只列 access_token/owner/repo），
 * 也就是一次返回全量。所以这里不写翻页循环；拿到的不是数组就整体失败，
 * 不把「远端回了个对象」当作「零个标签」——那样用户会以为标签被删了。
 *
 * 颜色统一成不带井号的六位小写十六进制；给不出就是空串（契约里空串表示没有颜色）。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { LabelColor, RepositoryRef } from '../../../contract/entities.js'
import type { LabelListResult } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestLabelList } from '../requests.js'
import { normalizeLabelEntry } from '../model/normalize.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

export async function listLabels(ctx: GiteeCtx, repo: Repo): Promise<LabelListResult> {
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(ctx as OpContext, 'labels', 'labels:repo-ref', Date.now() - startedAt)
    return failGitee('repo.refId missing', 'listLabels: repo.refId missing', '')
  }
  try {
    const res = await requestLabelList(ctx, refId, GITEE_READ_TIMEOUT_MS)
    if (res.code !== 0) {
      emitReadDegraded(ctx as OpContext, 'labels', 'labels:transport', Date.now() - startedAt)
      return failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'listLabels: 标签没取回来', res, ctx)
    }
    const parsed = parseJsonSafe(res.stdout)
    if (parsed === null) {
      emitReadDegraded(ctx as OpContext, 'labels', 'labels:json', Date.now() - startedAt)
      return failGitee(res, 'listLabels: 回包不是 JSON', res, ctx)
    }
    if (!Array.isArray(parsed)) {
      emitReadDegraded(ctx as OpContext, 'labels', 'labels:shape', Date.now() - startedAt)
      return failGitee(res, 'listLabels: 回包不是一个数组（远端回的不是这个端点的形状）', res, ctx)
    }
    const out: LabelColor[] = []
    for (const row of parsed) {
      const label = normalizeLabelEntry(row)
      if (!label) {
        emitReadDegraded(ctx as OpContext, 'labels', 'labels:shape', Date.now() - startedAt)
        return failGitee(res, 'listLabels: 有一行标签缺名字，整表不敢当全量交出去', res, ctx)
      }
      const item: LabelColor = { name: label.name, color: label.color }
      if (label.description) item.description = label.description
      out.push(item)
    }
    return { ok: true, data: out }
  } catch (err) {
    emitReadDegraded(ctx as OpContext, 'labels', 'labels:transport', Date.now() - startedAt)
    return failGitee(err, 'listLabels: 标签读取调用失败', err, ctx)
  }
}

export default listLabels
