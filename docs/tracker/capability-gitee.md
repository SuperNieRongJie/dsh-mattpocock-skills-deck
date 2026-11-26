# Gitee 后端能力登记表

第四间房（Gitee）的能力登记。登记口径与另外三份相同：**明确提供功能**——今天就能干活；
**做了但没做到位**——能写、但远端的结构字段靠不住，要另走一条兜底写法；
**明确不支持**——形态不合、永远不会有；**当前不支持、未来会开发**——说得通、今天没做。
本表逐条对照实现写，不估。

实现真源：`src/tracker/rooms/gitee/index.ts`（工厂 25 个成员）+ 各实现文件；成对的登记数据是
`src/tracker/rooms/gitee/support/capability-register.ts`。名录上的 27 条 = 24 条操作 + 3 条定位口，
其中 22 条明确提供功能（19 条操作 + 3 条定位口）、3 条做了但没做到位（`setParent` 的父票、
`getDependencies` 与 `setBlockedBy` 的阻塞关系：远端都没有可用的结构字段，改用正文兜底）、
2 条按设计明确不支持。两条不支持的能力不靠房间自己造桩：注册表会替缺失的操作补桩，
房间再造一个就成了两处说法。

## 操作（24 条中：19 条明确提供功能、3 条做了但没做到位、2 条明确不支持）

| 能力 | 登记 | 依据 |
|---|---|---|
| preflight | 明确提供功能 | `preflight.ts` 三关检查：先看 `gitee` 命令在不在，再看 `gitee auth status` 能不能问出登录态，给了仓库标识时再查 `GET /repos/{owner}/{repo}` 看不看得到，每一关失败都如实说出卡在哪一步。 |
| list | 明确提供功能 | `issues/read.ts` 以 `per_page=100` 翻页列票，契约的两态各自映射到 Gitee 的远端状态，标签、since、keys、parentKey、类型这些筛选项在内存里补齐。 |
| get | 明确提供功能 | `issues/read.ts` 读单张票并按 `opts.comments.first` 取评论，评论只取前若干条，但 `commentCount` 一定填远端给的总数，多出来的不假装没有。 |
| getDependencies | 做了但没做到位 | `issues/dependencies.ts` 从票正文末尾的 `## Blocked by` 小节读被阻塞关系（Gitee 的 Open API 里没有任何阻塞边端点，按 relat、link 搜遍 swagger 零命中），小节里的票号逐个落实成标题与状态，票上标出来源「正文」。反向的「阻塞了谁」没有地方存，只能把全仓票面扫一遍；扫不动或撞翻页上限时 `blockingComplete` 置否并写明原因，不把没扫到说成没有。 |
| create | 明确提供功能 | `issues/write.ts` 走 owner 级路径 `POST /repos/{owner}/issues`，仓库名放正文，标签拼成逗号串；Gitee 没有幂等锚，`idempotencyKey` 照发但不产生去重效果，实现注释里写清了这一点。 |
| close | 明确提供功能 | `issues/write.ts` 用 `PATCH /repos/{owner}/issues/{number}` 写 `state=closed`，`opts.reason` 原样记在返回实体上，因为 Gitee 没有独立的关闭原因字段。 |
| reopen | 明确提供功能 | `issues/write.ts` 用同一端点写 `state=open`；远端四态里的 progressing 读回算开，重开一律写 open。 |
| comment | 明确提供功能 | `comments/write.ts` 走 `POST /repos/{owner}/{repo}/issues/{number}/comments`，返回的评论折成契约实体，空正文在本地就被拒绝。 |
| update | 明确提供功能 | `issues/write.ts` 只把真改了的字段放进 PATCH，空补丁不发请求；里程碑按名字在远端查 id，清空里程碑没有可用写法时如实回不支持。 |
| setLabels | 明确提供功能 | `issues/write.ts` 把整串标签名字交给 `PATCH`，是覆盖式写：传空数组就是清空。 |
| setAssignees | 明确提供功能 | `issues/write.ts` 按 Gitee 的单值 `assignee` 处理：0 个清空、1 个直接写、2 个以上如实回不支持，不假装成功。 |
| setParent | 做了但没做到位 | `issues/write.ts` 先把父票的字符串票号读成内部数字 id，再 PATCH `parent_id`，然后读回核对；个人仓库实测这个字段会被静默忽略（回成功、读回没有父票），所以结构字段没生效时把关系写成正文里一行 `上级地图：#票号`，读侧再从正文解析回来并标出来源「正文」；结构字段真有值时来源标「结构」。传 null 要「移到根」时 swagger 里没有这种写法，只能如实回不支持。 |
| setBlockedBy | 做了但没做到位 | `issues/blocked-by.ts` 把关系写进票正文末尾的小节，条目形如 `- 标题（#票号）`；底稿只取一次成功的单票读回，写后读回核对票号集合，对不上或写不进去都如实失败。自阻塞、写完成环、写前版本对不上都按 conflict 拒绝且一个字不写；阻塞票或环检路上的票读不回来时也如实失败，不写半截。小节靠人手删改，没有结构层保护。 |
| getCurrentUser | 明确提供功能 | `repo/current-user.ts` 读 `GET /user`，登录人取回包里的 `login` 字段，没有就不拿展示名顶上。 |
| initProject | 明确提供功能 | `project/init-project.ts` 先 `POST /user/repos` 建远端仓库，再依次做本地 git 初始化、配 origin、首次提交与推送，远端失败与本地 git 失败分开报。 |
| listLabels | 明确提供功能 | `labels/list.ts` 读 `GET /repos/{owner}/{repo}/labels`；这个端点没有分页参数、一次返回全量数组，拿不到数组就整体失败，不交残表。 |
| setLabelColors | 明确提供功能 | `labels/colors.ts` 逐条 `PATCH /repos/{owner}/{repo}/labels/{original_name}`，成功与失败分别落进 applied 与 failed，部分成功是合法结果。 |
| counts | 明确提供功能 | `issues/counts.ts` 因为 Gitee 没有统计端点，只能按开、关两趟翻页数到底；触到页数上限就整体失败，绝不交残数。 |
| listPage | 明确提供功能 | `issues/pages.ts` 读单页票，游标是页码字符串，`total` 与 counts 用同一套算法，拿不全就按契约失败。 |
| getRepoPermissions | 明确提供功能 | `repo/permissions.ts` 把仓库定义里的 `permission` 折成 push 与 triage 两个布尔（triage = push 或 admin），问不出来就如实失败，不捏造。 |
| listSubIssues | 明确提供功能 | `issues/sub-issues.ts` 先把地图票的字符串票号读成内部数字 id，再翻页取 `state=all` 的票，按票面 `parent_id` 等于这个 id 过滤，并把每个子票的 parentKey 补成地图票号。 |
| ensureLabelColorsFile | 明确不支持 | 与 GitHub、GitLab 同一把尺子：颜色真源在远端标签，工作区里的配色文件没有任何读者，这条能力的后半（改了算数）做不到，属于形态不合。 |
| listMaps | 明确提供功能 | `issues/maps.ts` 服务端按 wayfinder:map 标签筛、内存里再按小写复核，只回 key/title/state/url 四格，按更新时间倒序，撞页数上限挂 truncated。 |
| readBudget | 明确不支持 | `gitee api` 不透响应头，本房今天没有读限额的通道；这是「问不出来」，不是「额度为零」。 |

## 定位口（3 条全部提供）

| 能力 | 登记 | 依据 |
|---|---|---|
| getRepoKey | 明确提供功能 | `model/repo-identity.ts` 只读本地证据：先问 `git remote get-url origin`，再退到 `.git/config` 的 remote 段，解析出 gitee.com 的 owner/name，解析不出回 null。 |
| describe | 明确提供功能 | `index.ts` 里 refId 优先、name 退回目录名，url 只在 refId 是 owner/repo 两段时用默认网页源拼出，host 与默认域名相同时不写。 |
| issueAddress | 明确提供功能 | `room/links.ts` 拼 `https://gitee.com/{owner}/{repo}/issues/{票号}`，票号是 Gitee 的字符串编号（形如 I8A2BC），不拼数字。 |

## 这一房与另外三房不一样的五处

- **票号是字符串**：Gitee 的票号形如 I8A2BC，所有接口路径里的 `{number}` 都用它，房间从不自己拼数字；票面上另有内部数字 id，只在 `parent_id` 这类需要数字的字段里用。
- **父票靠正文兜底**：Gitee 只给父票的内部数字 id，没有 id 到票号的查询端点；个人仓库还会把改票时的 `parent_id` 静默忽略。所以写侧在结构字段没生效时，把关系写成票正文里一行 `上级地图：#票号`；读侧优先认结构字段，读不出来才解析正文，并在票上标出来源（结构 / 正文）。`parentKey` 仍只在 `parent_url` 尾段本身是非数字票号时才从结构字段填——不编一个数字冒充票号，也不把「写动作回了成功」当成边挂上了。
- **阻塞关系靠正文兜底**：Gitee 没有阻塞边端点，`setBlockedBy` 把关系写在票正文末尾的 `## Blocked by` 小节里，条目形如 `- 标题（#票号）`，票号才是判据、标题只供人读；`getDependencies` 从同一处解析，读回来在票上标出来源「正文」。反向的「阻塞了谁」要扫全仓票面，扫不全时如实标「可能不全」。存量票的条目可能是带链接的老写法，读侧照样认。
- **认领人是单值**：契约允许传多人，Gitee 只有 `assignee` 一格；两人以上如实回不支持，不做「只写第一个」的静默降级。
- **读限额没有通道**：CLI 自己会跟 `X-RateLimit-*`，但 `gitee api` 的输出不透出响应头，所以 `readBudget` 登记为按设计不支持，而不是回一个 0。

## 这一批没有接的通道

- **宿主环境检查链与首开引导**：检查目录（`src/shared/tracker/check-catalog-dirs.ts`）与引导步骤（`src/shared/tracker/guide-steps.ts`）里，Gitee 还没有自己的「CLI 装了没有」「登录了没有」「远端仓库可不可达」三行，也没有对应谓词（GitLab 那三行是 `glab:installed` / `glab:authed` / `glab:repoAccess`，谓词注册在 `src/refresh/rooms/host/check-chain-evaluation.ts`）。只加目录行、不加谓词，界面上会直接印出 `predicate not registered`，那正是 #1187 修掉的那种红，所以这一批宁可不接，也不留半条链。代价是 Gitee 工作区暂时看不到「装 gitee CLI」「gitee auth login」这两条引导。
- **引导里的通用步骤也没算上 Gitee**：`GENERIC_CATALOG` 与 `guide-steps.ts` 里几条通用项的 `backends` 数组仍是三房。它们按后端过滤，所以 Gitee 工作区现在拿不到这几步的横幅。下一批接上面那三行时，把通用项的 `backends` 一起补 `'gitee'`。
- **初始化模板**：`package/bundled-skills/` 是上游原文的逐字镜像（`tests/verify-bundled-skills-upstream.ts` 按哈希比对，中文目录 `package/bundled-skills-zh/` 又要求与它逐篇对应），里面加不进第四份 `issue-tracker-gitee.md`。所以 Gitee 的写入约定不落在模板里，而是写进界面词表的 `setup.gitee.backendNote`（`config/copy/panel.yaml`）：第一行固定写 `# Issue tracker: Gitee`，正文按那几条硬事实（`gitee api` 路径从 `/repos/` 写起、票号是字符串、建票与改票在所有者一级、标签是一个逗号分隔串、只有 `closed` 算关闭、没有阻塞端点、子票用数字 `parent_id`）自己写全。

## 变更

- 2026-11-26：`getDependencies` 与 `setBlockedBy` 从「明确不支持」上调为「做了但没做到位」（#11）：Gitee 仍然没有阻塞边的结构字段，改为把关系写进票正文末尾的 `## Blocked by` 小节（条目 `- 标题（#票号）`），读侧从同一处解析并标出来源「正文」；反向的「阻塞了谁」扫全仓票面，扫不全时如实说不全；自阻塞、成环、写不进去、写后读回对不上都如实失败。地图的「只看可接」随之按读回来的被阻塞关系排除被挡住的工单。表头、操作表与上面「阻塞关系靠正文兜底」一条同步改写。
- 2026-11-26：`setParent` 从「明确提供功能」下调为「做了但没做到位」（#8）：个人仓库实测 `parent_id` 会被静默忽略，改为结构字段 + 正文 `上级地图：#票号` 一行兜底，读侧解析并在票上标出来源；建票时带父票也走同一条兜底，挂不上时票照建、票上记下原因。表头与上面「父票靠正文兜底」一条同步改写。
- 2026-11-16：本表随 Gitee 房首次交付落地，按协调者给定的档位逐条登记：20 条操作明确提供功能、4 条操作明确不支持、3 条定位口全部提供。
- 2026-11-16：房间接进装配点与判定顺序（`src/tracker/registry/builtins.ts`、`src/tracker/detection/backendDecision.ts`、`src/tracker/capability-assertions.ts` 与两条门禁同步），`docs/agents/issue-tracker.md` 里写 `# Issue tracker: Gitee` 从此能被认成显式声明（`src/tracker/kernel/issue-tracker-declaration.ts`），界面四个词条 `setup.gitee.*` 落地（`config/copy/panel.yaml` 加 `src/client/kernel/locale-data.ts` 重算）。
