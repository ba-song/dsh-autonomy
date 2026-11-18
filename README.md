# dsh-autonomy · 生活插件

> 她除了回话，也可以有自己的生活：驱动力、目标、自己的家（home 会话）、主动行动、学习、邮件。
> 本插件不定义「她是谁」（dsh-persona-core），也不保存记忆正文（dsh-memory-core）；它管状态、节奏、行动与审计。

## 1. 定位

| 管 | 不管 |
|---|---|
| 驱动力（好奇/社交/精通/照顾）涨落、目标、行动目录 | 人格、语气、身份（persona） |
| home 影子会话：创建/恢复/轮换/自愈/唤醒循环/骰子 | 记忆正文、日记文件、联系人（memory） |
| 抖音私信路由：主人 → home，所有非主人 → 统一会话（总接待室，不占 home 上下文） | 抖音协议与 dm 事件读取（dsh-douyin 的只读 watcher） |
| 主动行动（手动工具 + 自驱练习 + 邮件） | QQ / 抖音协议（channel-bridge） |
| 审计、暂停、状态、日志、通知 | 宿主 agent/session/timer 的实现 |

关键原则：**建议不等于执行**。tick 的自动执行器目前全是 mock/演练；真实写文件、发邮件只在她主动调用工具时发生。

## 2. 工具清单

所有 `dy_life_*` / `dy_mail_*` / `dy_logs` 默认 **owner/home 会话**可用；普通群/陌生人调用会被门禁拒绝。

### 2.1 状态与暂停

- `dy_life_status()`：无参数，只读返回驱动力、目标、最近行动、反思、配额、暂停、home 状态、`suggestion`、`mail`；不执行行动、不扣配额。
- `dy_life_pause({scope, kind?, on?, until?, by?})`：
  - `scope`: `all` | `kind` | `dry_run`；`kind` 在 `scope=kind` 时必填。
  - `on` 默认 true；`until` 为 Unix 毫秒；写 `meta.pause.*`，重启后仍有效。

### 2.2 目标

| 工具 | 参数 | 说明 |
|---|---|---|
| `dy_life_goal_add` | `title, note?, priority?(0..1), kindHint?, dueAt?` | 新建 open 目标 |
| `dy_life_goal_list` | `status?(open/doing/done/dropped/blocked/all), limit?` | 列目标 |
| `dy_life_goal_done` | `id, note?` | 终态、幂等 |
| `dy_life_goal_drop` | `id, note?` | 放弃，只改状态不删数据 |

### 2.3 主动行动（她手动调用才执行）

`dy_life_action_run({kind, reason?, text?, goalId?, channel?})`
- `kind`: `read_archive` / `write_diary` / `organize_memory` / `find_sticker` / `browse_douyin` / `send_qq`。
- `goalId` 必须是 open/doing，否则 `GOAL_NOT_FOUND/GOAL_CLOSED`。
- 过 pause + 防刷屏（同 kind 10 分钟、每小时 20、每天 200；可配）。
- 真实执行：读档案/只读整理/saveDiary；无表情包/外部通道返回 `UNAVAILABLE`，不假成功。
- 返回 `{ok,kind,evidence,episodeText?,result?,actionId}`；结果写 `actions` + `evidence_json`。

`dy_life_reflect({text, importance?, goalId?})`
- 写 `reflections(status=done)`，消费一条 pending；正文 ≤500 字；空文本 `EMPTY_TEXT`。
- 审计 `action_log(event='reflection')`，不记正文。

### 2.4 home 与旧房间

| 工具 | 参数 | 说明 |
|---|---|---|
| `dy_life_home_status` | 无 | home_sessions 行、tokens/轮换/卡死/队列/骰子/邮件摘要；不含对话正文 |
| `dy_life_home_awake` | `reason?` | 手动叫醒；走 enabled→pause→dryRun→单飞/忙门 |
| `dy_life_home_rotate` | `reason?` | 手动轮换：seed 最近 50 条 + 结构化简报 + handoff + `home.agentPreset`；旧会话留档；忙时拒绝 |
| `dy_life_room_list` | 无 | home_rooms 最近 10 个：session 前缀/时间/来源/档案首末摘要 |
| `dy_life_room_read` | `sessionId, limit?(1..50)` | 只读该旧房间最近 N 条 user/assistant，每条截断 200 字 |

### 2.5 日志

`dy_logs({name?, lines?, grep?, since?})`
- `name`: `web` / `bridge` / `bridge-outbox` / `memory` / `home` / `autonomy` / `list`（默认 list）。
- `lines` 默认 50、上限 200；`grep` 子串；`since` ISO，按行首时间尽力过滤。
- 只读白名单；无文件 `NO_LOG`；非法 name `BAD_NAME`；每行截断 500 字。

### 2.6 邮件

- `dy_mail_send({subject?, body})`：只发白名单 `MAIL_TO`；默认不限流（可配）；body 走 stdin；审计只记 to/subject_len，不记正文。
- `dy_mail_reply({body, subject?})`：回复最后一封主人邮件，To=该邮件 From（必须 owner）；Subject 默认 `Re: <原标题>`；带 `In-Reply-To/References`；正文 ≤5000；失败不重试。
- `dy_mail_poll()`：手动补拉一次 IMAP（按 UID 游标），用于定时器异常。

### 2.7 学习与兴趣

- `dy_life_practice({topic?, note?, minutes?})`：在 `practiceDir` 同名/模糊匹配 `.md`；无 topic `NO_TOPIC` + 主题列表；追加 `练习-YYYY-MM-DD.md`（时间/topic/材料/minutes/note≤500）；不调模型、不写记忆库。
- `dy_life_interest({action, topic?, note?, source?})`：`add/list/drop`；add 默认 `source=self`，owner 建议可传 `source=owner`（不强制练）；drop 只写 `dropped_at`，不删行。
- `dy_life_diary_append({text,title?,mood?,tags?})`：安全追加日记到 memory 插件配置的日记目录（见 dsh-memory-core 配置）；只 append、不覆盖、不调 `saveDiary`；每条带 `## HH:MM:SS`，正文≤20000，owner/home。

## 3. 服务

### dyHome
- `version`、`isHomeSession(sessionId)`、`status(personaId?)`、`deliver(payload)`。
- `deliver({channel, kind='private', contactId, contactName, text, at, messageId, handoverText?, priority?})`：
  - 串行 owner/normal 队列；owner 优先、FIFO；忙时排队（上限 `home.deliveryQueueMax`）。
  - `kind='group'` → `E_GROUP_NOT_UNIFIED`；`priority='owner'` 由桥传入。
  - 返回 `{ok, queued?, delivered?, code, position?, priority?, firstInSession?}`；**只有 followup 成功才 delivered=true**。
  - 失败重试 3 次后进 `failedDeliveries` + `E_DELIVER_FAILED`；排队超时 `E_DELIVER_TIMEOUT`。

### dyMail
- `send({to, subject?, body})`：`to` 必须在 owner 集合；默认主题「汐的邮件」；body ≤5000。
- `reply({body, subject?})`：复用 lastOwner + 引用头。
- `ownerAddresses()`：当前 owner 地址（小写）。
- 邮件禁用/缺 env 时服务仍存在，返回 `MAIL_DISABLED`/`MAIL_ENV_MISSING`。

### 抖音私信路由（douyinInbox，2026-11-14，v4 统一「总接待室」）

`lib/run/douyin-inbox.js`。事件源只读：`ctx.get('dyDouyin')` 的
`dmWatchSubscribe(fn)`（优先）/ `dmWatch({action:'poll'})`（退回轮询）/ `dmWatchStatus()`；
`dsh-douyin` 的 watcher 只给会话列表事件，**不打开会话、不标已读、不发送**。

- **主人事件**（`owner/isOwner=true`，owner 标记由宿主/persona 配置决定）→ `dyHome.deliver({channel:'douyin', kind:'private', contactId, contactName, text, priority:'owner', messageId})`；
  **不另开会话**，home 的暂停/dryRun/去重/队列/轮换闸门全部照旧（它自己判）。
- **其他联系人事件** → **统一进一个抖音会话**（统一「总接待室」，维护决定；不按联系人拆会话）：
  - key 固定 `douyin:others`，cwd 由 `douyinInbox.cwd` 配置（不再拼联系人子目录），
    目录必须落在 `douyinInbox.cwdRoot` 白名单内；
  - 消息按**到达顺序**以 `user` 投进同一会话；每条消息的 `source` 保留该事件自己的
    `conversationId` / `contactName`（自动回复精确回到对应私信，不同联系人绝不串）；
  - 会话解析顺序照 QQ 标准：内存缓存（宿主仍活）→ `agents.get(prevId)` live → `agents.resume` → 最后才 `agents.create`；
    新建/恢复都必须带 `agentOptions:{provider,model}`（模型取 `agentDefaultModel.currentSelection()`），
    预设走 `agentPresets.mount`（`agentPreset` 可配），可选 `denyTools` 用 `tools.restrict({deny})` 裁工具面（fail-open）；
  - **不调 `home.deliver`**，home 上下文完全隔离；不登记 workspace（GUI 不显示）；
  - 指针在 `autonomy.db` 的 `douyin_sessions` 表（统一会话一行：`session_id`/`prev_session_id`/`cwd`/`messages`）；
    resume 失败 → 新建接管，旧 id 写 `prev_session_id`（并记 `meta['douyin.inbox.replacedFrom']`）。
- **首轮基线不投**：第一次成功轮询只记 seen；**同一事件去重**：优先 `event.id`，无 id 时
  `conversationId + dedupeKey`（跨联系人相同指纹不误判）；seen 集合落 `meta['douyin.inbox.seen']`（跨重启也去重），
  订阅+轮询双通道重复也只投一次。
- **非主人自动回复**（QQ auto 标准，v3/v4）：每条入站事件进入待回复队列（保留自己的 `conversationId`）；
  宿主的 `session/event`（assistant/message + turn/end）或兜底轮询 `agent.session.log`（`reply.pollMs`）到回合结束后，
  取**最后一段 `type:'text'` 分块**，按待回复事件**各自动 conversationId 分别**调
  `ctx.get('dyDouyin').dmSend({conversationId, text, confirm:true})`。
  - **一个入站事件最多回一次**：回合结束发完即清队列；同一 conversationId 一轮只发一条；重复 `turn/end` 无效。
  - **同一回合多个联系人**：即使只有一段文本，也按各事件的 conversationId 分别发（不只回第一条、不串目标）；
    某个目标失败/未验证不影响其他目标；失败不重试。
  - **只发 text 分块**：reasoning/tool 分块一律不发；`[SILENT]`、空文本、tool-only、错误回合不发。
  - 回合 180s 不结束 → 超时整批不发；目标只用事件 `conversationId`（没有 id 跳过 `NO_CONVERSATION_ID`，不按昵称猜）。
  - 发送前仍过 `enabled`/`pause.all`/`respectDryRun` 闸门（不绕过暂停）；不经过 home、不占 home 队列。
  - `verified` 结果记 `status().douyinInbox.replies.last.targets` 与 `meta['douyin.inbox.last'].replies`（只记 chars/textHash，不记正文）。
- **通知事件源**（dyDouyin `notifyWatchSubscribe(fn)` / `notifyWatchStatus()`，事件 `{id, actor, type, text, time, ageMs, isOwner, replyable}`）：
  - `isOwner=true` → `home.deliver`（priority=owner，`messageId='notify:<id>'`）；
  - 其他 → **同一个统一会话** `douyin:others`；消息 `source` 保留 `notifyId/actor/notifyType/replyable`；
    **同一条通知只投一处**（owner home / 非 owner 会话，二选一），不会既投 home 又投会话；
  - **通知只做“投入会话/提示”，不自动回复、不拿它发私信**（通知没有 conversationId；需要回复时由主人/工具按稳定 id 精准回复，
    `replyable=true` 时消息文本会带 `[通知id: …]`）；
  - **首轮基线不投**：`notifyWatchStatus().primed === false`（源还没建好基线）时只记 seen、不投，源就绪后恢复；
  - **去重按事件 id**（无 id 时 actor+type+text+time 兜底），与私信 seen **分开存**（`meta['douyin.inbox.notifySeen']`），
    同一字符串 id 在私信/通知两条通道不算重复；
  - **缺少 `notifyWatchSubscribe` 时明确降级**：`status().douyinInbox.notify` 给出 `supported=false / lastErrorCode='NOTIFY_UNAVAILABLE'`，
    每 `attachRetryMs` 重试等 API 上线；私信路由/自动回复完全不受影响。
- **fromMe**（她自己用 web 发的消息）默认跳过（`douyinInbox.skipFromMe=false` 可关）。
- **环境不具备**：无 `dyDouyin`/无 `dmWatch`、无 `agents`、无默认模型、cwd 越界 → 明确返回
  `{ok:false, code:'UNAVAILABLE', reason:'SERVICE_UNAVAILABLE'|'AGENTS_UNAVAILABLE'|'NO_MODEL'|'HOME_UNAVAILABLE'|'CWD_UNAVAILABLE'|...}`，
  同时记 `status().douyinInbox.stats.failed/lastError` 与 `meta['douyin.inbox.last']`，不静默丢。
- **不抢 home**：不改 home 的聊天闸门/轮换/骰子；非主人消息不触发 home 任何路径；主人消息只走 `deliver` 这一条既有入口。
- 可观测：`api.douyinInboxStatus()` / `dy_life_status().douyinInbox`（`sessions.active` 恒为 0/1，
  `replies.pending/pendingTargets` 给待回复事件数与会话数，`notify` 给订阅状态/去重/基线计数；`last` 不含正文）；手动 `api.pollDouyinInbox()`。

> 生效条件：profile 里 `autonomy.config.douyinInbox.enabled=true`（默认 false；由维护者配置并重启生效）。
> `dsh-douyin` 侧需启用其 watcher（见 dsh-douyin 配置）；通知事件源需要新版 dsh-douyin 提供
> `notifyWatchSubscribe/notifyWatchStatus`，未提供时按上面「明确降级」处理，不影响私信。
> 轮换/TTL（QQ 的 `rotation`/3 天归档）暂未接，属后续阶段。

## 4. 主要配置默认值

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 插件总开关 |
| `dryRun` | true | 演练；tick 不调真实执行器 |
| `tick.enabled` | true | tick 独立开关；false 不影响 home |
| `sendEnabled` | false | 真实外发总闸（QQ/抖音） |
| `home.enabled` | false | home 家开关 |
| `home.minIntervalMin/maxIntervalMin` | 120/240 | 唤醒间隔 |
| `home.startupDelayMs` | 15000 | 启动补醒延迟 |
| `home.chatIdleMin` | 5 | 聊天活动闸门：最后一条 user/assistant 消息或渠道入站后，至少空闲 N 分钟才允许骰子/自主唤醒；0=关 |
| `home.agentPreset` | `standard` | 新建会话 preset；空=不带 |
| `home.respectDryRun` | true | dryRun 时 home 不醒 |
| `home.contextLimit/rotateRatio` | 500000/0.7 | 500k 或 70% 轮换；到线在**回合结束**量 |
| `home.turnRotateDelayMs` | 1500 | 回合结束后延迟多久量一次（0=立即；有主人在等/投递中/回合未收尾则跳过，等下一回合） |
| `home.dice.enabled` | false | 骰子自主唤醒 |
| `home.dice.baseChance/bonusPerMiss/maxBonus` | 0.55/0.15/0.45 | 命中率/没中加成 |
| `home.dice.peakHours/peakChanceDelta` | 9–12,14–18 / -0.15 | 峰时降低命中 |
| `home.dice.quietHours` | 00:00–08:00, enabled=false | 夜间静默（只挡骰子） |
| `home.nudge` | enabled true / minDrive 0.6 / goalBonus 0.15 | 唤醒建议 |
| `home.deliveryTimeoutMin` | 10 | 投递排队超时 |
| `home.deliveryQueueMax` | 50 | 投递队列上限 |
| `douyinInbox.enabled` | false | 抖音私信路由总开关（主人→home，所有非主人→同一个抖音会话） |
| `douyinInbox.mode` | auto | auto=优先订阅 dmWatch、退回轮询；subscribe=只订阅；poll=只轮询 |
| `douyinInbox.pollMs/attachRetryMs` | 3000/5000 | 轮询间隔 / 服务晚到时的重试间隔 |
| `douyinInbox.cwd` | 由配置指定 | 统一会话 cwd（不再按联系人拆子目录） |
| `douyinInbox.cwdRoot` | 由配置指定 | cwd 白名单根；越界返回 `CWD_UNAVAILABLE` |
| `douyinInbox.agentPreset` | `''` | 统一会话的 preset；空=宿主默认 |
| `douyinInbox.denyTools` | `[]` | 可选：会话里裁掉的工具名（同 QQ `tools.restrict` deny，fail-open） |
| `douyinInbox.limit/maxSeen` | 20/1000 | 单轮取事件上限 / 去重集合上限 |
| `douyinInbox.skipFromMe` | true | 她自己用 web 发出的消息不投 |
| `douyinInbox.respectDryRun` | true | dryRun 时不建会话（不花模型调用） |
| `douyinInbox.reply.enabled` | true | 非主人自动回复（QQ auto 标准；owner 永不走这条） |
| `douyinInbox.reply.maxChars` | 500 | 单条回复上限（dmSend 上限 500；超长截断，只发一条） |
| `douyinInbox.reply.timeoutMs` | 180000 | 回合迟迟不结束：超时不发、不重试 |
| `douyinInbox.reply.pollMs` | 1000 | push 事件漏收时扫 `agent.session.log` 的兜底间隔 |
| `douyinInbox.notify.enabled` | true | 通知事件源开关（owner 通知→home；其他→统一会话；只投递不自动回复） |
| `practice.curiosityThreshold/energyMin` | 0.6/0.3 | 自驱练习阈值 |
| `mail.enabled` | true | 邮件通道 |
| `mail.envFile` | 由配置指定 | 凭据文件；不写代码/日志 |
| `mail.pollSeconds` | 300 | IMAP 轮询 |
| `mail.minGapSec/maxPerHour` | 0/0 | 0=发件不限流 |
| `mail.maxBody` | 8000 | 入站正文截断 |
| `mail.replyHint` | false | 入站回信提示（默认无） |
| `mail.ownerAddresses` | 空数组（公开默认） | owner 邮箱列表；与 MAIL_TO 合并；生产在本地 profile 配置 |
| `quietHours` | enabled=false | D-007 后默认不静默 tick |
| `ownerActiveEnabled` | false | 主人在场跳过默认关 |
| `antiSpam` | 10min/20 每小时/200 每天 | 唯一保留的防刷屏 |
| `allowedKinds` | read_archive, organize_memory | tick 候选 |
| `model.dailyCap` | null | 默认不限 |

完整默认值见 `lib/config.js`。

## 5. 数据、日志与凭据

- 数据库（`dataDir`/`dbPath` 配置，默认见 `lib/config.js`）：`meta`、`drives`、`goals`、`actions`、`action_log`、`tick_runs`、`reflections`、`home_sessions`、`home_rooms`、`douyin_sessions`、`interests`。
- 抖音路由状态：`meta['douyin.inbox.seen']`（私信去重键：id 或 conversationId+指纹）、`meta['douyin.inbox.notifySeen']`（通知去重键，独立一份）、`meta['douyin.inbox.last']`（计数/最后错误/`replies`/`notify` 统计：sent/failed/skipped/timeout + last.targets（各 conversationId 的 ok/verified）/chars/textHash，**不含正文**）、`meta['douyin.inbox.replacedFrom']`（resume 失败后新建的留档）；会话指针在 `douyin_sessions`（**`key='douyin:others'` 一行**：`session_id`、`prev_session_id`、`cwd`、`messages`）。
- 生活日志：数据目录下 `logs/autonomy.log`（>5MB 轮转 `.1`）。
- 投递日志：数据目录下 `home/deliver.log`。
- 学习材料/练习：数据目录下 `学习/*.md`、`练习-YYYY-MM-DD.md`。
- 邮件凭据：由 `mail.envFile` 指向的 env 文件提供（0600；SMTP_USER/SMTP_PASS/MAIL_TO），不写入仓库。
- 轮换交接：数据目录下 `home/记忆区/压缩记忆/home-*.md`；档案修复备份 `*.bak-<ts>`。
- 日志清理备份：数据目录下 `logs/备份/clean-test-fixtures-*`。

## 6. 典型用法

1. **她醒来自己决定做什么**：home 唤醒 → 状态卡 + nudge 建议 → 她自己调 `dy_life_action_run` / `dy_life_practice`；系统不替她执行。
2. **主人看状态**：`dy_life_status()` 看驱动力/目标/行动/建议/邮件；`dy_life_home_status()` 看家和队列。
3. **补拉邮件**：`dy_mail_poll()`；她可在 home 用 `dy_mail_reply`，或桥用 `dy_say channel:'email'` 回复。
4. **换房**：阈值自动或 `dy_life_home_rotate({reason})`；旧提醒迁移到新家，旧会话进 `home_rooms`。
5. **暂停主动行为**：`dy_life_pause({scope:'all'})`；`scope:'kind'` 只停某类；`scope:'dry_run'` 切演练。

## 7. 边界与停止方式

- **会真执行**：手动 `dy_life_action_run`（读档案/只读整理/saveDiary）、`dy_life_practice` 写练习记录、`dy_mail_send/reply` 真发邮件、home 轮换/自愈、`douyinInbox.enabled` 时的抖音私信路由（主人消息进 home；所有非主人按到达顺序进统一会话，消耗模型调用）**以及非主人自动回复**（回合结束把最后一段文本经 `dyDouyin.dmSend(confirm:true)` **真发**回各入站事件的 conversationId；一事件最多一次，同一回合多联系人分别发，失败/错误/空文本不重试）。
- **只记录/dry-run**：tick 默认真实执行器是 mock；`dryRun=true` 时 home 不醒、tick 不真执行、抖音统一会话不建、自动回复也被闸门挡下（不发送）；
- **不会做**：不删记忆库、不直接写 `memory.db`、不发 QQ、不替她调用行动工具；抖音只在「非主人私信 → 统一会话 → 按事件 conversationId 回复」这一条自动回复路径外发，且不带推理过程。
- **通知只提示不回复**：通知事件只投 home/统一会话（source 带 notifyId/actor/type/replyable），不挂自动回复、不拿通知发私信；要回复仍由主人/工具按稳定 id 精准操作。
- 停止：`dy_life_pause({scope:'all'})` 停自主行动；`home.enabled=false` 停家；`enabled=false` 停插件（需重启生效）；`dy_life_home_rotate` 只换房不删旧档。
- 忙/卡死：home 忙时 `awake/deliver` 返回 `BUSY/IN_FLIGHT/OWNER_PENDING/STUCK_TURN`；卡死只拒绝新回合，不杀宿主/不自动重建。

## 8. 环境要求

- **Node.js >= 24**（`package.json` 的 `engines` 字段；使用内置 `node:sqlite`）。
- **DSH 宿主**：提供 `tools`、`timer`、`agents`/会话等宿主服务；插件通过宿主配置加载。
- **宿主依赖 `@deepseek-ai/schemastery`**：用于配置 schema，由 DSH 宿主提供；不在本仓库 `dependencies` 中，运行时无需 `npm install` 安装。
- **可选协作插件**（缺失时降级，不崩溃）：
  - `dsh-persona-core`：提供 `dyPersona`（self_id、人格、情绪）；
  - `dsh-memory-core`：提供 `dyMemory`（episode 写入/召回，契约 v1.2）；
  - `dsh-douyin`：提供 `dyDouyin` 的只读私信/通知 watcher（可选集成）。

> 不同 DSH 版本的插件放置与注册方式可能不同；以下为通用方式，若宿主提供插件管理界面，以宿主说明为准。

## 9. 安装与注册

1. 获取源码（`git clone <repo>`），放到宿主配置的插件目录（记为 `<plugin-dir>`）；保持 `package.json` 在插件根目录。
2. 运行时不需要 `npm install`：本插件没有第三方运行时依赖，仅依赖宿主提供的模块。
3. 注册插件（**只注册一次**）：
   - 方式 A（profile 的 `cordis.patch.yml`）：
     ```yaml
     - insert:
         - id: autonomy
           name: dsh-autonomy
     ```
   - 方式 B：宿主支持插件 bundle 时，使用 `package.json` 已声明的 `dsh.bundle.patch`（`./cordis.patch.yml`）注册；不要重复 insert。
4. 重启宿主使插件加载（由部署者执行）。

## 10. 配置示例

配置由宿主 profile 传入（插件名 `dsh-autonomy`），默认值见 `lib/config.js`。示例中的值均为占位，请勿把真实地址/凭据提交到仓库：

```yaml
- id: autonomy
  name: dsh-autonomy
  config:
    enabled: false          # 总开关
    dryRun: true            # 演练：tick 不调真实执行器
    tick:
      enabled: true
    home:
      enabled: false
      cwd: "<home 会话工作目录>"
      minIntervalMin: 120
      maxIntervalMin: 240
    mail:
      enabled: true
      envFile: "<邮件凭据文件路径>"
      ownerAddresses:
        - "<owner-email>"
```

- **`mail.ownerAddresses`**：owner 邮箱列表，用于收件 owner 判定、`dyMail.reply` 与 `dyMail.send` 白名单；会与凭据文件中的 `MAIL_TO` 合并。公开默认值为空数组；真实地址只写入本地 profile。
- **邮件凭据**：由 `mail.envFile` 指向的 env 文件提供 `SMTP_USER`、`SMTP_PASS`、`MAIL_TO`（建议 0600）；不写入代码、日志或仓库。
- **数据目录**：`dataDir` / `dbPath` 可配置；默认值见 `lib/config.js`。SQLite 数据库属运行数据，不要提交到仓库；测试可用 `DSH_AUTONOMY_DIR` 指向临时目录。

### 邮件功能的宿主环境依赖

邮件功能不是由本插件在内部完整实现 SMTP/IMAP，而是通过宿主环境提供的外部邮件执行程序完成：

- 需要 **Python 3** 运行环境（插件通过 `python3` 调用脚本）。
- 需要两个功能入口：
  - **发送脚本**（约定名 `sendmail.py`）：负责 SMTP 发信；
  - **轮询脚本**（约定名 `mail-poll.py`）：负责登录 IMAP 收取新邮件，并按行输出插件可消费的 JSON 结果。
- 插件调用脚本时传入：环境文件路径、主题与收件人（发送）或 UID 游标（轮询）；发送正文通过标准输入传递。
- 凭据文件（由 `mail.envFile` 指定）中的 `SMTP_USER`、`SMTP_PASS`、`MAIL_TO` 由外部脚本读取；插件自身读取 `MAIL_TO` 用于 owner 集合判定。
- 运行环境还需要：正确的 SMTP 账户与授权信息；插件进程对外部脚本与凭据文件的执行/读取权限。
- 缺少 Python 3 或外部脚本时，邮件功能无法正常运行；不启用邮件功能时，插件其他功能不受影响。
- 公开仓库只提供插件代码与脚本接口约定，不包含、也不承诺提供任何特定部署环境的私有邮件脚本；具体脚本由部署环境提供，路径需与插件内置约定一致（以源码为准）。

## 11. 测试

```bash
npm test
```

- `package.json` 的 test 脚本为 `node --test tests/*.test.mjs`。
- 测试需要宿主提供的 `@deepseek-ai/schemastery`，以及测试用的 `yaml`；请确保它们在 Node 的解析路径中（例如在 DSH 宿主环境内运行，或将宿主提供的这两个包链接到本地 `node_modules`）。
- 集成测试会尝试使用 `dsh-memory-core`；若同机没有该插件，会 **skip** 而不是失败。
- 建议用隔离数据目录，避免碰运行数据：
  ```bash
  DSH_AUTONOMY_DIR="$(mktemp -d)" npm test
  ```
- 测试不写生产数据库、不写生产 profile。

## 12. 许可证

MIT（见 `package.json` 的 `license` 字段）。
