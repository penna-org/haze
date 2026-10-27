# {{name}}

基于 think-h3 的 Node 服务端项目。

## 命令

```bash
pnpm dev        # 开发服务器，修改代码即时生效（进程不重启）
pnpm routes     # 查看路由表
pnpm test       # 运行测试
pnpm build      # 构建到 dist/
pnpm start      # 运行构建产物
```

## 目录

```
app/
  controller/   控制器：接收参数、调用服务、返回数据
  service/      业务服务（默认单例，通过 inject() 注入）
  validate/     请求校验（valibot，任何 Standard Schema 库均可）
  middleware/   中间件
  exception/    全局异常处理 Handler.ts
  provider/     服务提供者：注册绑定、启动逻辑
config/         配置（文件名即配置键，如 config/app.ts → config('app.name')）
route/          路由（集中定义）
tests/          测试（@think-h3/testing）
```
