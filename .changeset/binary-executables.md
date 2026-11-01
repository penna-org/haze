---
'@hazejs/vite': minor
'@hazejs/cli': minor
---

新增 `haze build --compile`（`binary` 预设）：用 Bun 把后端编译为 Linux / macOS / Windows 的独立可执行文件，可在任意系统上交叉编译（`--target linux-x64,darwin-arm64,windows-x64`，或 `haze.config.ts` 的 `binary.targets`）。Web 服务、`migrate` 与 `worker` 是同一个可执行文件的子命令；libsql 的原生模块按目标平台嵌入（其它平台的从 npm registry 下载），pglite 的 WASM 与数据文件一并嵌入。`haze start` / `haze preview` 运行当前平台的可执行文件。默认构建方式不变。
