/**
 * src/tracker/rooms/gitee/support/capability-register.ts —— Gitee 房的能力登记数据
 *
 * 四档的语义在 src/tracker/contract/capability-answer.ts；这里只放数据，不写函数、不写分支，
 * 也不 import 运行时模块。原因：这张表会被门禁与文档逐条对照，它必须是一份能直接读的声明，
 * 而不是需要执行才能知道答案的代码。成对的文档是 docs/tracker/capability-gitee.md。
 *
 * 档位由协调者定，本文件逐条照抄，不自行升降。凡登记为 provided 的，实现必须真的做到；
 * 做不到的只能改回这张表并说明原因，不许让表与实现各说一套。
 */
import type { CapabilityRegister } from '../../../contract/capability-answer.js'

export const GITEE_CAPABILITY_REGISTER = {
  // 三关预检：命令在不在、登录态可不可用、目标仓库看不看得到；每一关都能如实说出卡在哪一步。
  preflight: { tier: 'provided' },
  // 翻页列票，状态两态映射成 Gitee 的 open/closed；Gitee 的 issues 端点不含拉取请求，按契约如实处理。
  list: { tier: 'provided' },
  // 单张票 + 按需读评论；Gitee 没有 closed_at，closedAt 如实给 null 而不拿更新时间冒充。
  get: { tier: 'provided' },
  // Gitee 的 Open API 里没有任何阻塞边端点（relat/link 全部零命中），只能读票正文末尾的
  // `## Blocked by` 小节；反向「阻塞了谁」要把全仓票面扫一遍，所以可能不全。
  getDependencies: {
    tier: 'partial',
    gap: 'Gitee 没有阻塞边的结构字段，被阻塞关系只能从票正文末尾的「## Blocked by」小节读回来；「阻塞了谁」要扫全仓票面，撞上翻页上限时可能不全，回执会如实标出来。',
    ticket: '11',
  },
  // 建票走 owner 级路径，仓库名放正文；没有幂等锚，idempotencyKey 照发但不产生去重效果（已写在实现注释里）。
  create: { tier: 'provided' },
  // 关票走 PATCH state=closed；Gitee 没有独立的关闭原因字段，opts.reason 原样记在返回实体上。
  close: { tier: 'provided' },
  // 重开走同一端点 state=open；四态里 progressing 读回算开，重开一律写 open。
  reopen: { tier: 'provided' },
  // 评论两端点都齐（GET/POST .../comments），正文与时间都能原样折进契约实体。
  comment: { tier: 'provided' },
  // 改票只发真改了的字段；空补丁不发请求，里程碑按名字在远端查 id。
  update: { tier: 'provided' },
  // 标签是覆盖式写：一次把整串名字交给远端，传空数组就是清空。
  setLabels: { tier: 'provided' },
  // Gitee 的认领人是单值 assignee：0 个清空、1 个直接写；契约允许一次给多个人，这里只能如实拒绝，
  // 不挑一个写进去，也不拿「协助者」字段冒充第二负责人。
  setAssignees: {
    tier: 'partial',
    gap: 'Gitee 的一张票只有一个负责人位置：0 个人清空、1 个人直接写都能用，一次给 2 个人以上只能如实拒绝，不会只写第一个，也不会拿「协助者」字段冒充第二负责人。',
    ticket: '10',
  },
  // 挂父票先 PATCH parent_id，再写后读回；个人仓库实测 parent_id 会被静默忽略（回成功、读回没有父票），
  // 所以结构字段没生效时把关系写成正文里一行「上级地图：#票号」，读侧再解析回来。移回根仍做不到。
  setParent: {
    tier: 'partial',
    gap: '远端 parent_id 会被静默忽略（个人仓库实测写后读回没有父票），只能靠正文里「上级地图：#票号」一行兜底；传 null 要移回根时，远端没有这种写法，仍做不到。',
    ticket: '8',
  },
  // 与 getDependencies 同一条原因：没有阻塞边端点，只能把整段关系写进票正文末尾的小节。
  // 自阻塞与成环在写之前就拒；写后读回小节核对，读不回来就如实失败。
  setBlockedBy: {
    tier: 'partial',
    gap: '阻塞关系只能写进票正文末尾的「## Blocked by」小节，靠人手改票面就能改动它，没有结构字段的保护；写后读回对不上时如实失败，不会报「已记上」。',
    ticket: '11',
  },
  // GET /user 直接给出当前登录人。
  getCurrentUser: { tier: 'provided' },
  // 建远端仓库 + 本地 git 初始化 + 首发推送；远端与本地两步失败分开报。
  initProject: { tier: 'provided' },
  // 标签端点一次返回全量数组（没有分页参数），拿不到数组就整体失败，不交残表。
  listLabels: { tier: 'provided' },
  // 逐条 PATCH 标签颜色，成功与失败分别记账；部分成功是合法结果。
  setLabelColors: { tier: 'provided' },
  // Gitee 没有统计端点，只能翻页数；触到页数上限就整体失败，绝不交残数。
  counts: { tier: 'provided' },
  // 单页读票，游标是页码字符串；total 与 counts 同一套算法，拿不全就按契约失败。
  listPage: { tier: 'provided' },
  // 仓库定义里的 permission 折成 push / triage 两个布尔；问不出来就如实失败，不捏造。
  getRepoPermissions: { tier: 'provided' },
  // 按票面 parent_id 等于地图票的内部 id 过滤子票；parentKey 只在 parent_url 尾段是非数字票号时填。
  listSubIssues: { tier: 'provided' },
  // 与 GitHub/GitLab 同一把尺子：颜色真源在远端标签，工作区文件没有读者，这条能力的后半做不到。
  ensureLabelColorsFile: { tier: 'unsupported-by-design', stubBy: 'backend' },
  // 服务端按 wayfinder-map 标签筛（契约名 wayfinder:map 由 label-alias 翻译），内存里再复核一遍，按更新时间倒序，撞页数上限挂 truncated。
  listMaps: { tier: 'provided' },
  // gitee api 不透响应头，本房今天没有读限额的通道；这是「问不出来」，不是「额度为零」。
  readBudget: { tier: 'unsupported-by-design', stubBy: 'registry' },
  // 只读本地证据（git remote 与 .git/config）解析 gitee.com 的 owner/name，解析不出回 null。
  getRepoKey: { tier: 'provided' },
  // refId 优先、name 退回目录名，地址用默认网页源；host 与默认域名相同时不写。
  describe: { tier: 'provided' },
  // 网页地址是 https://gitee.com/{owner}/{repo}/issues/{票号}。
  issueAddress: { tier: 'provided' },
} as const satisfies CapabilityRegister

export default GITEE_CAPABILITY_REGISTER
