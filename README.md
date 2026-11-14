# dsh-inspect
看一个 DSH 会话到底被注入了什么：多帧 zstd 解码 + 注入清单 + 漂移检测

## 用法

```sh
node bin/dsh-inspect.js /path/to/session.v4.jsonl.zstd
```

解码后的完整 JSONL 写到 stdout。用法错误、读文件失败、输入不是 zstd、frame 截断或尾部有多余字节时，原因写到 stderr 并以非 0 退出——不会静默输出空内容。

需要 Node.js 22.15+ 或 23.8+（使用 `node:zlib` 内置的 zstd 支持），无第三方依赖。

## 多帧的坑

DSH 的 `session.v4.jsonl.zstd` 不是单一 zstd 流，而是**多个独立 zstd frame 首尾直接拼接**。`node:zlib` 的 `zstdDecompressSync()` / `createZstdDecompress()` 遇到第一个 frame 结束就停止，后面的 frame 会被丢掉——实测一个 41246 字节的文件只能解出 228 字节。

因此工具先按 zstd 的 frame header / block header 逐帧算出边界，再逐帧解压并拼接。不要用搜索 zstd 魔数（`28 B5 2F FD`）的方式切帧：压缩数据内部也可能出现同样的字节序列，搜魔数会把 frame 切错。

## 测试

```sh
npm test
```

测试用内置的 `node:test`。两帧夹具是把两段 JSONL 分别用 `zstdCompressSync` 压缩，再把两段压缩结果直接拼接，和真实文件形态一致；另外覆盖单帧、三帧、流式压缩（无 content size）、checksum、截断/垃圾输入和 CLI 错误退出。
