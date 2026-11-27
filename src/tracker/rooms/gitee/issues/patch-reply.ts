/**
 * src/tracker/rooms/gitee/issues/patch-reply.ts —— 把改票回包折成一张票
 *
 * 建票、关票、重开、改票、改标签、改认领、挂父票在 Gitee 上都走同一个改票端点，回包形状一致，
 * 所以归一与判档只写这一份。非 0 退出码交给 failGitee 判档；退出码是 0 但回包不是 JSON 对象时，
 * 如实说是解析问题，不猜远端写了什么。
 */
import type { Issue } from '../../../contract/entities.js'
import type { OpResult } from '../../../contract/results.js'
import { failGitee } from '../errors.js'
import { normalizeIssue } from '../model/normalize.js'
import { parseJsonSafe } from '../support/json.js'
import { isBag } from './shared.js'

export function textOf(res: { stdout?: string; stderr?: string }): string {
  return String(res.stderr || '') || String(res.stdout || '')
}

export function normalizePatchReply(
  res: { stdout?: string; stderr?: string; code?: number },
  fallback: string,
): { ok: true; issue: Issue } | { ok: false; result: OpResult<Issue> } {
  if (res.code !== 0) {
    return { ok: false, result: failGitee(res, textOf(res) || fallback, res) }
  }
  const parsed = parseJsonSafe(res.stdout)
  if (!isBag(parsed)) {
    return { ok: false, result: failGitee(res, 'write: 回包不是一个 JSON 对象', res) }
  }
  return { ok: true, issue: normalizeIssue(parsed) }
}