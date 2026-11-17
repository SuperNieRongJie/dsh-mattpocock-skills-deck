/**
 * src/tracker/rooms/gitee/client.ts —— 起 Gitee 官方 CLI（gitee）的客户端外壳
 *
 * 房间不直接发 HTTP：所有 REST 调用都走官方 CLI 的原生通道 `gitee api`。
 * 这样认证、令牌存放、代理设置全部交给 CLI 自己管，房间里既没有令牌，也没有第二套认证逻辑。
 *
 * 三条约定：
 *   1. 起进程只走 ctx.exec（平台注入），房间不 import node:child_process；
 *   2. 可执行文件拿不到时回一条 code=127 的假结果，而不是抛异常——上层能像处理真实失败一样处理它，
 *      报错里写的是「gitee 没找到」，用户一看就知道是环境问题，不会误以为仓库不存在；
 *   3. api() 只是把领域参数翻译成命令行参数，不解 JSON、不判档、不记业务日志。
 *
 * 另外这里还负责「请求次数」的记账：接口层每个操作执行期间开一个盒子，成功返回时把
 * requests 数字附在结果上（points 恒为 0，Gitee 没有可读的配额点数）。
 */
// 本域 tsconfig 有意不加载任何类型包（types 为空），node:async_hooks 的类型声明随 @types/node
// 一起被挡在门外；运行时一定是 Node，这个模块必然存在。
// @ts-expect-error 本域类型配置没有加载 @types/node
import { AsyncLocalStorage } from 'node:async_hooks'
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import { errMsg } from './support/json.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>

export interface GiteeRunOpts {
  cwd?: string
  timeout?: number
  signal?: AbortSignal
}

/** 一次进程调用的收尾形状；stdout 是 JSON 文本，诊断信息在 stderr。 */
export interface GiteeRunResult {
  stdout: string
  stderr: string
  code: number
}

export interface GiteeApiOpts {
  method?: string
  /** 请求正文：只放领域值（标题、正文、标签串……），序列化在这里做。 */
  body?: Record<string, unknown>
}

export interface GiteeClient {
  run(args: string[], opts?: GiteeRunOpts): Promise<GiteeRunResult>
  api(path: string, opts?: GiteeApiOpts, runOpts?: GiteeRunOpts): Promise<GiteeRunResult>
}

interface GiteeUsageBox {
  requests: number
  points: number
}

interface GiteeUsageStore {
  run<T>(box: GiteeUsageBox, fn: () => T): T
  getStore(): GiteeUsageBox | undefined
}

const giteeUsageStore = new AsyncLocalStorage() as GiteeUsageStore

function noteGiteeUsage(): void {
  const box = giteeUsageStore.getStore()
  if (box) box.requests += 1
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * gitee CLI 的「没登录」不是失败退出：它照样以 0 退出，只把一句人话打到 stdout，
 * 于是上层会拿到一段「像成功、又解析不出 JSON」的输出，最终只能报「未能识别」。
 *
 * 这里把这种输出统一改写成一次真正的失败（code=1），并把提示换成能照着做的中文句子；
 * CLI 原文留在同一句后面，界面上展开原文时还看得见。
 */
const NOT_LOGGED_IN = /not logged in|未登录|请先登录/i

function loginNoticeOf(res: GiteeRunResult): string {
  const said = (res.stdout || res.stderr || '').trim().split('\n')[0].slice(0, 200)
  const guide = 'gitee 未登录：请先在本机终端运行 gitee auth login，登录态由 gitee CLI 自己保存'
  return said ? guide + '（CLI 原文：' + said + '）' : guide
}

function normalizeResult(res: unknown): GiteeRunResult {
  if (res == null) return { stdout: '', stderr: '', code: 0 }
  if (typeof res === 'object') {
    const bag = res as Record<string, unknown>
    if (typeof bag['code'] === 'number') {
      return { stdout: text(bag['stdout']), stderr: text(bag['stderr']), code: bag['code'] }
    }
    if (typeof bag['ok'] === 'boolean') {
      return { stdout: text(bag['stdout'] ?? bag['out']), stderr: text(bag['stderr']), code: bag['ok'] ? 0 : 1 }
    }
  }
  return { stdout: String(res), stderr: '', code: 0 }
}

/**
 * 把一张「操作表」里的每个函数包一层记账：执行期间开一个 requests 盒子，
 * 结果 ok:true 时把用量附在返回对象上。
 *
 * 为什么要包整张表：契约里的 usage 挂在每次操作的结果上，而不是一个全局计数器；
 * 只有操作自己知道这次成功了几次远端调用，所以只能在操作边界上收集。
 */
export function attachGiteeOpUsage<T extends object>(table: T): T {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(table)) {
    if (typeof value !== 'function') {
      out[name] = value
      continue
    }
    const fn = value as (...args: unknown[]) => unknown
    out[name] = (...args: unknown[]): unknown => {
      const box: GiteeUsageBox = { requests: 0, points: 0 }
      const result = giteeUsageStore.run(box, () => fn(...args))
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return (result as Promise<unknown>).then((reply) => {
          if (reply && typeof reply === 'object' && (reply as { ok?: unknown }).ok === true) {
            return Object.assign({}, reply as object, { usage: { requests: box.requests, points: box.points } })
          }
          return reply
        })
      }
      return result
    }
  }
  return out as T
}

/**
 * 造一个绑定到某次操作上下文的客户端。
 *
 * 拿不到平台、拿不到 exec、或者找不到 gitee 可执行文件时，都回 code=127 的假结果：
 * 上层按「Gitee 侧失败」处理，preflight 会把它显示成环境问题。
 */
export function giteeClient(opCtx: GiteeCtx): GiteeClient {
  const run = async (args: string[], opts: GiteeRunOpts = {}): Promise<GiteeRunResult> => {
    const ctx = opCtx || {}
    const platform = ctx.platform
    if (!platform || typeof platform.resolveExecutable !== 'function') {
      return { stdout: '', stderr: 'platform unavailable', code: 127 }
    }
    const execFn = ctx.exec
    if (typeof execFn !== 'function') {
      return { stdout: '', stderr: 'exec unavailable', code: 127 }
    }
    let exe: unknown = null
    try {
      exe = await platform.resolveExecutable('gitee')
    } catch {
      exe = null
    }
    if (!exe) {
      return { stdout: '', stderr: 'gitee: command not found', code: 127 }
    }
    noteGiteeUsage()
    try {
      const res = await execFn('gitee', args, {
        cwd: opts.cwd || ctx.cwd,
        signal: opts.signal,
        timeout: opts.timeout,
      })
      const out = normalizeResult(res)
      // 不管退出码是 0 还是 1，只要说的是「没登录」，一律换成能照着做的中文句子。
      // 退出码在这件事上不可信：同一条命令在有的旗标组合下退 0、有的退 1。
      if (NOT_LOGGED_IN.test(out.stdout + ' ' + out.stderr)) {
        return { stdout: '', stderr: loginNoticeOf(out), code: 1 }
      }
      return out
    } catch (e) {
      const bag = (e || {}) as Record<string, unknown>
      return {
        stdout: text(bag['stdout']),
        stderr: errMsg(e) || 'gitee exec failed',
        code: typeof bag['code'] === 'number' ? bag['code'] : 1,
      }
    }
  }

  const api = (path: string, opts: GiteeApiOpts = {}, runOpts: GiteeRunOpts = {}): Promise<GiteeRunResult> => {
    // 三条都照着 gitee CLI v0.3.4 的原样行为写，改前先跑一次 `gitee api --help` 核对：
    //   · 默认就把响应体原样打成 JSON，没有 --json 这个旗标（多写一个会直接「unknown flag」失败）；
    //   · 只有 --method / --body / -f / -X / -p 这几个，查询串要拼在路径里；
    //   · --no-tui 是全局旗标，非交互调用时关掉 TUI，免得拿终端控制字符当响应体。
    const args: string[] = ['api', path, '--method', opts.method || 'GET', '--no-tui']
    if (opts.body && typeof opts.body === 'object') args.push('--body', JSON.stringify(opts.body))
    return run(args, runOpts)
  }

  return { run, api }
}

/** 直接起一次 gitee 命令的便捷入口（preflight 与本地 git 步骤用）。 */
export async function execGitee(opCtx: GiteeCtx, args: string[], opts: GiteeRunOpts = {}): Promise<GiteeRunResult> {
  return giteeClient(opCtx).run(args, opts)
}

export default giteeClient
