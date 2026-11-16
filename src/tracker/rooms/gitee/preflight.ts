/**
 * src/tracker/rooms/gitee/preflight.ts —— Gitee 房的三关预检
 *
 * 三关的顺序不能换，因为它把「我能做什么」按依赖关系一层层收窄：
 *   1. 命令在不在（连 gitee 都找不到，后面两关问都不用问）；
 *   2. 登录态可不可用（没有登录态，仓库看不看得到都无从谈起）；
 *   3. 目标仓库看不看得到（只有给了仓库标识时才查）。
 *
 * 第二关失败时按原文判档；认不出就归 AUTH，不归 NOTFOUND。理由：预检失败的展示位
 * 说「仓库不存在」会把用户引去查仓库地址，而真实原因是没登录——方向反了。
 */
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { PreflightResult } from '../../contract/results.js'
import type { ErrorKind } from '../../contract/identity.js'
import { HINT_UNRECOGNIZED, fail } from '../../kernel/preflight.js'
import { GITEE_PROBE_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import { classifyGiteeError } from './errors.js'
import { execGitee } from './client.js'
import { requestRepo } from './requests.js'
import { repoRefId } from './support/repo-ref.js'
import { emitPreflightGatePass, emitReadDegraded } from './support/read-log.js'

type PreflightHandle = Partial<OpContext> &
  Partial<BackendContext> & {
    refId?: string
    cwd?: string
    repository?: { refId?: string }
  } & Partial<RepositoryRef>

type PreflightCtx = Partial<OpContext> & Partial<BackendContext>

function messageOf(e: unknown): string {
  if (e && typeof e === 'object') {
    const bag = e as Record<string, unknown>
    if (typeof bag['message'] === 'string' && bag['message'].trim()) return bag['message']
    if (typeof bag['stderr'] === 'string' && bag['stderr'].trim()) return bag['stderr']
    if (typeof bag['stdout'] === 'string' && bag['stdout'].trim()) return bag['stdout']
  }
  try {
    return String(e)
  } catch {
    return ''
  }
}

/** 预检的登录探测失败若被判成 not-found，会让人去查仓库；这里统一改判环境问题。 */
function loginProbeKind(kind: ErrorKind): ErrorKind {
  return kind === ERROR_KIND.NOTFOUND ? ERROR_KIND.ENV : kind
}

function asBag(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * 三关预检。任一下降都直接返回 fail(...)，不抛异常；成功回 {ok:true}。
 */
export async function giteePreflight(
  handle: PreflightHandle,
  opCtx?: PreflightCtx,
): Promise<PreflightResult> {
  const ctx = (opCtx || handle || {}) as PreflightCtx
  const platform = ctx.platform
  const execFn = ctx.exec
  const cwd = (ctx && ctx.cwd) || ''
  const signal = ctx && ctx.signal ? ctx.signal : undefined
  const logCtx = ctx as OpContext

  // 第一关：命令是否存在。拿不到平台或拿不到可执行文件都算环境问题。
  if (!platform || typeof platform.resolveExecutable !== 'function') {
    emitReadDegraded(logCtx, 'preflight', 'preflight:gitee', 0)
    return fail(ERROR_KIND.ENV, 'platform unavailable', '')
  }
  const started1 = Date.now()
  let exe: unknown = null
  try {
    exe = await platform.resolveExecutable('gitee')
  } catch {
    exe = null
  }
  if (!exe) {
    emitReadDegraded(logCtx, 'preflight', 'preflight:gitee', Date.now() - started1)
    return fail(ERROR_KIND.ENV, 'gitee not found', '')
  }
  emitPreflightGatePass(logCtx, 1, Date.now() - started1)

  // 第二关：登录态。gitee auth status 非零就是「问不出可用登录态」。
  if (typeof execFn !== 'function') {
    emitReadDegraded(logCtx, 'preflight', 'preflight:auth', 0)
    return fail(ERROR_KIND.ENV, 'exec unavailable', '')
  }
  const started2 = Date.now()
  try {
    const authRes = await execGitee(ctx, ['auth', 'status'], { cwd, signal, timeout: GITEE_PROBE_TIMEOUT_MS })
    if (authRes.code !== 0) {
      const out = String(authRes.stdout || '') + '\n' + String(authRes.stderr || '')
      const verdict = classifyGiteeError(authRes, ctx)
      const message = verdict.fallback ? HINT_UNRECOGNIZED : out.trim().slice(0, 500) || 'gitee auth status failed'
      emitReadDegraded(logCtx, 'preflight', 'preflight:auth', Date.now() - started2)
      return fail(loginProbeKind(verdict.kind), message, out)
    }
  } catch (e) {
    const verdict = classifyGiteeError(e, ctx)
    const message = verdict.fallback ? HINT_UNRECOGNIZED : messageOf(e)
    emitReadDegraded(logCtx, 'preflight', 'preflight:auth', Date.now() - started2)
    return fail(loginProbeKind(verdict.kind), message, e)
  }
  emitPreflightGatePass(logCtx, 2, Date.now() - started2)

  // 第三关：目标仓库可见性。没给仓库标识就到此为止（这一关本来就没有对象可查）。
  const probeId = String((handle && handle.refId) || (handle && handle.repository && handle.repository.refId) || repoRefId(handle) || '').trim()
  if (probeId) {
    const started3 = Date.now()
    try {
      const probe = await requestRepo(ctx, probeId, GITEE_PROBE_TIMEOUT_MS)
      const out = String(probe.stdout || '') + '\n' + String(probe.stderr || '')
      if (probe.code !== 0) {
        // 判档用原文里的状态信息：401/403 是认证与权限，404 是仓库不存在，其余归网络。
        const lower = out.toLowerCase()
        const kind = /401|403|unauthorized|forbidden|permission denied|没有权限/.test(lower)
          ? ERROR_KIND.AUTH
          : /404|not found|不存在/.test(lower)
            ? ERROR_KIND.NOTFOUND
            : ERROR_KIND.NETWORK
        emitReadDegraded(logCtx, 'preflight', 'preflight:repo-view', Date.now() - started3)
        return fail(kind, out.trim().slice(0, 500) || 'gitee repo probe failed', out)
      }
      emitPreflightGatePass(logCtx, 3, Date.now() - started3)
    } catch (e) {
      emitReadDegraded(logCtx, 'preflight', 'preflight:repo-view', Date.now() - started3)
      return fail(ERROR_KIND.NETWORK, messageOf(e).slice(0, 500), e)
    }
  }

  return { ok: true }
}

export default giteePreflight
