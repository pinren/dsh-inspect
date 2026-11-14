# dsh-inspect
看一个 DSH 会话到底被注入了什么：多帧 zstd 解码 + 注入清单 + 目录汇总

## 用法

```sh
# 解码一个会话的完整 JSONL 到 stdout
node bin/dsh-inspect.js /path/to/session.v4.jsonl.zstd

# 列出这个会话实际注入过的 AGENTS.md 链
node bin/dsh-inspect.js inject /path/to/session.v4.jsonl.zstd

# 递归汇总一个目录下的全部会话
node bin/dsh-inspect.js report ~/.dsh/sessions
```

解码命令把完整 JSONL 写到 stdout。用法错误、读文件失败、输入不是 zstd、frame 截断或尾部有多余字节时，原因写到 stderr 并以非 0 退出——不会静默输出空内容。

需要 Node.js 22.15+ 或 23.8+（使用 `node:zlib` 内置的 zstd 支持），无第三方依赖。

## 注入清单

`inject` 从解码后的日志里找出 DSH 写下的 `agent-instructions` 消息，按日志顺序回放整条链：baseline 是完整快照；之后的 `replace`（文件变了）、新增文件和 `remove`（文件撤掉）依次覆盖。最终输出每个仍然生效的文件一行：

```text
~/.agents/AGENTS.md · 1043 · 92b22dd31a762044f1bc17611dbc051bd3624a40eba1b6463e70a4a8ab554c09
AGENTS.md · 3645 · 1f0699b02a1a08c044601c2b55d10a86cf26378903f6613f2aed4f02db4917ff
scenes/dsh/AGENTS.md · 3966 · e096ca7560e63890df6f917ee4173dff116f2a83582e886c174e97b425f505b1
```

字段依次是**注入时的路径、UTF-8 字节数、sha256**。字节数和摘要都从日志里记录下来的指令正文计算，**不会**回读磁盘上的当前文件，因此：

- 文件在会话之后被改过，清单仍是当时注入的内容；
- 文件被指令预算截断时，清单记录的是实际注入的截断内容；
- 会话没有注入任何 AGENTS.md 时，stdout 为空、退出码 0。

文件内容里即使出现 `Instructions from: …` 这样的行，也不会被当成分节标题：分节以该条消息 `changes` 里登记的文件为准。

## 目录汇总

`report` 递归收集目录下所有名为 `session.v4.jsonl.zstd` 的文件，输出一个 JSON：

```json
{
  "directory": "/Users/you/.dsh/sessions",
  "sessionCount": 2,
  "messageCount": 5,
  "toolCalls": {
    "total": 3,
    "byName": [
      { "name": "bash", "count": 2 },
      { "name": "read", "count": 1 }
    ]
  },
  "tokenUsage": {
    "inputTokens": 10,
    "outputTokens": 5,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalTokens": 15
  },
  "sessions": [
    {
      "path": "alpha/session.v4.jsonl.zstd",
      "id": "alpha",
      "messageCount": 2,
      "toolCallCount": 2,
      "tokenUsage": { "inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 0, "cacheWriteTokens": 0, "totalTokens": 15 }
    }
  ],
  "errors": []
}
```

口径：

- `messageCount` 是 `user/message` + `assistant/message` 的条数，不含工具结果和系统消息；
- `toolCalls` 按 `tool/call` 记录里的工具名计数，`byName` 按次数降序；没有名字的调用记为 `unknown`；
- `tokenUsage` 汇总日志中 `assistant/message.usage` 的字段；会话没有 usage 记录时为 `null`；
- `sessions[].path` 是相对输入目录、用 `/` 分隔的路径；
- 单个日志损坏不会中断整份报告：问题写进 `errors`，健康会话照常汇总；此时仍打印 JSON，但退出码为 1，提示报告不完整；
- 目录本身不可读时退出码为 1，原因写到 stderr。

整个工具只读：不会写、改、删任何日志。

## 多帧的坑

DSH 的 `session.v4.jsonl.zstd` 不是单一 zstd 流，而是**多个独立 zstd frame 首尾直接拼接**。`node:zlib` 的 `zstdDecompressSync()` / `createZstdDecompress()` 遇到第一个 frame 结束就停止，后面的 frame 会被丢掉——实测一个 41246 字节的文件只能解出 228 字节。

因此工具先按 zstd 的 frame header / block header 逐帧算出边界，再逐帧解压并拼接。不要用搜索 zstd 魔数（`28 B5 2F FD`）的方式切帧：压缩数据内部也可能出现同样的字节序列，搜魔数会把 frame 切错。

## 测试

```sh
npm test
```

测试用内置的 `node:test`。两帧夹具是把两段 JSONL 分别用 `zstdCompressSync` 压缩，再把两段压缩结果直接拼接，和真实文件形态一致；另外覆盖单帧、三帧、流式压缩（无 content size）、checksum、截断/垃圾输入和 CLI 错误退出。注入清单覆盖空注入、单文件、多文件链、后续替换/新增/删除、替换 baseline、正文里伪造标题；目录汇总覆盖递归多会话、空目录、没有会话文件的目录、无 usage 会话和损坏日志。
