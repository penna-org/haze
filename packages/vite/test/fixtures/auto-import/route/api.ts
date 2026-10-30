// defineRoutes（@hazejs/core 的预设）、控制器、事件与 FarewellService 都没有手写导入
export default defineRoutes((r) => {
  r.get('/hello', [HelloController, 'index'])
  r.get('/event', () => ({ event: UserRegistered.name }))
  // FarewellService 在测试中才创建
  r.get('/bye', () => ({
    message: new FarewellService().bye(),
  }))
})
