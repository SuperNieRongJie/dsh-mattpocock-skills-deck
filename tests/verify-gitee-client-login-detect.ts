// tests/verify-gitee-client-login-detect.ts —— Gitee 后端「登录态只看人话」的回归门禁
//
// 守的是什么（2026-11-23 的报障）：成功读回票列表时，stdout 是一整车票的 JSON。
// 旧代码拿整段 stdout 去做「未登录」的正则匹配，于是只要列表里有一张票的标题或正文提到
// 「未登录」，一次成功的读取就会被改写成 code=1 的「gitee 未登录」。用户明明登录着，
// 二次打开插件却看到「快照加载失败：gitee 未登录（CLI 原文：[{"id":…）」。
//
// 修法是先把回包分成「人话」与「数据体」（见 src/tracker/rooms/gitee/client.ts 的 humanTextOf），
// 再只拿人话判断登录态。本门禁守两头：
//   · 数据体里的字样不得误报——票列表、单票详情里出现「未登录 / 请先登录 / not logged in」照旧成功；
//   · 真正的未登录喊话必须照旧改写成带操作指引的失败，CLI 原文仍然留在提示里。
//
// 门禁归属: src/tracker/rooms/gitee/client.ts
// 用法：node --import ./scripts/ts-hook.mts tests/verify-gitee-client-login-detect.ts

import { giteeClient } from '../src/tracker/rooms/gitee/client.ts'

let checks = 0
const failures: string[] = []

function check(ok: boolean, msg: string, detail = ''): void {
  checks += 1
  if (ok) {
    console.log('  PASS ' + msg)
    return
  }
  failures.push(msg + (detail ? '：' + detail : ''))
  console.log('  FAIL ' + msg + (detail ? '：' + detail : ''))
}

interface FakeReply {
  code?: number
  stdout?: string
  stderr?: string
}

/** 一台只认 `gitee` 的假平台：拿到什么回复就原样吐什么，命令本身不执行。 */
function fakeCtx(reply: FakeReply) {
  return {
    platform: {
      resolveExecutable: async (name: string) =>
        name === 'gitee' ? 'C:\\fake\\gitee.exe' : 'C:\\fake\\node.exe',
    },
    exec: async () => ({
      code: reply.code === undefined ? 0 : reply.code,
      stdout: reply.stdout === undefined ? '' : reply.stdout,
      stderr: reply.stderr === undefined ? '' : reply.stderr,
    }),
  }
}

/** 走真实调用路径（api → run），这样测到的是列表读取实际经过的那层判断。 */
async function call(reply: FakeReply) {
  return giteeClient(fakeCtx(reply) as any).api('/repos/o/r/issues')
}

const GUIDE = 'gitee 未登录：请先在本机终端运行 gitee auth login'

// ① 成功的票列表里，票面提到「未登录」「请先登录」「not logged in」：一个字都不许改。
const listJson = JSON.stringify([
  {
    id: 35147216,
    url: 'https://gitee.com/api/v5/repos/nrj_verygood/gengyun-agri-web/issues/IKXBR',
    number: 'IKXBR',
    title: '二次打开插件时报未登录',
    body: '已确认 gitee 已登录，但界面说未登录',
  },
  { id: 35147217, number: 'IKXBS', title: '请先登录后再试', body: 'not logged in at all' },
])
const list = await call({ code: 0, stdout: listJson })
check(
  list.code === 0,
  '票列表里的「未登录」字样不改写退出码',
  `退出码是 ${list.code}，期望 0`,
)
check(
  list.stdout === listJson,
  '票列表 JSON 原样交回，一个字节都没动',
  `回包被改了：${list.stdout.slice(0, 120)}`,
)
check(
  list.stderr.indexOf('gitee 未登录') < 0,
  '票列表成功时不冒充「gitee 未登录」',
  `提示里出现了登录未登录文案：${list.stderr.slice(0, 120)}`,
)

// ② 单票详情（一个 JSON 对象）提到「未登录」：同样不许改写。
const oneJson = JSON.stringify({ number: 'IKXBR', title: '未登录也能看', body: 'not logged in' })
const one = await call({ code: 0, stdout: oneJson })
check(
  one.code === 0 && one.stdout === oneJson,
  '单票 JSON 里的「未登录」字样同样不改写',
  `code=${one.code}，stdout=${one.stdout.slice(0, 120)}`,
)

// ③ CLI 真没登录：它退 0、只把一句人话打到 stdout，这种人话必须照旧改写成失败并给出指引。
const english = 'Not logged in. Run: gitee auth login\n'
const unauth = await call({ code: 0, stdout: english })
check(
  unauth.code === 1,
  'CLI 说没登录且退 0 时，改写成 code=1 的失败',
  `退出码是 ${unauth.code}，期望 1`,
)
check(
  unauth.stderr.indexOf(GUIDE) >= 0,
  '失败提示里给出能照着做的中文指引',
  `提示里没有登录指引：${unauth.stderr.slice(0, 160)}`,
)
check(
  unauth.stderr.indexOf('CLI 原文：Not logged in. Run: gitee auth login') >= 0,
  'CLI 原文只引那句人话',
  `CLI 原文不对：${unauth.stderr.slice(0, 200)}`,
)
check(
  unauth.stderr.indexOf('[{') < 0 && unauth.stdout === '',
  '改写后不再把数据体当原文交上去',
  `stdout=${unauth.stdout.slice(0, 120)}`,
)

// ④ 中文人话「未登录，请先执行 gitee auth login」：同样算没登录。
const chinese = await call({ code: 0, stdout: '未登录，请先执行 gitee auth login\n' })
check(
  chinese.code === 1 && chinese.stderr.indexOf('CLI 原文：未登录，请先执行 gitee auth login') >= 0,
  '中文人话里的「未登录」照旧改写成失败',
  `code=${chinese.code}，提示=${chinese.stderr.slice(0, 160)}`,
)

// ⑤ Gitee 自己的错误信封是一句人话：{"message":"未登录"} 要判成未登录。
const envelope = await call({ code: 0, stdout: JSON.stringify({ message: '未登录' }) })
check(
  envelope.code === 1 && envelope.stderr.indexOf(GUIDE) >= 0 && envelope.stderr.indexOf('CLI 原文：未登录') >= 0,
  '错误信封（message 字段）里的「未登录」仍能认出来',
  `code=${envelope.code}，提示=${envelope.stderr.slice(0, 160)}`,
)

// ⑥ 认证失败只出现在 stderr、stdout 一个字没有：照旧判成未登录。
const onStderr = await call({ code: 0, stdout: '', stderr: '未登录：请先执行 gitee auth login\n' })
check(
  onStderr.code === 1 && onStderr.stderr.indexOf(GUIDE) >= 0,
  'stderr 里的「未登录」照旧判成未登录',
  `code=${onStderr.code}，提示=${onStderr.stderr.slice(0, 160)}`,
)

// ⑦ 空列表是正常响应，不是「没登录」：`[]` 必须原样成功。
const empty = await call({ code: 0, stdout: '[]' })
check(
  empty.code === 0 && empty.stdout === '[]',
  '空列表 [] 原样成功，不被误判成未登录',
  `code=${empty.code}，stdout=${empty.stdout}`,
)

// ⑧ 普通非 JSON 回包（既不是人话里的未登录，也不是数据体）照旧原样交回。
const plain = await call({ code: 0, stdout: 'ok\n' })
check(
  plain.code === 0 && plain.stdout.trim() === 'ok',
  '普通回包不被登录判断波及',
  `code=${plain.code}，stdout=${plain.stdout}`,
)

console.log('')
if (failures.length > 0) {
  console.log(`✗ Gitee 登录态判定门禁失败：${failures.length} 项（共 ${checks} 项检查）`)
  process.exitCode = 1
} else {
  console.log(`✓ Gitee 登录态判定门禁通过：${checks} 项检查`)
}
