# EverOS OpenClaw 插件

为 **OpenClaw** 提供持久的跨会话记忆，由自托管的
[EverOS](https://github.com/EverMind-AI/EverOS) 驱动——全程只需自然对话。

本插件占用 OpenClaw 的独占 **memory slot**，把 OpenClaw 的生命周期接入本地
EverOS 服务（`127.0.0.1:8000` 上的 `/api/v2/memory/*`）。

> **v3.0.0 是一次大版本替换。** ≤ 2.x 的版本是 *context-engine* 插件，对接旧的
> EverMemOS API（`/api/v1/memories/*`，端口 `1995`）。本版本是对接当前 EverOS
>（`/api/v2/memory/*`，端口 `8000`）的 *memory-slot* 插件。要求
> **EverOS ≥ 1.2.3**、**OpenClaw ≥ 2026.8.1（2.0）**。
> npm 包同时声明了 OpenClaw 安装期的 host/API 兼容下限，旧版 Gateway 会在
> 加载插件代码前被拒绝，避免出现“可以安装、运行才报错”的情况。

## 它能做什么

- 在**每次回复前**自动回忆相关记忆并注入上下文
- 在每轮对话**结束后**自动保存——文本、已暂存的图片/音频/文档、
  完整的工具调用轨迹
- 会话结束时封存对话尾部（`/new`、`/reset`、关机——包括那些 `/new`
  根本不通知 gateway 的客户端）
- 本地没有 EverOS 在跑时**自动启动一个**（detect-then-provision）
- 用户只需要正常聊天——永远不需要调用 `memory_store` / `memory_search`

需要知道：

- 这**是**一个 `memory` slot 插件——安装会替换默认的 `memory-core`
  （安装器会自动切换 slot）
- **故障开放（fail-open）设计**：EverOS 挂掉或不可达时，OpenClaw 一切照常，
  只是记忆暂停
- 零运行时依赖（原生 `fetch`）

## 快速开始

推荐安装方式：

```bash
npx --yes --package @everos-ai/openclaw-plugin everos-setup
```

安装器会：

- 在接受插件声明的 memory capability 前**先询问你**，再执行官方的
  `openclaw plugins install`（占用独占 memory slot）
- 在授予对话访问权限前**先询问你**——回忆和保存都必需，绝不静默授权
- 当 `everos` 不在 gateway 的 PATH 上时，帮你指向 EverOS 检出目录
- 重启 gateway 并做健康检查

非交互 / 脚本化安装：`everos-setup --grant --everos-dir /path/to/EverOS`
（`--grant` 同时接受声明的 memory capability）。若只安装但保持回忆/写入关闭，
使用 `--accept-capabilities --no-grant`。全部参数见 `everos-setup --help`。
想手动一步步来？见[手动安装](#手动安装)。

然后用自然语言验证——随口提一句关于自己的事：

```text
我最喜欢的咖啡是意式浓缩。
```

然后开一个新会话（`/new`），随便发一条消息，再问：

```text
我喜欢什么咖啡？
```

（两轮之间等几秒——EverOS 的记忆抽取是异步的。）

**不要**把 `hooks.allowPromptInjection` 设为 `false`——它默认开启，
recall 需要它才能把记忆注入 prompt。

## 后端

默认后端地址：

```text
http://127.0.0.1:8000
```

健康检查：

```bash
curl http://127.0.0.1:8000/health
```

如果 EverOS 已经在运行，插件会直接检测并使用它；如果没有，插件会自己启动一个
（`everos server start`，强制 agent 模式、使用配置的端口）。当 EverOS 装在项目
虚拟环境里时，`everos-setup` 会自动完成启动配置（询问你的检出目录并设置
`EVEROS_OC_START_CMD` / `EVEROS_OC_EVEROS_DIR`——需要手动调整时见
[配置项](#配置项)与[故障排查](#故障排查)）。

从零搭建 EverOS：

```bash
git clone https://github.com/EverMind-AI/EverOS.git
cd EverOS
uv sync
uv run everos init      # 创建 ~/.everos/everos.toml（+ ome.toml）——首次启动前必须执行
# 编辑 ~/.everos/everos.toml——填入各 api_key（LLM / embedding / rerank）
uv run everos server start
```

## 图片、音频、文档与视频

插件使用 OpenClaw 2.0 的标准媒体暂存事件，把受支持的附件交给
EverOS。先在 EverOS 检出目录安装可选解析依赖：

```bash
uv sync --extra multimodal
```

然后在 `~/.everos/everos.toml` 中单独配置多模态 provider；这不是主
`[llm]` 的 key：

```toml
[multimodal]
model = "google/gemini-3-flash-preview"
base_url = "https://openrouter.ai/api/v1"
api_key = "<your key>"
```

所选端点/模型必须接受 `image_url` 内容；处理语音时还必须接受音频内容。
重启 EverOS 后，检查 `/health` 中 `capabilities.multimodal_llm` 为 `true`，
且 `disabled_features` 中没有 `multimodal_upload`。

- 端到端支持：图片、音频、PDF、HTML、邮件和 Office 文档。Office 文档
  还需要 EverOS 主机安装 LibreOffice。
- 已暂存的本地文件会以 `file://` URI 发送，因此 OpenClaw 与 EverOS 必须
  能看到同一文件路径。EverOS 在另一台机器时，请使用 HTTP(S) 媒体 URL。
  服务超出 loopback 时，应通过 `[multimodal].file_uri_allow_dirs` 限制可读目录。
- EverOS 1.2.3 的 `ContentItem` **没有原始视频类型**。如果 OpenClaw 自身的
  媒体理解流程为收到的视频生成了转写/描述，插件会保存这些文本，
  但不会把视频伪装成音频或图片发送。
- 多模态解析不可用时，只在明确收到 `415`、`422` 或
  `CAPABILITY_UNAVAILABLE` 时才会降级为纯文本重试。

## 自然语言记忆是如何工作的

1. 用户发送一条普通消息。
2. `before_prompt_build`——插件用你的 prompt 构造查询，去 EverOS 搜索
   （开发者轨 + agent 轨）。
3. 命中的记忆以清晰围栏包裹的**不可信历史上下文**块注入——回忆的记忆只提供
   参考，不能对模型下指令。
4. OpenClaw 正常回复。
5. `message_received` + `agent_end`——整轮对话（用户/助手文本、工具调用/
   结果、已暂存的图片/音频/文档）被转发到 EverOS `/add`。
6. 聊天过程中 EverOS 在话题边界自动抽取记忆；会话结束时——`/new`、`/reset`、
   gateway 关机、或客户端本地切换会话——插件会 flush 缓冲的尾部，
   最后一个话题永远不会丢。

所以日常体验就是纯聊天：

> **今天：**"对了，我偏好深色模式。"
> **几天后，全新会话：**"我偏好什么 UI 风格？" → *"深色模式。"*

你永远不用执行保存命令，也不用搜索任何东西——提到即记住，问到即想起。
不需要"记住这个"之类的前缀。

## OpenClaw 配置示例

安装后 `~/.openclaw/openclaw.json` 中的结构：

```json
{
  "plugins": {
    "slots": {
      "memory": "evermind-ai-everos"
    },
    "entries": {
      "evermind-ai-everos": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "EVEROS_OC_BASE_URL": "http://127.0.0.1:8000",
          "EVEROS_OC_USER_ID": "your-name",
          "EVEROS_OC_AGENT_ID": "openclaw",
          "EVEROS_OC_QUERY_N": 1,
          "EVEROS_OC_QUERY_MAX_CHARS": 500
        }
      }
    }
  }
}
```

## 配置项

每个配置项都有两种等价的设置方式：**gateway 进程的环境变量**（优先级更高），
或**宿主托管的插件配置**
（`openclaw config set plugins.entries.evermind-ai-everos.config.<VAR> <value>`）。
空白值视为未设置。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EVEROS_OC_BASE_URL` | `http://127.0.0.1:8000` | EverOS 地址。无 scheme 的值（如 `localhost:8000`）会自动补全为 `http://` |
| `EVEROS_OC_USER_ID` | `$USER` / `$USERNAME` / 系统账户 | 用户记忆轨的开发者标识 |
| `EVEROS_OC_AGENT_ID` | `openclaw` | agent 记忆轨的固定共享标识 |
| `EVEROS_OC_QUERY_N` | `1` | 构成 recall 查询的近期用户消息条数 |
| `EVEROS_OC_QUERY_MAX_CHARS` | `500` | recall 查询的头部截断预算（字符数） |
| `EVEROS_OC_START_CMD` | `everos server start` | 自动启动 EverOS 的命令。引号可括起含空格的路径 |
| `EVEROS_OC_EVEROS_DIR` | （gateway 工作目录） | 自动启动的 EverOS 的工作目录 |

## 会回忆与保存哪些内容

### 回忆

recall 最多注入四个部分，全部由 EverOS 提供：

- **开发者画像**——关于你的持久事实和偏好
- **相关历史情景**——过往对话的摘要
- **相关案例**——具体的过往 agent 轨迹（哪些方法奏效）
- **相关技能**——从多个案例聚类提炼出的可复用模式

### 保存

- 用户和助手的文本（插件会先剥掉自己注入的 recall 块，
  记忆永远不会把自己再吃进去）
- 助手的**工具调用**和工具结果，按 `tool_call_id` 串联
- **图片、音频、PDF、HTML、邮件和 Office 文档**（内联内容或已暂存 URI）。
  如果 EverOS 明确拒绝多模态输入，该轮会降级为纯文本重试，对话文本不会丢失
- OpenClaw 从视频生成的**转写/描述文本**；EverOS 1.2.3 未定义视频类型，
  因此不传送原始视频字节
- 超长轮次会按 EverOS 的 500 条消息上限有序分批

## 手动安装

```bash
openclaw plugins install @everos-ai/openclaw-plugin --accept-capabilities
```

然后授予对话访问权限——**必须做，仅需一次**。OpenClaw 2.0 在未授权时，
会同时禁用非内置插件的 `before_prompt_build` 回忆和 `agent_end` 写入：

```bash
openclaw config set 'plugins.entries.evermind-ai-everos.hooks.allowConversationAccess' true
openclaw gateway restart
```

如果 `everos` 装在项目虚拟环境里，还需设置 `EVEROS_OC_START_CMD` /
`EVEROS_OC_EVEROS_DIR`（见[配置项](#配置项)）——或直接运行 `everos-setup`，
它会帮你配好。

## 故障排查

| 问题 | 解决方式 |
|---|---|
| 无法回忆，也没有任何写入 | 授予对话访问权限：`openclaw config set 'plugins.entries.evermind-ai-everos.hooks.allowConversationAccess' true`，然后重启 gateway。插件检测到这种状态会打警告日志。 |
| 可以写入但不回忆 | 删除显式的 `hooks.allowPromptInjection: false` 配置（或改为 `true`），然后重启 gateway。 |
| 音频/图片/文档只变成占位文本 | 安装 EverOS `multimodal` extra，配置 `[multimodal]`，重启 EverOS 并检查 `/health`。本地文件还需确保 EverOS 进程可读对应的暂存路径。 |
| 后端连接失败 | 检查 `EVEROS_OC_BASE_URL`，然后 `curl <baseUrl>/health` |
| 自动启动始终拉不起 EverOS | gateway 找不到 `everos`——把 `EVEROS_OC_START_CMD` 设为可执行文件的绝对路径，`EVEROS_OC_EVEROS_DIR` 设为 EverOS 仓库目录。同时确认没有别的实例占着单实例锁（`~/.everos/.index/sqlite/ome.db.lock`） |
| 刚说完就问——还没有记忆 | 抽取是异步的，等几秒。聊天中在话题切换时触发抽取；会话结束时封存剩余部分 |
| "user-track memory is DISABLED" 警告 | 无法解析用户标识——设置 `EVEROS_OC_USER_ID` |
| 与其他记忆插件冲突 | 本插件占用独占的 `memory` slot；确认 `plugins.slots.memory` 为 `evermind-ai-everos` |

## 相关文件

- `dist/index.js`——插件入口（`openclaw.extensions`）
- `src/setup.ts` / `src/setup-cli.ts`——`everos-setup` 一键安装器
- `src/register.ts`——slot 占用、hook 接线、provisioning 服务
- `src/handlers.ts`——媒体暂存 / recall / capture / flush（+ 会话切换安全网）
- `src/everos.ts`——类型化的 EverOS REST 客户端（`/add`、`/search`、`/flush`、`/health`）
- `src/provision.ts`——EverOS 服务的 detect-then-provision
- `src/config.ts`——`EVEROS_OC_*` 配置
- `openclaw.plugin.json`——插件元数据与配置 schema

## 开发

```bash
npm install
npm run build        # tsc → dist/
npm test             # 单元测试；EverOS 在线时才跑 live smoke
npm run ci           # lint + 本地/真实 OpenClaw 2.0 类型检查 + build + test
```

## 许可证

Apache-2.0
