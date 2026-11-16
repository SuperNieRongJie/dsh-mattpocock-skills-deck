/**
 * src/tracker/rooms/gitee/project/init-project.ts —— 建远端仓库并完成本地初始化与首推
 *
 * 一条完整的建仓要跨两个世界：远端（POST /user/repos）与本地（git init/add/commit/push）。
 * 两段失败的含义完全不同，所以分开报：
 *   · 远端没建起来 → 本地什么都不做，用户重试是安全的；
 *   · 远端建好了、本地 git 失败 → 仓库已经存在，重试会撞名，必须告诉用户「远端已建好、本地没成」，
 *     修好本地之后再推，不要让他以为整件事都没发生。
 *
 * 仓库名只允许字母、数字、点、下划线、连字符（最长 100），与 Gitee 的路径规则一致；
 * 可见性只有 public/private 两档，Gitee 的 public 就是「开源」。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { InitProjectInput } from '../../../contract/inputs.js'
import type { OpResult } from '../../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { fail } from '../../../kernel/preflight.js'
import { GITEE_CREATE_REPO_TIMEOUT_MS, GITEE_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestCurrentUser, requestRepoCreate } from '../requests.js'
import { parseJsonSafe } from '../support/json.js'
import { emitReadDegraded } from '../support/read-log.js'
import { isBag } from '../issues/shared.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
type InitHandle = { cwd?: string; refId?: string } & Partial<RepositoryRef>

interface ProcResult {
  stdout: string
  stderr: string
  code: number
}

function procOf(res: unknown): ProcResult {
  if (res && typeof res === 'object') {
    const bag = res as Record<string, unknown>
    const out = typeof bag['stdout'] === 'string' ? bag['stdout'] : ''
    const err = typeof bag['stderr'] === 'string' ? bag['stderr'] : ''
    const code = typeof bag['code'] === 'number' ? bag['code'] : bag['ok'] === false ? 1 : 0
    return { stdout: out, stderr: err, code }
  }
  return { stdout: '', stderr: '', code: 0 }
}

export async function initProject(
  handle: InitHandle,
  input: InitProjectInput,
  ctx: GiteeCtx,
): Promise<OpResult<RepositoryRef>> {
  const cwd = String((handle && handle.cwd) || ctx.cwd || '')
  const name = String(input && input.name != null ? input.name : '').trim()
  if (!name) return fail(ERROR_KIND.PARSE, 'initProject: 仓库名不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    return fail(ERROR_KIND.PARSE, 'initProject: 仓库名只支持字母、数字、点、下划线、连字符，最长 100 个字符', name, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  const visibility = input && input.visibility === 'public' ? 'public' : 'private'
  const platform = ctx.platform
  const execFn = ctx.exec

  // 本地 git 是这一条能力的另一半；没有 git 就不必建远端仓库，否则会留下一个空仓库。
  if (!platform || typeof platform.resolveExecutable !== 'function') {
    return failGitee('platform unavailable', 'initProject: 平台不可用，没法确认本机有没有 git', '')
  }
  let gitExe: unknown = null
  try {
    gitExe = await platform.resolveExecutable('git')
  } catch {
    gitExe = null
  }
  if (!gitExe || typeof execFn !== 'function') {
    emitReadDegraded(ctx as OpContext, 'initProject', 'initProject:local', 0)
    return failGitee('git not found', 'initProject: 本机没找到 git，先在远端建仓库会留下一个空仓，所以整件事没有开始', '')
  }

  const git = async (args: string[]): Promise<ProcResult> => {
    try {
      return procOf(await execFn('git', args, { cwd, signal: ctx.signal, timeout: GITEE_SLOW_READ_TIMEOUT_MS }))
    } catch (e) {
      const bag = (e || {}) as Record<string, unknown>
      return { stdout: '', stderr: String(bag['message'] || e || ''), code: 1 }
    }
  }

  try {
    // 归属命名空间用当前登录人：个人建仓走 /user/repos，仓库就落在这个账号下。
    const me = await requestCurrentUser(ctx, GITEE_SLOW_READ_TIMEOUT_MS)
    if (me.code !== 0) {
      emitReadDegraded(ctx as OpContext, 'initProject', 'initProject:remote', 0)
      return failGitee(me, 'initProject: 问不到当前登录人，没法确定仓库建在谁名下', me, ctx)
    }
    const meBag = parseJsonSafe(me.stdout)
    const owner = isBag(meBag) ? String(meBag['login'] || '').trim() : ''
    if (!owner) {
      return failGitee(me, 'initProject: 登录人回包里没有 login，拿不到归属命名空间', me, ctx)
    }

    const created = await requestRepoCreate(ctx, { name, private: visibility === 'private' }, GITEE_CREATE_REPO_TIMEOUT_MS)
    if (created.code !== 0) {
      emitReadDegraded(ctx as OpContext, 'initProject', 'initProject:remote', 0)
      return failGitee(
        created,
        String(created.stderr || '') || String(created.stdout || '') || 'initProject: 远端仓库没建起来（本地什么都没动）',
        created,
        ctx,
      )
    }

    const webUrl = 'https://gitee.com/' + owner + '/' + name
    const remoteUrl = webUrl + '.git'
    const refId = owner + '/' + name

    const step = async (args: string[], what: string): Promise<OpResult<RepositoryRef> | null> => {
      const res = await git(args)
      if (res.code === 0) return null
      emitReadDegraded(ctx as OpContext, 'initProject', 'initProject:local', 0)
      return failGitee(
        res,
        'initProject: 远端仓库已经建好了（' + webUrl + '），但本地 ' + what + ' 失败：' + (res.stderr || res.stdout || '').trim().slice(0, 300),
        res,
        ctx,
      )
    }

    const initFail = await step(['init'], 'git init')
    if (initFail) return initFail

    // 已有 origin 就改地址，没有才加；直接 add 会在换了目录之后报 already exists。
    const existing = await git(['remote', 'get-url', 'origin'])
    const remoteFail = await step(existing.code === 0 ? ['remote', 'set-url', 'origin', remoteUrl] : ['remote', 'add', 'origin', remoteUrl], '配置 origin')
    if (remoteFail) return remoteFail

    const addFail = await step(['add', '.'], '暂存文件')
    if (addFail) return addFail

    let commit = await git(['commit', '-m', 'initial commit', '--allow-empty'])
    if (commit.code !== 0 && /please tell me who you are|user\.name|user\.email|author identity unknown|unable to auto-detect email/i.test(commit.stderr + commit.stdout)) {
      // 新机器上常常没有配提交身份；这一步只补本仓库的身份，不改用户的全局配置。
      await git(['config', 'user.email', 'dsh@local'])
      await git(['config', 'user.name', 'DSH User'])
      commit = await git(['commit', '-m', 'initial commit', '--allow-empty'])
    }
    if (commit.code !== 0) {
      emitReadDegraded(ctx as OpContext, 'initProject', 'initProject:local', 0)
      return failGitee(
        commit,
        'initProject: 远端仓库已经建好了（' + webUrl + '），但本地提交失败：' + (commit.stderr || commit.stdout || '').trim().slice(0, 300) + '，本地修改都还在',
        commit,
        ctx,
      )
    }

    const push = await git(['push', '-u', 'origin', 'HEAD'])
    if (push.code !== 0) {
      emitReadDegraded(ctx as OpContext, 'initProject', 'initProject:local', 0)
      return failGitee(
        push,
        'initProject: 远端仓库已经建好了（' + webUrl + '），但 git push 没推上去，本地提交还在，修好之后重推即可：' + (push.stderr || push.stdout || '').trim().slice(0, 300),
        push,
        ctx,
      )
    }

    const ref: RepositoryRef = { backend: 'gitee', refId, name, url: webUrl }
    return { ok: true, data: ref }
  } catch (err) {
    return failGitee(err, 'initProject: 建仓调用失败', err, ctx)
  }
}

export default initProject
