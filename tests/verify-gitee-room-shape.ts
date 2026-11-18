/**
 * tests/verify-gitee-room-shape.ts —— Gitee 房的结构与纪律门禁。
 *
 * 门禁归属: src/tracker/rooms/gitee
 *
 * 这扇门禁回答三个问题：
 *   一、房间交给注册表的那张模块对象还对不对（id、label、create、matches、budget）；
 *   二、能力登记表里写成 provided 的每一条，实现里是不是真有那个函数 —— 两边各说一套时，用户点到的
 *       就是一个「登记说能做、点下去报 unsupported」的操作；
 *   三、房间自己的纪律有没有破：不许 import 别的房、不许 import 装配点、不许直接碰 node:fs 或全局 fetch、
 *       端点路径只许在 queries.ts 拼、分页额度只许从 contract/pagination.ts 取。
 *
 * 为什么这些检查值得单独一扇门禁：上面每一条都是「破了也不会立刻报错」的约定。跨房 import 能通过编译，
 * 直接 fetch 能跑通，路径散到别处照样能请求成功，分页数字抄一份同值拷贝也看不出区别 —— 等到哪天真出问题，
 * 表现会是「某个房间莫名其妙受另一房影响」「离线时行为不一致」，排查代价远大于这里的几十行。
 *
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-gitee-room-shape.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const ROOM_DIR = path.join(ROOT, 'src/tracker/rooms/gitee')

let checks = 0
const failures: string[] = []

function check(ok: boolean, okMessage: string, failure?: string): void {
  checks += 1
  if (ok) {
    console.log(`  ✓ ${okMessage}`)
    return
  }
  const line = failure ?? okMessage
  console.log(`  ✗ ${line}`)
  failures.push(line)
}

/** 把注释换成等长空格（保留行号与列位置），字符串原样留着：查「代码里有没有这个形状」时不会被注释骗。 */
function maskComments(code: string): string {
  const out = code.split('')
  let i = 0
  let quote = ''
  while (i < code.length) {
    const ch = code[i]
    if (quote) {
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i += 1; continue }
    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') { out[i] = ' '; i += 1 }
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] !== '\n') out[i] = ' '
        i += 1
      }
      if (i < code.length) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    i += 1
  }
  return out.join('')
}

function roomFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...roomFiles(abs))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs)
  }
  return out
}

const files = roomFiles(ROOM_DIR)
const relOf = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/')
const masked = new Map<string, string>()
for (const abs of files) masked.set(relOf(abs), maskComments(fs.readFileSync(abs, 'utf8')))

console.log('Gitee 房结构与纪律门禁')
console.log('')

// 第一节：房间交出去的模块对象
const room = await import('../src/tracker/rooms/gitee/index.js')
const backend = room.giteeBackend as unknown as Record<string, unknown>
check(backend && backend.id === 'gitee', "模块对象的 id 是 'gitee'", `模块对象的 id 是 ${String(backend && backend.id)}，期望 'gitee'`)
check(backend && backend.label === 'Gitee', "模块对象的 label 是 'Gitee'", `模块对象的 label 是 ${String(backend && backend.label)}，期望 'Gitee'`)
check(typeof backend?.create === 'function', '模块对象带 create 函数', '模块对象没有 create 函数，注册表会拒绝它')
check(
  typeof backend?.matches === 'function',
  '模块对象带 matches 函数（判定层靠它决定这一房认不认这个仓库）',
  '模块对象没有 matches 函数，判定层永远轮不到 Gitee',
)
const budget = backend?.budget as Record<string, unknown> | undefined
check(
  budget?.kind === 'requests-only' && budget?.countsRequests === true && budget?.countsPoints === false && budget?.independentBuckets === false,
  '额度模型是「只数请求」：数请求、不数点数、各操作用同一桶',
  `额度模型不对，实际是 ${JSON.stringify(budget)}`,
)

// 第二节：能力登记里 provided 的每一条，实现里真有那个函数
const registerMod = await import('../src/tracker/rooms/gitee/support/capability-register.js')
const register = registerMod.GITEE_CAPABILITY_REGISTER as unknown as Record<string, { tier: string }>
const created = backend.create({} as never) as unknown as Record<string, unknown>
const provided = Object.keys(register).filter((key) => register[key].tier === 'provided')
const missing = provided.filter((key) => typeof created[key] !== 'function')
check(provided.length > 0, `能力登记表里有 ${provided.length} 条 provided`, '能力登记表里一条 provided 都没有，这张表已经不能说明房间能做什么')
check(
  missing.length === 0,
  '登记成 provided 的每一条在房间里都有对应实现',
  `这些登记成 provided，但房间里没有实现：${missing.join('、')}`,
)

// 第三节：房间纪律（扫全房 28 个文件）
const crossRoom: string[] = []
const assembly: string[] = []
const fsOrFetch: string[] = []
const strayPaths: string[] = []
const v5: string[] = []
for (const [rel, code] of masked) {
  if (/from ['"][^'"]*rooms\/(?:github|gitlab|markdown)\//.test(code)) crossRoom.push(rel)
  if (/from ['"][^'"]*registry\/builtins\.js['"]/.test(code)) assembly.push(rel)
  if (/from ['"]node:fs['"]|\bfetch\s*\(/.test(code)) fsOrFetch.push(rel)
  if (rel !== 'src/tracker/rooms/gitee/queries.ts' && /['"`]repos\//.test(code)) strayPaths.push(rel)
  if (/\/v5\//.test(code)) v5.push(rel)
}
check(
  crossRoom.length === 0,
  '没有文件 import 别的房间（房间之间不互相依赖，共享物只许下沉到 kernel）',
  `这些文件 import 了别的房间：${crossRoom.join('、')}`,
)
check(
  assembly.length === 0,
  '没有文件 import 装配点（房间不许知道自己在哪被装起来）',
  `这些文件 import 了 registry/builtins：${assembly.join('、')}`,
)
check(
  fsOrFetch.length === 0,
  '没有文件直接碰 node:fs 或全局 fetch（文件读写走 fs 接口、起进程走 exec）',
  `这些文件直接用了 node:fs 或 fetch：${fsOrFetch.join('、')}`,
)
check(
  strayPaths.length === 0,
  '端点路径只在 queries.ts 里拼（别处出现 repos/ 开头的新路径就是第二份真源）',
  `这些文件在 queries.ts 之外拼了端点路径：${strayPaths.join('、')}`,
)
check(
  v5.length === 0,
  '路径里不写 /v5（gitee CLI 的 api_prefix 已经带 /v5，再写一段就会变成 /v5/v5）',
  `这些文件写了 /v5：${v5.join('、')}`,
)

// 第四节：分页额度只许从共享表取
const pagingSites: { file: string; name: string; expected: string }[] = [
  { file: 'src/tracker/rooms/gitee/issues/shared.ts', name: 'PAGE_SIZE', expected: 'PAGINATION.gitee.maxPerPage' },
  { file: 'src/tracker/rooms/gitee/issues/shared.ts', name: 'LIST_MAX_PAGES', expected: 'PAGINATION.gitee.listMaxPages' },
  { file: 'src/tracker/rooms/gitee/issues/counts.ts', name: 'COUNT_MAX_PAGES', expected: 'PAGINATION.gitee.countMaxPages' },
  { file: 'src/tracker/rooms/gitee/issues/sub-issues.ts', name: 'MAX_SUB_ISSUES', expected: 'PAGINATION.gitee.subIssuesMax' },
]
const notShared = pagingSites.filter((site) => {
  const code = masked.get(site.file) || ''
  const pattern = new RegExp('const ' + site.name + '\\s*=\\s*' + site.expected.replace(/\./g, '\\.') + '\\b')
  return !pattern.test(code)
})
check(
  notShared.length === 0,
  '四处分页额度都从 contract/pagination.ts 取（房内不留同值拷贝）',
  `这些额度没有从共享表取：${notShared.map((site) => site.file + ':' + site.name).join('、')}`,
)

// 第五节：Gitee 的查询串与标签别名
//
// 这一节守的是两个已经真出过事的形状：列表查询里的 sort 值 Gitee 不认，整个列表请求 400；
// 标签名里的半角冒号 Gitee 不收，写进去被静默丢弃、按它筛永远是空。两处都不报显眼的错，
// 只表现为「列表打不开」与「地图永远是 0 行」，所以在这里把请求形状和换算规则钉住。
const alias = await import('../src/tracker/rooms/gitee/support/label-alias.js')
const sharedQuery = await import('../src/tracker/rooms/gitee/issues/shared.js')
const normalizeMod = await import('../src/tracker/rooms/gitee/model/normalize.js')
const writeMod = await import('../src/tracker/rooms/gitee/issues/write.js')
const giteeErrors = await import('../src/tracker/rooms/gitee/errors.js')
const { ERROR_KIND } = await import('../src/tracker/contract/vocabulary.js')

const plainQuery = sharedQuery.buildListQuery({ page: 1 })
check(
  plainQuery.includes('sort=updated') && !plainQuery.includes('updated_at'),
  '列表查询的 sort 用 Gitee 认得的 updated，不再用不存在的 updated_at',
  `列表查询的 sort 形状不对：${plainQuery}`,
)
const filteredQuery = sharedQuery.buildListQuery({ page: 2, state: 'open', labels: 'wayfinder:map,enhancement' })
check(
  filteredQuery.includes('labels=' + encodeURIComponent('wayfinder-map,enhancement')),
  '列表过滤把 canonical 标签名翻成 Gitee 上的中划线名再发出',
  `列表过滤没有翻成远端名：${filteredQuery}`,
)

const canonicalToRemote = [
  ['wayfinder:map', 'wayfinder-map'],
  ['wayfinder:research', 'wayfinder-research'],
  ['wayfinder:prototype', 'wayfinder-prototype'],
  ['wayfinder:grilling', 'wayfinder-grilling'],
  ['wayfinder:task', 'wayfinder-task'],
]
const wrongRemote = canonicalToRemote.filter(([canonical, remote]) => alias.toRemote(canonical) !== remote || alias.toCanonical(remote) !== canonical)
check(
  wrongRemote.length === 0,
  '五枚 wayfinder 标签在 canonical 名与 Gitee 中划线名之间双向换算',
  `这些标签换算不对：${wrongRemote.map((pair) => pair.join(' ↔ ')).join('、')}`,
)
check(
  alias.toRemote('bug') === 'bug' && alias.toCanonical('enhancement') === 'enhancement',
  '不在名单里的标签原样返回（别名只覆盖五枚 wayfinder 标签）',
  '别名映射把不在名单里的标签也改了',
)
check(
  alias.isMapLabel('wayfinder:map') && alias.isMapLabel('wayfinder-map') && !alias.isMapLabel('wayfinder-task'),
  '地图标签判定同时认 canonical 名与远端名',
  '地图标签判定没有同时认两种写法',
)

const createdMap = writeMod.labelsForCreate({ type: 'map', labels: [] })
check(
  createdMap.length === 1 && createdMap[0] === 'wayfinder-map',
  '建地图票时会补上 wayfinder-map（不是带冒号的 wayfinder:map）',
  `建地图票补出来的标签不对：${JSON.stringify(createdMap)}`,
)
const createdMixed = writeMod.labelsForCreate({ type: 'map', labels: ['wayfinder:map', 'wayfinder-map', 'wayfinder:research'] })
check(
  createdMixed.join(',') === 'wayfinder-map,wayfinder-research',
  '建票时两种写法先合并去重、再翻成远端名，不会把同一枚标签发两遍',
  `建票标签没有正确合并：${JSON.stringify(createdMixed)}`,
)
check(
  writeMod.labelsForSet(['wayfinder:task', { name: 'wayfinder-task' }]) === 'wayfinder-task',
  '覆盖式写标签同样先合并去重再翻成远端名',
  `覆盖式写标签翻出来的名字不对：${writeMod.labelsForSet(['wayfinder:task', { name: 'wayfinder-task' }])}`,
)

const remoteLabel = normalizeMod.normalizeLabelEntry({ name: 'wayfinder-map', color: '8b5cf6' })
check(
  remoteLabel.name === 'wayfinder:map',
  '读回 Gitee 的 wayfinder-map 时折成 canonical 名 wayfinder:map',
  `读回的标签名是 ${remoteLabel.name}，期望 wayfinder:map`,
)
const remoteMapIssue = normalizeMod.normalizeIssue({
  number: 'I1',
  title: '一张地图',
  state: 'open',
  labels: [{ name: 'wayfinder-map', color: '8b5cf6' }],
})
check(
  remoteMapIssue.type === 'map' && remoteMapIssue.labels[0]?.name === 'wayfinder:map',
  '按真实 Gitee 回包形状（标签是 wayfinder-map）能认回地图票',
  `地图票没有认回来：type=${remoteMapIssue.type}，labels=${JSON.stringify(remoteMapIssue.labels)}`,
)

const http400 = giteeErrors.classifyGiteeError({
  code: 1,
  stderr: 'HTTP 400: {"messages":["sort does not have a valid value"]}',
})
check(
  http400.kind === ERROR_KIND.PARSE && http400.fallback === false,
  'Gitee 的 HTTP 400 判成参数/解析问题，不再落成网络问题',
  `HTTP 400 的判档是 ${http400.kind}（fallback=${String(http400.fallback)}），期望 parse`,
)

const aliasFreeFiles = [
  'src/tracker/rooms/gitee/issues/maps.ts',
  'src/tracker/rooms/gitee/model/normalize.ts',
  'src/tracker/rooms/gitee/issues/write.ts',
  'src/tracker/rooms/gitee/labels/colors.ts',
]
const stillHardcoded = aliasFreeFiles.filter((rel) => /wayfinder:/.test(masked.get(rel) || ''))
check(
  stillHardcoded.length === 0,
  '标签名只在 label-alias 里定义，其余 Gitee 文件不再写死带冒号的名字',
  `这些文件还写死了带冒号的标签名：${stillHardcoded.join('、')}`,
)

console.log('')
if (failures.length > 0) {
  console.log(`✗ Gitee 房结构与纪律门禁失败：${failures.length} 项（共 ${checks} 项检查）`)
  process.exitCode = 1
} else {
  console.log(`✓ Gitee 房结构与纪律门禁通过：${checks} 项检查（扫了 ${files.length} 个文件）`)
}
