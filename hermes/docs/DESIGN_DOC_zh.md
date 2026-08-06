# Hermes Memory — EverOS —— 面向 Hermes Agent 的原生记忆 provider

本文分为三部分：**第一部分**描述 Hermes Agent 是什么以及其插件如何工作；**第二部分**梳理 Hermes 的内置记忆与现有的外部记忆 provider；**第三部分**给出 Hermes Memory — EverOS 原生记忆 provider 的设计。

> 与 [OpenClaw 插件](../openclaw/) 配套——同一个 EverOS 后端同时服务两个宿主。

---

## 第一部分 —— Hermes Agent 及其插件简介

### 1.1 Hermes Agent 是什么

Hermes Agent 是 Nous Research 出品的开源、自托管个人 AI agent（[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)）。它作为一个 **Python** 应用运行在你自己的机器上，有两种形态：交互式 CLI，以及一个通过 channel adapter 连接聊天平台（Telegram、Slack 等）的 **gateway**。其标志性的循环在于*从每个任务中学习*：成功的工作流沉淀为可复用的 **skill**，对话则喂养一份跨 session 持久的**记忆**。

一切都存放在 `~/.hermes/`（或按 profile 隔离的 `$HERMES_HOME`）下：`config.yaml`（全部行为设置）、`.env`（密钥）、`state.db`、`sessions/`、`cron/`、`mcp-tokens/`、`plugins/`，以及 `memories/`（内置记忆文件）。一个 workspace 承载 agent 的身份文件（`AGENTS.md`、`SOUL.md`、skill）。

对我们而言最关键的两点：

1. **Hermes 是 Python** —— 与 EverOS 同一语言。不存在 OpenClaw 集成里那种 TypeScript↔Python 的跨运行时接缝。
2. **记忆是一等的、单选的扩展点** —— Hermes 有一个专门的 `MemoryProvider` 插件类别，自带 discovery、生命周期与 setup 流程。我们无需把一套通用 hook 系统硬掰成记忆插件；这个 slot 就是为我们要接入的东西量身设计的。

### 1.2 插件如何工作

一个 Hermes 插件是一个目录，包含 `plugin.yaml` manifest 与一个显示 `register(ctx)` 的 `__init__.py`。`PluginContext` 提供注册 tool、生命周期 hook、slash command、CLI 子命令、skill、platform adapter 的方法，以及我们唯一需要的那个——`ctx.register_memory_provider(provider)`。

插件从若干来源被发现：随 Hermes 附带（`<repo>/plugins/`）、用户目录（`~/.hermes/plugins/`——安装的插件落在这里，我们的也是）、pip 包（`hermes_agent.plugins` entry point），另有两个小众来源（项目级、Nix）。同名时后者覆盖前者，因此用户安装的插件可以遮蔽内置同名插件。

存在四种插件类别，选择语义各不相同：

- **通用插件** —— 通过 `config.yaml` 里的 `plugins.enabled` / `plugins.disabled` 多选。
- **记忆 provider** —— **单选**：全部被发现，通过 `memory.provider` 恰好激活一个。位于任一来源下专用的 `plugins/memory/<name>/` 子目录。
- **context 引擎** —— 通过 `context.engine` 单选。
- **模型 provider** —— 多注册，每次运行选一个。

管理通过 `hermes plugins`（交互 UI）、`hermes plugins install <user/repo>`（GitHub）、`enable` / `disable` / `update` / `remove`。manifest 可声明 `requires_env:`——缺失的变量会在安装时被提示，并 gate 加载。

### 1.3 一个记忆 provider 看到的生命周期

通用插件订阅 hook（`pre_llm_call`、`post_llm_call`、`on_session_start/end/finalize/reset`、`pre/post_tool_call` 等）。而**一个记忆 provider 无需它们**：一旦被选中，runtime 就通过一条专用 pipeline 驱动它——这是与 OpenClaw 最大的结构性差异，在那边我们是用四个 hook 手工拼出同一套循环的。

```text
initialize(session_id, hermes_home)        agent 启动（一次）
system_prompt_block()                      向 system prompt 注入静态头部
──── 每回合重复 ────────────────────────────────────────────────────
1 · prefetch(query, session_id)            召回 —— 注入本回合
      模型运行（tool loop）
2 · sync_turn(user, assistant, …, messages)   捕获 —— 非阻塞
──── 各种结束 ──────────────────────────────────────────────────────
on_session_end · on_pre_compress · shutdown   封存尾部
```

文档原文对该 runtime 自动化的描述：当一个 provider 激活时，Hermes 会"把 provider context 注入 system prompt，在每回合前 prefetch 相关记忆，在每次回复后 sync 对话回合，在 session 结束时抽取记忆，把内置记忆的写入 mirror 到外部 provider，并加入 provider 专属的 tool"。

两条需遵守的契约：

- **`is_available()` 不得做任何 network 调用** —— 只检查 env/config；真正的连通性稍后再探测。
- **`sync_turn()` 必须非阻塞** —— 长耗时工作放进 daemon 线程（文档给出了精确写法）。

---

## 第二部分 —— Hermes 已有的记忆插件

### 2.1 内置记忆

Hermes 始终在 `~/.hermes/memories/` 维护两个文件：

- **`MEMORY.md`**（约 2,200 字符上限）—— agent 自己的笔记：环境事实、约定、学到的经验。
- **`USER.md`**（约 1,375 字符上限）—— 用户画像：偏好、沟通风格。

二者在 **session 开始时作为冻结快照**注入 system prompt，并通过一个 `memory` tool（`add` / `replace` / `remove`）编辑。这份记忆诚实、可读，但很小（合计约 1,300 token），且是一份*无检索的快照*：agent 能"记住"的一切都必须塞进文件，且新鲜度只到 session 开始那一刻。

外部记忆 provider 正是为抬升这些限制而生——而且值得注意，它们与内置文件**并存**，绝不替换。（与 OpenClaw 相反，那边记忆插件会*替换*内置的 `memory-core`。）

### 2.2 外部 provider

八个 provider 随 Hermes 在 `plugins/memory/` 下发布；同一时间经 `memory.provider` 激活一个：

- **Honcho**
  - *存储：* cloud 服务（或自托管）
  - *Locality：* cloud
  - *Tool：* 5 个 —— `honcho_profile`、`honcho_search`、`honcho_context`、`honcho_reasoning`、`honcho_conclude`
  - *备注：* dialectic *用户建模*：会话摘要 + peer card 的两层注入，附 LLM 综合的推理。
- **OpenViking**
  - *存储：* 文件系统式知识层级
  - *Locality：* 自托管，AGPL
  - *Tool：* 5 个 —— `viking_search`、`viking_read`、`viking_browse`、`viking_remember`、`viking_add_resource`
  - *备注：* 分层检索（L0 ~100 token → L1 ~2k → L2 全量）。
- **Mem0**
  - *存储：* 向量库 + 服务端抽取的事实
  - *Locality：* cloud / Docker / 进程内 OSS
  - *Tool：* 4 个 —— `mem0_search`、`mem0_add`、`mem0_update`、`mem0_delete`
  - *备注：* 服务端 LLM 事实抽取、语义检索、去重。
- **Hindsight**
  - *存储：* 带实体消解的知识图谱
  - *Locality：* cloud 或本地内嵌 PostgreSQL
  - *Tool：* 3 个 —— `hindsight_retain`、`hindsight_recall`、`hindsight_reflect`
  - *备注：* `hindsight_reflect` 跨记忆综合，为八者独有。
- **Holographic**
  - *存储：* 本地 SQLite
  - *Locality：* 本地，零外部依赖
  - *Tool：* 2 个 —— `fact_store`（复用 9 种操作）、`fact_feedback`
  - *备注：* FTS5 + 信任评分 + HRR 组合式查询。
- **RetainDB**
  - *存储：* cloud 存储，7 种记忆类型 + delta 压缩
  - *Locality：* cloud，付费
  - *Tool：* 5 个 —— `retaindb_profile`、`retaindb_search`、`retaindb_context`、`retaindb_remember`、`retaindb_forget`
  - *备注：* 混合检索（vector + BM25 + rerank）。
- **ByteRover**
  - *存储：* 本地 Markdown 知识树
  - *Locality：* 本地（可选 cloud 同步）
  - *Tool：* 3 个 —— `brv_query`、`brv_curate`、`brv_status`
  - *备注：* compaction 前的洞见抽取。
- **Supermemory**
  - *存储：* session graph 语义长期存储
  - *Locality：* cloud 或自托管
  - *Tool：* 4 个 —— `supermemory_store`、`supermemory_search`、`supermemory_forget`、`supermemory_profile`
  - *备注：* context fencing 防记忆自污染。

### 2.3 各插件的对比

**相同点：** 八者都遵循同一 runtime pipeline（prefetch → sync → session-end 抽取）。差异在存储与 locality。

**差异 —— 存储：** 可读文件（ByteRover 的 Markdown 树）、本地数据库（Holographic 的 SQLite、Hindsight 的内嵌 Postgres）、知识图谱（Hindsight）、远程服务（Honcho、RetainDB、Supermemory、Mem0 cloud）。

**差异 —— locality：** 全本地且免费（Holographic、ByteRover 默认、OpenViking 自托管）vs cloud/付费（其余）。

**EverOS 的契合。** 这份 provider 名单最有价值的一点，是它逐项证实了 EverOS 正在做的事都行得通：**本地、人类可读的 Markdown 作为事实来源**——ByteRover 证明这条路可行；**混合 vector + BM25 + scalar 检索**——RetainDB 证明其检索价值（EverOS 经 LanceDB 在本地实现）；**LLM 抽取为 profile/episode/fact**——Mem0/Honcho 证明自动抽取可用（EverOS 自托管完成）。EverOS 所做的，是把这些已被分别验证的属性集齐在一个已投产的后端里，再加上八者都没有的第二条 **agent track**（case + skill）。组合本身也不是纸上谈兵：自 OpenClaw 插件发布以来，EverOS 服务、其 API 与 provisioning 流程已在一个活跃 agent 宿主下持续运行、得到验证。插件不发明任何新机制——它把一个经现场验证的后端带进一个量身设计的 slot。

---

## 第三部分 —— Hermes Memory — EverOS 设计细节

### 3.1 目标与设计原则

**目标：** 给 Hermes 跨 session 的持久记忆，由 EverOS 支撑——正是那个已在服务 OpenClaw 的同一个 EverOS 实例。

Hermes Memory — EverOS 是一个**原生 Hermes 记忆 provider**——EverOS 本地 HTTP API 之上的一层薄 Python `MemoryProvider`。它成为唯一激活的外部 provider（`memory.provider: "everos"`），并捕获 **EverOS 的两条 track**：开发者的 profile + episode（user track），以及 agent 蒸馏出的 case + skill（agent track）——后者要求 EverOS 以 `mode = "agent"` 运行。

**原则**（与 OpenClaw 插件相同）：

1. **镜像 EverOS——不发明任何东西。** provider 只转发给 EverOS，并只提供每个请求所需之物。
2. **Fail-open。** 若 EverOS 不可用，每个方法都 no-op，session 照常进行。

再加上这个宿主使之成为可能的一条：

3. **一个大脑，多个 agent。** provider 与 OpenClaw 插件对话的是*同一个* EverOS 服务——同一存储、同一基础设施，按 `app_id`（`"hermes"` vs `"openclaw"`）分区。磁盘上、进程里都不重复。

### 3.2 决策

1. **走 HTTP，而非 import。** Hermes 与 EverOS 同为 Python，诱人的捷径是进程内 `import everos`。我们刻意保留 **HTTP 请求路径**（`POST /add`、`/search`、`/flush`）：(a) 一个 EverOS 服务必须并发服务多个 agent 宿主——进程内会把存储割裂；(b) EverOS 的 OME 引擎按锁单实例——两份内嵌副本无法共存；(c) 进程隔离使记忆后端崩溃不会拖垮 agent。同为 Python 仍有回报——在 provisioning 上，以及在不额外附带任何运行时上。
2. **detect-then-provision，在 `initialize()` 中。** agent 启动时 provider 健康检查 EverOS：在运行则用之；已安装则启动它（正是 OpenClaw 插件验证过的 detect-then-start 流程，含 venv 启动命令与 `EVEROS_MEMORIZE__MODE=agent` + 端口强制）；缺失则引导用户（`everos init`、密钥填入 `~/.everos/everos.toml`）。全部在 daemon 线程里——`initialize` 立即返回，fail-open。
3. **仅 context 模式——无 tool。** provider 实现 `prefetch`/`sync_turn`/`on_session_end`，并**不返回**任何 tool schema。召回每回合自动发生；EverOS 唯一写路径是 `/add`，已由 sync 覆盖。这镜像 OpenClaw 的决策（无模型可调的记忆 tool），也契合若干 Hermes provider 提供的 "context" 召回模式。
4. **内置记忆保留；我们 mirror 其写入。** Hermes 的 `MEMORY.md`/`USER.md` 按设计保持激活（provider 与之并存、绝不替换）。我们实现 `on_memory_write`，把这些明确的、经用户批准的笔记经 `/add` 转发进 EverOS——它们正是 EverOS 抽取器想要的持久事实，且抽取器会去重。

### 3.3 架构

```text
Hermes session（Python）
        │
Hermes Memory — EverOS        MemoryProvider · plugins/memory/everos/
        │   app_id="hermes"
EverOS 后端（未修改）· 127.0.0.1:8000
        │   POST /search · /add · /flush
Markdown（事实来源）· SQLite（状态 · 审计 · 队列）· LanceDB（vector + BM25 + scalar）
```

EverOS **未被修改**。一切都经三个 endpoint；每个请求都带 `app_id="hermes"`——正是这个标签把 Hermes 的记忆在存储里圈定。（同一服务可并肩服务其他 agent 宿主。）

### 3.4 文件布局

```
plugins/memory/everos/            # 用户安装时位于 ~/.hermes/plugins/ 下
├── plugin.yaml                   # manifest：name、version、description、hooks
├── __init__.py                   # EverosMemoryProvider + register(ctx)
├── client.py                     # 薄 HTTP client（/search、/add、/flush、/health）
├── provision.py                  # EverOS 服务的 detect-then-provision
├── cli.py                        # 可选：`hermes everos status`
└── README.md                     # setup + 配置说明
```

**`plugin.yaml`** —— manifest 声明身份，并列出我们实现了哪些可选 pipeline 方法：

```yaml
name: everos
version: "1.0.0"
manifest_version: 1
description: "EverOS-backed cross-session memory — markdown source of truth, hybrid recall, user + agent tracks."
hooks:
  - sync_turn
  - on_session_end
  - on_pre_compress
  - on_session_switch
  - on_memory_write
  - on_delegation
```

**版本化：** `version` 只是发布标签，每次发布递增，无强制.

### 3.5 实现：provider

整套集成就是一个实现文档化 `MemoryProvider` 面的类，加上两行 `register`：

```python
# __init__.py —— 草图；错误处理与渲染省略，形态精确
from agent.memory_provider import MemoryProvider
from .client import EverosClient
from .provision import detect_then_provision

class EverosMemoryProvider(MemoryProvider):
    @property
    def name(self) -> str:
        return "everos"

    def is_available(self) -> bool:
        return True                      # 只检查 config/env —— 无 network（契约）

    def initialize(self, session_id: str, **kwargs) -> None:
        self._sid = session_id                           # 留给封存点的 flush 使用
        self._home = kwargs.get("hermes_home")           # 按 profile 隔离的配置路径
        self._cfg = load_config(self._home)              # $HERMES_HOME/everos.json
        self._client = EverosClient(self._cfg.base_url)
        detect_then_provision(self._client, self._cfg)   # daemon 线程；fail-open

    # ── 召回（每次模型调用前）─────────────────────────────────────────────
    def prefetch(self, query: str, *, session_id: str = "") -> str:
        try:  # 两个 owner 维度的 search，并发；~5s cap；fail-open
            user, agent = search_both_tracks(self._client, query, self._cfg)
            return render(user, agent)   # 加围栏、标注为不可信历史 context
        except Exception:
            return ""                    # 慢/宕 → 本回合无记忆继续

    # ── 捕获（每回合结束后；必须非阻塞）───────────────────────────────────
    def sync_turn(self, user_content, assistant_content, *, session_id="", messages=None):
        spawn_daemon(lambda: self._client.add(
            to_turn(messages or [user_content, assistant_content],   # 含 tool call 的完整回合
                    session_id, self._cfg)))

    # ── 封存尾部 ───────────────────────────────────────────────────────────
    def on_session_end(self, messages) -> None:
        self._client.flush(session_id=self._sid, app_id="hermes")    # fail-open

    def on_pre_compress(self, messages) -> str:
        self._client.flush(session_id=self._sid, app_id="hermes")    # 在 context 丢弃前封存
        return ""                        # 不向压缩摘要投稿

    def on_session_switch(self, new_session_id, *, reset=False, **kwargs) -> None:
        if reset:                        # 真正的新对话——先封存旧的
            self._client.flush(session_id=self._sid, app_id="hermes")
        self._sid = new_session_id       # /resume、/branch、compression——保持 _sid 新鲜

    # ── mirror 内置 MEMORY.md / USER.md 的写入 ───────────────────────────
    def on_memory_write(self, action, target, content, metadata=None) -> None:
        self._client.add(note_as_turn(action, target, content, self._cfg))

    # ── 捕获委派出去的 subagent 工作（task + result）─────────────────────
    def on_delegation(self, task, result, *, child_session_id="", **kwargs) -> None:
        spawn_daemon(lambda: self._client.add(
            delegation_as_turn(task, result, child_session_id, self._cfg)))

    def get_tool_schemas(self) -> list:
        return []                        # 仅 context 模式 —— 无模型可调 tool（§3.2）

    def shutdown(self) -> None:
        stop_spawned_everos_if_ours()

def register(ctx) -> None:
    ctx.register_memory_provider(EverosMemoryProvider())
```

保真要点：

- **`prefetch` 是召回热路径** —— OpenClaw 的 `before_prompt_build → prependContext` 的对应物。同样的两 track 搜索，同样带*"不可信历史数据"*标注的渲染，同样的围栏 token 中和（prompt-injection 加固逐字沿用——它在 `render` 里）。
- **`sync_turn` 收到 `messages`** —— "截至本回合完成的 OpenAI 风格对话 context"，含 tool call 与 tool result。这与 `agent_end` 在 OpenClaw 给我们的保真度一致：agent track 拿到完整轨迹，而不只是 user/assistant 文本。daemon 线程写法满足非阻塞契约（fire-and-forget 的对应物）。
- **`on_pre_compress` 是一份馈赠** —— OpenClaw 从未提供的 hook。Hermes 在 context compaction 丢弃消息*之前*通知 provider，于是尾部恰在其即将不可恢复的那一刻被封存。（在 OpenClaw，一个相关缺口迫使我们做了 session-switch 安全网；这里宿主直接把信号交给我们。）
- **`is_available` 遵守无 network 契约** —— 真正的可达性在 `initialize` 的 provisioning 线程与逐请求里以 fail-open 探测。
- **刻意不实现 `system_prompt_block()`** —— 它注入的是一段全 session 不变的静态头部，而我们没有属于那里的内容：没有 tool 需要说明（§3.2），且"不可信历史数据"的标注随每个 `prefetch` 块内联携带（在 `render` 里），不会与其守护的内容脱节。

### 3.6 ID / track 映射

| Hermes 标识 | EverOS 请求字段 | Track |
|---|---|---|
| `session_id`（pipeline 入参） | `session_id` | — |
| 常量 `"hermes"` | `app_id` | — |
| profile（`$HERMES_HOME` 名）或 cwd 项目 | `project_id` | — |
| 开发者 id（配置；默认 `$USER` / OS 账户） | user 消息 `sender_id` | **user** |
| 常量 agent id（配置；默认 `"hermes"`） | assistant `sender_id` = `agent_id` | **agent** |

召回必须与捕获用同一 `app_id`/`project_id`，否则搜到另一棵树、返回空。EverOS 必须以 `mode = "agent"` 运行，才能让一条 `/add` 流同时喂两 track——provider 启动 EverOS 时强制 `EVEROS_MEMORIZE__MODE=agent`，与 OpenClaw 插件一致。agent id 是每宿主一个常量池：Hermes 路由到的每个模型都汇入同一个 agent 的 case 与 skill。

**跨宿主说明：** user track 按 `app_id` 分区，故 Hermes 记忆与 OpenClaw 记忆在同一存储里并肩而居，但不自动交叉授粉。跨 app 召回是 EverOS 层的能力决策，而非任一插件所发明（镜像原则）。

### 3.7 运行时流程

- **召回**（读，热路径）：runtime 在每次模型调用前调用 `prefetch(query)`——且 Hermes 会先集中**把 query 改写成一句简洁的英文问句**（`plugins/memory/query_rewrite`，一个辅助 LLM；≤320 字符），这是 OpenClaw 未提供的宿主服务。（在 OpenClaw，是插件自己用**最新 N 条用户消息**原文拼出 query——不做问句改写；这里这活儿交给了宿主。）两个 owner 维度的 `/search` 并发（`user_id` → episode + profile，经 `include_profile`；`agent_id` → case + skill），结果渲染为围栏块，~5s fail-open cap。
- **捕获**（写，后台）：每回合完成后 `sync_turn` → `/add` 携完整回合（`messages` 入参），在 daemon 线程。EverOS 一如既往缓冲并在话题边界自动抽取。
- **封存**（三个信号，均 → `/flush`）：`on_session_end`（每次对话关闭）、`on_pre_compress`（context compaction 前）、`shutdown`（进程退出——先 flush 再停止自启的 EverOS）。`on_session_switch` 让封存不落空：Hermes 会在进程中途轮换 `session_id`（`/resume`、`/branch`、`/reset`、compression），provider 随之更新缓存的 id——真正重置时先 flush。Hermes 的 session 模型（`on_session_end` 在每次 `run_conversation` 结束与 CLI 退出时触发）比 OpenClaw TUI 更丰富，故此处的"尾部滞留"缺陷类在结构上更小。
- **Mirror**（写，罕见）：`on_memory_write` 把内置 `MEMORY.md`/`USER.md` 编辑转发进 `/add`——明确的用户策展事实是上等抽取输入；EverOS 去重。
- **委派**（写，偶发）：`on_delegation` 把每次 subagent 的 task + result 对经 `/add` 转发——父侧可见的委派摘要正是 agent track 想要的精炼轨迹；child 的完整转录留在 Hermes 的 session 存储里（child 以 `skip_memory=True` 运行）。
- **生命周期**（bootstrap，一次）：`initialize` → detect-then-provision（健康检查 → 已安装则启动 → 未装则引导 `everos init`），非阻塞、fail-open。

### 3.8 配置

provider 配置由**`hermes memory setup`**（宿主内置的 setup 流程——无需自定义安装器，不同于 OpenClaw 那边我们发布了 `everos-setup`）经 `get_config_schema()` 提示，并由 `save_config()` 持久化到 `$HERMES_HOME/everos.json`：

| Key | 默认 | 用途 |
|---|---|---|
| `base_url` | `http://127.0.0.1:8000` | EverOS 在哪（无 scheme 值会被规范化） |
| `user_id` | `$USER` / OS 账户 | user track 的开发者身份 |
| `agent_id` | `"hermes"` | 常量 agent 身份 |
| `query_max_units` | `500` | 召回 query 的加权头部截断上限（CJK 字 = 2 单位，其他 = 1） |
| `everos_dir` | — | EverOS 检出目录，用于从 venv 自启 |
| `start_cmd` | `everos server start` | 自启命令（引号括起含空格的路径） |

> `config.yaml` 里的 `memory.provider: "everos"` 激活它（由 setup picker 写入）。query 构造旋钮是插件侧的；抽取、存储、模型仍是 EverOS 自己的（`~/.everos/everos.toml`）——镜像原则不变。端口同理：`8000` 只是 EverOS 的出厂默认（`default.toml`），用户可在 `~/.everos/everos.toml` 里改——这里的 `base_url` 跟着 EverOS 在哪监听走。
>
> **query 构造与 OpenClaw 不同。** 那边插件自己用最新 N 条用户消息拼 query（一个 `EVEROS_OC_QUERY_N` 旋钮，按纯字符数截断）。Hermes 则在 `prefetch` *之前*把最新消息改写成一句英文问句（`plugins/memory/query_rewrite`），所以这里**没有 `query_n`**——消息拼接是宿主的活。于是截断只在回退路径触发：改写失败、原始（可能是 CJK 的）消息落到 provider 时。且它是**加权**截断：纯字符计数对不同语言不公平（500 个 CJK 字承载的信息远多于 500 个拉丁字符），故——沿用 Twitter/X 与 Unicode 东亚宽度标准都采用的 2:1 加权——一个 CJK/全角字符记 2 单位、其余记 1，上限为 `query_max_units`（默认 500，用标准库 `unicodedata.east_asian_width` 计算，无依赖）。

### 3.9 隐私与性能

- **cascade 滞后** —— 刚写入的记忆几秒后才可检索；可接受，价值在跨 session。
- **隐私** —— *留在本地：* 存储（Markdown/SQLite/LanceDB）与 provider↔EverOS 链路（`127.0.0.1`）。*离开机器：* 对话文本发往 EverOS 配置的 LLM + embedding provider 做抽取——默认云端，除非把 EverOS 指向本地模型。按 Hermes 惯例 provider README 须"说明哪些数据离开设备"；`sync_turn` 的载荷正是该说明面。
- **线程** —— 召回有 cap（~5s，fail-open）；捕获与 flush 在 daemon 线程；`initialize` 立即返回。provider 从不阻塞回合。

### 3.10 安装与运行

**安装**（GitHub，用户插件的原生渠道）：

```bash
hermes plugins install EverMind-AI/plugins           # monorepo → ~/.hermes/plugins/memory/everos/
hermes memory setup                                   # 选 "everos"；提示 schema 字段
hermes memory status                                  # 验证：provider 激活、EverOS 健康
```

`hermes memory setup` 写入 `memory.provider: "everos"` 与 provider 配置；`initialize` 在下次启动时 detect-then-provision EverOS。**没有 consent-grant 步骤**：不同于 OpenClaw（第三方插件在被授予 `allowConversationAccess` 前被挡在对话内容之外），一个被选中的 Hermes 记忆 provider 按设计就会收到回合——选择*即*同意。启用插件并选它为 provider 就是那个明确的用户动作。

**插件之外的一次性设置**（与 OpenClaw 相同）：EverOS 需 `everos init` 一次，密钥填入 `~/.everos/everos.toml`。首次运行检测到缺失配置并把用户指向它。

**一次完整迭代：**

1. 安装、`hermes memory setup`、选 `everos`。
2. EverOS 密钥一次（若已为 OpenClaw 设过——共享！）。
3. 启动 Hermes → `initialize` provisions EverOS → 召回上线。
4. 工作 → 每回合经 `/add` sync；session-end / pre-compress / exit 触发 flush；cascade 索引进 LanceDB——同一批记忆也以 Markdown 落在磁盘 `~/.everos/hermes/`，可读。