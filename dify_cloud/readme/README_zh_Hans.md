# EverOS 云端版 Dify 插件

将 Dify 工作流和 Agent 连接到 EverOS 云端托管的持久化记忆服务。这是云端服务版，用户
不需要在 Dify 旁边另外运行 EverOS 服务。

## 使用前准备

- EverOS 云端 API 地址（默认是 `https://api.evermind.ai`）。
- 该服务签发的 EverOS 云端 API Key。
- 如果 Dify 应用需要调用大模型，还需在 Dify 中单独配置模型服务商。

EverOS 云端服务自行管理其 LLM、Embedding、Rerank 和多模态配置，用户不在本插件中
填写这些模型 Key。插件仅将 EverOS 云端 API Key 作为 `Authorization: Bearer`
请求头发送到已配置的 HTTPS 地址。

## 配置授权

在 Dify 中打开 **插件 -> EverOS 云端版 -> 授权**，填写：

| 字段 | 必填 | 如何填写 |
|---|---:|---|
| 凭据名称 | 是 | 工作区内用于识别这组配置的任意名称。 |
| EverOS 云端 API 地址 | 是 | 除非账户使用其他获批端点，否则保留 `https://api.evermind.ai`；不要包含 `/api/v2`。 |
| EverOS 云端 API Key | 是 | 云端服务签发的 API Key。 |

保存凭据时，插件会验证地址、API Key 格式和 EverOS 健康响应；第一次调用工具时会确认
API Key 是否有权限。地址必须是解析到公网 IP 的 HTTPS 地址，插件不跟随重定向。

## 两个工具

### 搜索 EverOS 云端记忆

在 LLM 生成回答前，为当前 Dify 运行时用户搜索持久化记忆。参数只有查询内容和可选的
返回数量。

### 写入 EverOS 云端记忆

存储一轮已完成的用户/助手对话，并请求 EverOS 云端完成记忆提取。应放在 LLM 回答之后。

## 典型工作流

1. 获取用户当前消息。
2. 用该消息调用 **搜索 EverOS 云端记忆**。
3. 将返回的记忆作为不可信上下文传给 LLM。
4. 生成最终回答。
5. 将原始用户消息和最终回答传给 **写入 EverOS 云端记忆**。

安装插件不会让所有 Dify 应用自动获得记忆，应用创建者需要在工作流中显式放置这两个工具。

## 隔离与数据流

插件会将 Dify 平台提供的用户、应用和会话标识符转换成稳定的分域哈希。LLM 无法自行选择这些
隔离标识。内部使用固定项目范围，因此用户无需填写项目、用户、应用或会话 ID。

搜索内容、已完成的对话和派生的范围标识会发送到配置的 EverOS 云端 API 地址。未获得组织
批准时，请勿存储密钥、凭据或受管制数据。详见 [PRIVACY.md](../PRIVACY.md)。

## 安全行为

- 强制 HTTPS。
- 拒绝 localhost、内网、链路本地、保留地址以及解析到非公网 IP 的域名。
- 拒绝 URL 内的凭据、查询参数、片段和重定向。
- 禁用重定向，防止授权请求头被转发。
- 响应上限为 2 MiB，Dify 错误中不显示上游响应体。
- 将记忆内容视为不可信数据，不应将其当作指令执行。

由于目标地址由工作区配置，管理员应只允许经批准的 EverOS 云端端点，并限制可编辑插件凭据的
成员。

## 支持

- 源码：<https://github.com/EverMind-AI/plugins/tree/main/dify_cloud>
- 问题：<https://github.com/EverMind-AI/plugins/issues>
- 邮箱：<contact@evermind.ai>
- EverOS：<https://github.com/EverMind-AI/EverOS>

本项目使用 [Apache-2.0](https://github.com/EverMind-AI/plugins/blob/main/LICENSE) 许可证。
