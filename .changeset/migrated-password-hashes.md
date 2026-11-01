---
'@hazejs/core': minor
'@hazejs/orm': minor
'@hazejs/vite': patch
---

`Hash.verify()` 支持校验从其它系统迁移来的 bcrypt（`$2a$` / `$2b$` / `$2y$`，可选依赖 `bcryptjs`）与 argon2（`$argon2id$` / `$argon2i$` / `$argon2d$`，Node ≥ 24.7 与 Bun 使用 `node:crypto`，更早的 Node 使用可选依赖 `hash-wasm`）哈希，`Hash.needsRehash()` 对它们返回 true；缺少依赖时抛出带安装提示的错误。`modelUserProvider` 新增 `rehash` 选项（默认 true）：登录成功后把过时的哈希换成 `Hash.make()` 的结果并保存。格式无法解析的哈希串现在返回 false，而不是抛出 base64 解码错误。
