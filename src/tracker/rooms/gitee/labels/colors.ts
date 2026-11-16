/**
 * src/tracker/rooms/gitee/labels/colors.ts —— 逐条改标签颜色
 *
 * Gitee 只有一个标签改色端点：`PATCH /repos/{owner}/{repo}/labels/{original_name}`，
 * 正文的 color 是不带井号的六位十六进制。这里一条一条改、一条一条记账：
 * 成功进 applied，失败进 failed 并带上原因。部分成功是合法结果——批量改色时，
 * 某一条因为没权限或标签被删而失败，不该让其余已经改好的条目回滚（远端也不支持回滚）。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { LabelColorBatchResult, OpResult } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { normalizeColor } from '../../../../shared/label-color/src/colors.js'
import { failGitee } from '../errors.js'
import { requestLabelUpdate } from '../requests.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

export async function setLabelColors(
  ctx: GiteeCtx,
  repo: Repo,
  changes: Array<{ name: string; color: string }>,
): Promise<OpResult<LabelColorBatchResult>> {
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'setLabelColors: repo.refId missing', '')
  const applied: Array<{ name: string; color: string }> = []
  const failed: LabelColorBatchResult['failed'] = []
  try {
    for (const change of Array.isArray(changes) ? changes : []) {
      const name = String(change && change.name != null ? change.name : '').trim()
      const color = normalizeColor(String(change && change.color != null ? change.color : ''))
      if (!name || color === null) {
        failed.push({
          name: name || String(change && change.name != null ? change.name : ''),
          reason: {
            kind: ERROR_KIND.PARSE,
            message: !name
              ? 'setLabelColors: 标签名不能为空'
              : 'setLabelColors: 颜色必须是六位十六进制（可带井号）',
            raw: JSON.stringify(change),
          },
        })
        continue
      }
      const res = await requestLabelUpdate(ctx, refId, name, { color }, GITEE_READ_TIMEOUT_MS)
      if (res.code !== 0) {
        const verdict = failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'setLabelColors: 改色失败', res, ctx)
        failed.push({ name, reason: verdict.error })
        continue
      }
      applied.push({ name, color })
    }
    if (failed.length) emitReadDegraded(ctx as OpContext, 'setLabelColors', 'setLabelColors:transport', Date.now() - startedAt)
    return { ok: true, data: { applied, failed } }
  } catch (err) {
    return failGitee(err, 'setLabelColors: 改色调用失败', err, ctx)
  }
}

export default setLabelColors
