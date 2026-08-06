# EverOS ⇄ Hermes 插件 —— 交接文档

_截至 2026-08-06。写给接手开发的人。设计文档已完成并经源码验证。
本文是桥梁：设计思路的精要、怎么开发和测试、怎么发版。_

---

## 1. 现状快照

- **已完成：** 调研（Hermes 插件体系、8 个树内竞品 provider、上游政策）、
  四份设计文档（完整/简化——结构统一、无漂移）、所有接口论断
  **已对照 Hermes 源码 HEAD 逐一钉死**（`agent/memory_provider.py`、
  `hermes_cli/memory_setup.py`、`hermes_cli/plugins_cmd.py`、
  `plugins/memory/query_rewrite.py`）、全部设计决策已关闭、开发机已装好
  Hermes（Quick Setup / Nous Portal / 本地 terminal backend）。

## 2. 设计思路，一页讲完

**它是什么：** 一个原生 Hermes 记忆 provider——一个 Python 类
（`EverosMemoryProvider`），架在 EverOS 本地 HTTP API 之上。Hermes 用一条
专用 pipeline 驱动它；我们只实现方法，循环归宿主：
**召回 → 对话 → 捕获 → 封存**。

**每个决策背后的原则：**

1. **镜像 EverOS——不发明任何东西。** 插件只转发；一切智能（抽取、存储、
   排序、模型）都在 EverOS。凡是想往插件里加的"聪明功能"，多半应该放进
   EverOS，或者干脆不做。
2. **永远 fail-open。** EverOS 宕/慢 → 每个方法安静地什么都不做；召回
   ~5 秒后返回 `""`。记忆后端绝不能弄坏一场对话。逐方法落实，不靠全局。
3. **一个大脑，多个 agent。** 同一个未改动的 EverOS 服务（默认
   `127.0.0.1:8000`）同时服务 OpenClaw 和 Hermes，按 `app_id`
   （`"hermes"` vs `"openclaw"`）分区。因此**走 HTTP，绝不 `import everos`**
   （进程内会把存储割裂；OME 引擎按锁单实例；进程隔离能兜住崩溃）。

**没有新证据就不要翻案的决策：**

- **零 tool**（`get_tool_schemas() → []`）：召回每回合自动（`prefetch`），
  捕获回合后自动（`sync_turn`）。模型永远不需要"记得去记"。这也是市场
  差异点（各家竞品 provider 都带 2–5+ 个 tool）。
- **detect-then-provision** 在 `initialize()` 里，daemon 线程：健康检查 →
  已装则启动 EverOS（强制 `EVEROS_MEMORIZE__MODE=agent`，让一条 `/add` 流
  同时喂两条 track）→ 未装则引导 `everos init`。
- **与内置记忆并存并 mirror**：Hermes 的 `MEMORY.md`/`USER.md` 保留；
  `on_memory_write` 把其编辑转发到 `/add`（上等策展事实；EverOS 去重）。
- **捕获完整轨迹**：`sync_turn` 可选的 `messages` 参数带 tool 调用/结果——
  喂 agent track（case + skill）。回退 `messages or [user_content,
  assistant_content]` 兼容旧版 Hermes。
- **每种结束都封存**：`on_session_end`、`on_pre_compress`（flush 后
  `return ""`——它返回的是给压缩摘要的*字符串*）、`shutdown`（flush + 只停
  自己拉起的 EverOS）、`on_session_switch`（更新缓存的 `_sid`；
  `reset=True` 时先 flush 旧的）。
- **`on_delegation`**：把每次 subagent 的任务+结果对转发到 `/add`
  （child 转录留在 Hermes 的 SQLite SessionDB；child 以
  `skip_memory=True` 运行）。
- **加权 query 截断**：`query_max_units`（默认 500）——CJK/全角字 = 2
  单位，其余 = 1，用标准库 `unicodedata.east_asian_width`。只在回退路径
  触发（正常路径 Hermes 会先把 query 改写成一句 ≤320 字符的英文问句——
  `plugins/memory/query_rewrite.py`）。
- **防注入加固在 `render` 里**：召回文本加围栏、标注为*不可信历史数据*、
  中和围栏仿冒 token——从 OpenClaw 插件**逐字**移植。

**ID 映射（召回必须与捕获一致，否则搜索为空）：**
`app_id="hermes"`（常量）· `project_id` = profile/cwd · user track =
配置的 `user_id`（默认 `$USER`）· agent track = 常量 `agent_id`
（默认 `"hermes"`）· `session_id` 来自 pipeline。

## 3. 产物地图

```text
EverMind-AI/plugins
├── openclaw/               已发布的 OpenClaw 插件（TS）—— 已验证的先例
└── hermes/
    ├── docs/
    │   ├── DESIGN_DOC.md
    │   ├── DESIGN_DOC_zh.md    设计规格（本套）
    │   ├── HANDOFF.md
    │   └── HANDOFF_zh.md       本文档
    └── （插件代码落在这里：plugin.yaml、__init__.py、client.py、
        provision.py、cli.py、README.md、tests/）
```

EverOS 服务本体在 [`EverMind-AI/EverOS`](https://github.com/EverMind-AI/EverOS)。

## 4. 开发计划

文件布局（主文档 §3.4）：`plugin.yaml`、`__init__.py`（provider +
`register(ctx)`）、`client.py`、`provision.py`、可选 `cli.py`、
`README.md`、`tests/`。

顺序：

1. **先做两个现场检查**（用一个 stub 插件，各 ~5 分钟）：
   `hermes plugins install <repo>/<子目录>` 是否真的落到
   `~/.hermes/plugins/memory/<name>/`；stub 是否出现在
   `hermes memory setup` 的选单里。
2. **写 `implementation-contract.md`**——主要是抄录已钉死的事实。
   顺手核对 MemoryManager 调用点
   （`prefetch_all`、`_prefetch_provider` 的线程写法、`queue_prefetch_all`）。
3. **`client.py`**——薄 HTTP：`/health`、`/search`、`/add`、`/flush`。
   从 OpenClaw 移植：URL 规范化、超时、逐调用 fail-open。
4. **`render`**——两 track 块 + 注入围栏。**逐字**移植。
5. **`provision.py`**——detect-then-provision 状态机（venv 启动命令、
   引号路径、`EVEROS_MEMORIZE__MODE=agent`、端口强制）。
6. **provider 类**——严格按 §3.5 草图的方法面。
7. **测试**（见下），然后现场验证（见下）。

已钉死的契约事实（不要重新推导）：`is_available()` 不得有任何网络调用；
`sync_turn` 不得阻塞（daemon 线程）；`initialize` 的 kwargs 必含
`hermes_home` + `platform`，可能含 `agent_context`
（`"primary"`/`"subagent"`/`"cron"`/`"flush"`——**非 primary 时跳过写入**）、
`agent_identity`、`user_id`（gateway）；配置流为 `get_config_schema()` →
向导 → `save_config(values, hermes_home)`（`post_setup` 是鸭子类型的
全权委托备选，我们不用）。

## 5. 怎么测试

**单元测试（不需要 Hermes、不需要 EverOS）：** 一个驱动 provider 的
假运行时 + 一个 stub EverOS HTTP 服务（或记录式假 client）。契约点即
测试清单：

- `is_available()` 零网络 I/O（断言无 socket）。
- `initialize()` 立即返回（provision 在 daemon 线程）。
- `prefetch()`：两个 owner 维度搜索，`app_id`/`project_id` 一致；超时/
  出错/为空 → 返回 `""`；渲染块带不可信数据围栏；记忆内容里的围栏仿冒
  token 被中和。
- 加权截断：纯英文 500 字符不动；CJK 约 250 字截断；混合用例；
  只在回退（原始消息）路径生效。
- `sync_turn()`：HTTP 完成前就返回；有 `messages` 用 `messages`、没有则
  回退到两条文本；每条 track 的 sender id 正确；
  **`agent_context` ≠ primary 时不写**。
- 封存：`on_session_end`/`on_pre_compress` flush 的是*当前* `_sid`；
  `on_pre_compress` 返回 `""`；`on_session_switch(reset=True)` 先 flush
  旧 sid 再切换；`shutdown` 只停自己拉起的 EverOS。
- `on_memory_write` / `on_delegation` 产出合规的 `/add` 载荷。
- 以上全部在"服务已死"下重跑：任何方法都不许漏异常。

**现场验证——后端回执纪律**（聊天层面"它记得吗"的演示有混淆因素；
只认 EverOS 侧回执）：

1. 全新 `$HERMES_HOME`，装插件，`hermes memory setup` → 选 `everos`，
   `hermes memory status`。
2. 聊几个回合 → **看 EverOS 侧**：`/add` 载荷带正确 id 到达；退出/重置
   触发 flush；`~/.everos/`（hermes 子树）出现 markdown；下一回合的召回块
   可回溯到已存记忆。
3. 跨宿主检查：同时跑 OpenClaw 打同一个服务；确认 `app_id` 分区
   （搜索结果无串味）。
4. 盯 OpenClaw 现场测试发现的两个已知坑：长时间运行的 EverOS 搜索延迟
   劣化到超过 5 秒 cap；重启时的 OME 锁交接竞态。

## 6. 怎么发版

1. **代码评审 + 测试全绿**，在 monorepo（`EverMind-AI/plugins`，子目录如
   `hermes/`）。沿用 OpenClaw 插件的约定。
2. **递增 `plugin.yaml` 的 `version:`**（semver 标签；仅供人看）。
   `manifest_version: 1` 不动，除非 Hermes 改插件格式。
3. **README 义务**（Hermes 惯例）：写清*到底哪些数据离开设备*
   （`sync_turn` 载荷 → EverOS 配置的 LLM/embedding 服务）、安装命令、
   更新注意事项、以及一次性 EverOS 设置（`everos init` + 密钥填
   `~/.everos/everos.toml`）。
4. **打标/合入 main。** 用户安装：
   `hermes plugins install EverMind-AI/plugins/<子目录>`——子目录安装是
   原生支持的。**更新注意：** 子目录安装不带 `.git`，
   `hermes plugins update` 会拒绝——用户重跑安装命令即升级。写进 README。
5. **之后可选：** PyPI 渠道（`hermes-everos`，带 `hermes_agent.plugins`
   entry point 和/或安装 shim CLI，参照 `hermes-memori`）——获得真正的
   包版本化与 `pip` 升级。
