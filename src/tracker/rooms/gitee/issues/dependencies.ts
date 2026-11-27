/**
 * src/tracker/rooms/gitee/issues/dependencies.ts —— 读「这张票被谁阻塞、阻塞了谁」
 *
 * Gitee 的 Open API 没有阻塞边的端点或字段，唯一的真源就是票正文末尾的 `## Blocked by` 小节
 * （约定见 model/blocked-by-section.ts，读写必须同一份）。所以这里做两件事：
 *   · 被阻塞：读这张票的正文，把小节里的票号逐个落实成「票号 + 标题 + 状态」；
 *   · 阻塞了谁：反向关系没有地方存，只能把全仓票面读一遍，看谁的小节里写了本票票号。
 *
 * 读不全时如实说读不全：单票读不回就直接失败（否则会拿空正文冒充「没有阻塞」），
 * 反向扫描撞上翻页上限或列不出来就把 blockingComplete 置 false 并写明原因，
 * 绝不把「没扫到」说成「没有」。这是契约对 Dependencies 的硬要求。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { IssueRef, RepositoryRef } from '../../../contract/entities.js'
import type { DepsOpts } from '../../../contract/inputs.js'
import type { Dependencies, DependenciesResult } from '../../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { fail } from '../../../kernel/preflight.js'
import { failGitee } from '../errors.js'
import { normalizeIssue } from '../model/normalize.js'
import { repoRefId } from '../support/repo-ref.js'
import { fetchIssueRaw, listIssues } from './read.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

/** 把一行票折成契约的 IssueRef；状态为空时不编一个（未知就该显示成未知）。 */
function refOf(row: { key: string; title: string; state?: string }): IssueRef {
  const ref: IssueRef = { key: row.key, title: row.title }
  if (row.state === 'open' || row.state === 'closed') ref.state = row.state
  return ref
}

function messageOf(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error || '原因不明')
  const bag = error as Record<string, unknown>
  const native = bag['nativeMessage']
  if (typeof native === 'string' && native) return native
  const message = bag['message']
  return typeof message === 'string' && message ? message : '原因不明'
}

/**
 * 读出任意一张票并归一；读不回时返回 null。
 * 反向扫描与标题落实共用这一条，免得两处各写一遍「读票失败怎么办」。
 */
async function readOne(opCtx: GiteeCtx, refId: string, key: string) {
  const raw = await fetchIssueRaw(opCtx, refId, key)
  if (!raw.ok) return null
  return normalizeIssue(raw.bag)
}

export async function getDependencies(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  opts: DepsOpts | undefined,
  opCtx?: GiteeCtx,
): Promise<DependenciesResult> {
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'getDependencies: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'getDependencies: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  try {
    // 被阻塞关系只能从正文读，读不回整票就不知道小节里写了什么：这时失败，不猜空。
    const raw = await fetchIssueRaw(effective, refId, wantedKey)
    if (!raw.ok) return raw.result
    const issue = normalizeIssue(raw.bag)
    const only = opts && Array.isArray(opts.keys) && opts.keys.length > 0 ? new Set(opts.keys.map((k) => String(k))) : null
    const entries = (issue.blockedBy || [])
      .map((ref) => ({ key: ref.key, title: ref.title }))
      .filter((entry) => !only || only.has(entry.key))

    // 一次列全仓票面：既是落实标题/状态的索引，也是反向阻塞的唯一取数处。
    const listed = await listIssues(effective, repo, undefined, effective)
    const rows = listed.ok ? listed.data : null
    const byKey = new Map<string, { key: string; title: string; state?: string; body: string }>()
    if (rows) for (const row of rows) byKey.set(row.key, row)

    const blockedBy: IssueRef[] = []
    const notes: string[] = []
    let blockedByComplete = true
    for (const entry of entries) {
      const hit = byKey.get(entry.key)
      if (hit) {
        blockedBy.push(refOf(hit))
        continue
      }
      // 清单里没这张票时再单票读一次：票可能刚好被过滤掉，也可能清单翻页时漏了。
      // 这两条路都走这一趟单票读，不因为「整仓清单列成功了」就当作「这张票没有状态」。
      const one = await readOne(effective, refId, entry.key)
      if (one) {
        blockedBy.push(refOf(one))
        continue
      }
      // 读不出标题与状态时仍然保留这条关系（正文说了它存在），但这次确实没读全，要如实标出来：
      // 把「没读到」写成「没有状态」，读的人会当成这张票真的没有状态。
      blockedBy.push({ key: entry.key, title: entry.title })
      blockedByComplete = false
      notes.push('被阻塞的 #' + entry.key + ' 读不出标题与状态（' + (rows ? '整仓清单里没这张票，单票也没读回来' : '列全仓票面失败，单票也没读回来') + '）')
    }

    const blocking: IssueRef[] = []
    let blockingComplete = true
    if (!listed.ok) {
      blockingComplete = false
      notes.push('阻塞了谁没查清：列全仓票面失败（' + messageOf(listed.error) + '）')
    } else {
      if (listed.truncated) {
        blockingComplete = false
        notes.push('阻塞了谁可能不全：列全仓票面撞到翻页上限')
      }
      for (const row of listed.data) {
        if (row.key === wantedKey) continue
        const blocksMe = (row.blockedBy || []).some((ref) => ref.key === wantedKey)
        if (!blocksMe) continue
        // 这条反向边住在**别人**的票正文里，来源也照着那一列标：上层要能说清「我挡住了谁」是从
        // 谁的正文扫出来的。本票自己没有被阻塞时，它没有 blockedBySource 可借，所以来源挂在边上。
        const ref = refOf(row)
        if (row.blockedBySource) ref.source = row.blockedBySource
        blocking.push(ref)
      }
    }

    const data: Dependencies = {
      blockedBy,
      blocking,
      blockedByComplete,
      blockingComplete,
      // 反向关系是扫票面扫出来的，不是远端原生给的；上层据此提示「可能不全」。
      blockingSource: 'scan',
    }
    if (notes.length > 0) data.blockingNote = notes.join('；')
    return { ok: true, data }
  } catch (err) {
    return failGitee(err, 'getDependencies: 读阻塞关系失败', err, effective)
  }
}

export default { getDependencies }
