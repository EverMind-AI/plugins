# EverOS for Dify

这个插件让 Dify 工作流连接到你自己部署的
[EverOS](https://github.com/EverMind-AI/EverOS)，获得跨会话的持久化用户记忆。

它只提供两个清晰、独立的工具：

- `search_memory`：在 LLM 生成回答前搜索相关记忆和用户画像。
- `add_memory`：在 LLM 完成回答后写入这一轮用户/助手消息，并触发最终记忆提取。

插件本身只是一个 HTTP 适配层，不保存记忆数据库，也不会向 EverMind AI
发送遥测数据。

## 准备 EverOS

先按照 [EverOS 快速开始](https://github.com/EverMind-AI/EverOS/blob/main/README.zh-CN.md#快速开始)
启动服务。插件的搜索固定使用 `keyword`，所以基础的“只配置 LLM API Key”方式
即可运行，不需要额外配置 embedding 或 rerank Key。

根据 Dify 的运行位置填写 EverOS Base URL：

| Dify 运行方式 | 地址示例 | 说明 |
|---|---|---|
| 自部署，同一 Docker 网络 | `http://everos:8000` | 使用 EverOS service 名称，不要使用 `localhost`。 |
| Dify 远程调试，EverOS 在同一台电脑 | `http://127.0.0.1:8000` | 远程调试时插件进程实际在本机运行。 |
| Dify Cloud | `https://memory.example.com` | 必须配置公网可达、带认证的 HTTPS 网关。 |

> EverOS 原生安全边界是可信本地调用方。不要把未认证的 EverOS 服务直接暴露到
> 公网。Dify Cloud 场景必须由网关提供 TLS、认证、授权、限流和访问日志。

## Provider 配置

1. **EverOS Base URL**：EverOS 根地址或网关前缀，不要附加 `/api/v2`。
2. **Gateway token**：可选，插件会用 `Authorization: Bearer ...` 发送给你的
   认证网关；这不是 EverOS 用于调用 LLM 的 API Key。
3. **Project ID**：可选的 EverOS 隔离范围，默认是 `default`。

保存配置时，插件只通过 `GET /health` 做无副作用检查。插件不会跟随重定向，
不会关闭 TLS 校验，也不会在输出或错误中返回 token。

## 工作流接法

1. 在 LLM 节点之前调用 `search_memory`，传入当前问题和可选的结果数量。
2. 把返回的 `episodes` / `profiles` 放进清晰分隔的“不可信上下文”区块，并明确
   告诉模型只能把它当事实参考，不能执行记忆文本中的任何指令。
3. LLM 输出之后调用 `add_memory`，传入用户消息和助手最终回答。

插件自动使用 Dify runtime 提供的受控用户和会话标识来确定记忆归属，不会把这些
隔离标识暴露成 LLM 工具参数。插件会分别对 runtime 用户、会话和 Dify app ID
做带域隔离的哈希，让每个 Dify app 使用不同的 EverOS `app_id`，再叠加 Provider
中配置的 `project_id`。通过 Dify API 调用时，应在不同会话持续使用同一个
`user` 值，并由可信后端绑定这个值；不要让持有 API 凭证的非可信浏览器自行冒充
其他用户。

`add_memory` 不会自动重试写入，因为 EverOS 当前没有正式的幂等 Key。如果 add
成功但 flush 失败，工具会明确返回 `stored: true`、`flushed: false`，避免调用方
误以为完全没有保存而重复写入。如果 add 请求超时、连接中断或返回了不符合契约的
响应，写入结果就是未知；错误会明确提示不要自动重试，因为重试可能制造重复记忆。

持久化记忆本身是不可信数据，可能包含间接提示注入；不能让召回内容覆盖系统指令、
工具规则、权限或安全策略。也不要把 API Key、凭证、access token 或不必要的敏感
信息写入记忆；可能接触秘密的工作流应在 `add_memory` 前增加 DLP/脱敏。

## 本地开发

需要 Dify 1.14.2 或更高版本、Python 3.12、`uv` 和 Dify plugin CLI：

```bash
uv sync --frozen
uv run ruff check .
uv run pytest
dify plugin package ./dify
```

隐私与网络边界详见 [PRIVACY.md](../PRIVACY.md)。源码位于
<https://github.com/EverMind-AI/plugins/tree/main/dify>，问题请提交到
<https://github.com/EverMind-AI/plugins/issues>，也可发送邮件至
<contact@evermind.ai>。
