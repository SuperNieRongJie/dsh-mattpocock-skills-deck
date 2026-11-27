/**
 * src/tracker/rooms/gitee/issues/blocked-by.ts —— 改「这张票被谁阻塞」
 *
 * Gitee 没有阻塞边的结构字段，所以关系只能写进票正文末尾的 `## Blocked by` 小节
 * （写法与读法共用 model/blocked-by-section.ts 那一份约定）。这份实现有四个不能省的动作：
 *   1. 自阻塞与成环先拒（成环时一个字都不写），这是契约对 setBlockedBy 的硬规矩；
 *   2. 阻塞票逐张读回拿标题，读不回就如实失败——写半截的小节比没写更糟；
 *   3. 底稿只取一次成功的单票读回：建票/改票回包里的正文可能残缺，拿它盖回去会把票面写没；
 *   4. 写后读回核对小节里的票号集合，对不上就如实失败，不报「已记上」。
 *
 * 失败文案统一标「（来源：正文）」：这条关系在 Gitee 上只有正文这一种落法，人看到失败时
 * 该知道去票面末尾看，而不是去某个结构字段里找。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { SetOpts } from '../../../contract/inputs.js'
import type { OpResult } from '../../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { fail } from '../../../kernel/preflight.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { normalizeIssue } from '../model/normalize.js'
import { withBlockedBySection } from '../model/blocked-by-section.js'
import { requestIssueUpdate } from '../requests.js'
import { repoNameOf, repoRefId } from '../support/repo-ref.js'
import { fetchIssueRaw } from './read.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

type ReadOutcome = { ok: true; issue: Issue } | { ok: false; result: { ok: false; error: unknown } }

/** 读一张票；同一个票号在一次写里只读一次，环检沿边走访时不会把同一张票翻来覆去地读。 */
async function readIssueCached(opCtx: GiteeCtx, refId: string, key: string, cache: Map<string, ReadOutcome>): Promise<ReadOutcome> {
  const hit = cache.get(key)
  if (hit) return hit
  const raw = await fetchIssueRaw(opCtx, refId, key)
  const outcome: ReadOutcome = raw.ok
    ? { ok: true, issue: normalizeIssue(raw.bag) }
    : { ok: false, result: raw.result }
  cache.set(key, outcome)
  return outcome
}

function keysOf(issue: { blockedBy?: { key: string }[] }): string[] {
  return (issue.blockedBy || []).map((ref) => String(ref.key))
}

function setDiff(want: string[], got: string[]): { missing: string[]; extra: string[] } {
  return { missing: want.filter((key) => got.indexOf(key) < 0), extra: got.filter((key) => want.indexOf(key) < 0) }
}

/**
 * 把阻塞关系整段换成 `blockers`（这是替换语义，不是追加：契约的 setBlockedBy 就是这么定的）。
 *
 * 环检沿「被阻塞票的正文小节」往下走：目标票这一跳用本次要写的集合，其余票用它们当前的正文，
 * 所以判的是「写完之后会不会成环」，而不是「现在有没有环」。
 */
export async function setBlockedBy(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  blockers: string[],
  opts: SetOpts | undefined,
  opCtx?: GiteeCtx,
): Promise<OpResult<Issue>> {
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'setBlockedBy: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'setBlockedBy: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  const wanted: string[] = []
  for (const item of Array.isArray(blockers) ? blockers : []) {
    const one = String(item == null ? '' : item).trim()
    if (one && wanted.indexOf(one) < 0) wanted.push(one)
  }
  // 自阻塞是入参自己打架，还没碰远端就能判：原文里带一份入参快照。
  if (wanted.indexOf(wantedKey) >= 0) {
    return fail(
      ERROR_KIND.CONFLICT,
      'setBlockedBy: 一张票不能阻塞自己（' + wantedKey + '）',
      JSON.stringify({ key: wantedKey, blockers: wanted }),
      TRACKER_ERROR_STAGE.INPUT_REFUSED,
    )
  }
  try {
    const cache = new Map<string, ReadOutcome>()
    const target = await readIssueCached(effective, refId, wantedKey, cache)
    if (!target.ok) {
      // 读不回整票时既没有可靠底稿，也不知道小节现状：一个字都不改。
      return failGitee('setBlockedBy: 单票读不回来', 'setBlockedBy: 单票读不回来，读不回整票就不敢改正文（来源：正文）', '', effective)
    }
    if (opts && typeof opts.expectedUpdatedAt === 'string' && opts.expectedUpdatedAt !== '' && target.issue.updatedAt !== opts.expectedUpdatedAt) {
      return fail(
        ERROR_KIND.CONFLICT,
        'setBlockedBy: 这张票在别处改过了（期望 ' + opts.expectedUpdatedAt + '，实际 ' + target.issue.updatedAt + '）',
        JSON.stringify({ key: wantedKey, expectedUpdatedAt: opts.expectedUpdatedAt, actualUpdatedAt: target.issue.updatedAt }),
        TRACKER_ERROR_STAGE.INPUT_REFUSED,
      )
    }

    // 阻塞票先逐张读回：标题要写进小节，读不回就不知道写什么；同时它们的正文是环检的边。
    const entries: { key: string; title: string }[] = []
    for (const blocker of wanted) {
      const one = await readIssueCached(effective, refId, blocker, cache)
      if (!one.ok) {
        return failGitee(
          { kind: ERROR_KIND.NETWORK },
          'setBlockedBy: 阻塞票 #' + blocker + ' 读不回来，标题写不进小节，这条关系没有写（来源：正文）',
          one.result,
          effective,
        )
      }
      entries.push({ key: blocker, title: one.issue.title })
    }

    // 环检：从目标票出发沿「本次要写的集合 + 各票当前正文」走，走回目标票就是成环。
    const visited = new Set<string>()
    const stack = wanted.slice()
    while (stack.length > 0) {
      const node = String(stack.pop())
      if (node === wantedKey) {
        return fail(
          ERROR_KIND.CONFLICT,
          'setBlockedBy: 写完会成环（' + wantedKey + ' 经由 ' + wanted.join('、') + ' 又绕回自己）',
          JSON.stringify({ key: wantedKey, blockers: wanted }),
          TRACKER_ERROR_STAGE.INPUT_REFUSED,
        )
      }
      if (visited.has(node)) continue
      visited.add(node)
      const one = await readIssueCached(effective, refId, node, cache)
      if (!one.ok) {
        // 读不全图就不敢断言没有环：这是「没查清」，不是「查清没有」。
        return failGitee(
          { kind: ERROR_KIND.NETWORK },
          'setBlockedBy: 环检时 #' + node + ' 读不回来，读不全图就不敢写（来源：正文）',
          one.result,
          effective,
        )
      }
      for (const next of keysOf(one.issue)) stack.push(next)
    }

    const nextBody = withBlockedBySection(target.issue.body, entries)
    // 小节已经与目标一致时不再发请求：重复标记同一张票不该产生第二次正文改动。
    if (nextBody === target.issue.body && setDiff(wanted, keysOf(target.issue)).missing.length === 0) {
      return { ok: true, data: target.issue }
    }
    const res = await requestIssueUpdate(effective, refId, wantedKey, { repo: repoNameOf(refId), body: nextBody }, GITEE_READ_TIMEOUT_MS)
    // 写动作的自述不是证据：一律以写后读回为准。回包失败但读回对上了，也按成功算（正文确实落盘了）。
    const back = await readIssueCached(effective, refId, wantedKey, new Map())
    if (back.ok) {
      const after = keysOf(back.issue)
      const diff = setDiff(wanted, after)
      if (diff.missing.length === 0 && diff.extra.length === 0) return { ok: true, data: back.issue }
    }
    // 回包本身失败时先报「写正文失败」：这时读回对不上是失败的结果，不是另一条独立结论。
    if (res.code !== 0) {
      return failGitee(
        res,
        'setBlockedBy: Gitee 没有阻塞边的结构字段，关系只能写进票正文；写正文失败：' + (String(res.stderr || '').trim() || String(res.stdout || '').trim() || '原因不明') + '（来源：正文）',
        res,
        effective,
      )
    }
    if (back.ok) {
      const after = keysOf(back.issue)
      const diff = setDiff(wanted, after)
      return failGitee(
        { kind: ERROR_KIND.CONFLICT },
        'setBlockedBy: 写后读回的小节对不上（少：' + (diff.missing.join('、') || '无') + '；多：' + (diff.extra.join('、') || '无') + '）（来源：正文）',
        JSON.stringify({ key: wantedKey, wanted, after }),
        effective,
      )
    }
    // 回包说成功、单票却读不回来：不能报成功，只能报「写没写成不知道」。
    return failGitee(
      { kind: ERROR_KIND.NETWORK },
      'setBlockedBy: 改正文的回包说成功，但写后单票读不回来，无法确认阻塞关系已经写进正文（来源：正文）',
      '',
      effective,
    )
  } catch (err) {
    return failGitee(err, 'setBlockedBy: 写阻塞关系失败', err, effective)
  }
}

export default { setBlockedBy }
