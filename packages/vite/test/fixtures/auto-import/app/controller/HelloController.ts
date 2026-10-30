export class HelloController {
  private greeter = inject(GreetService)

  index() {
    return {
      message: this.greeter.greet(),
    }
  }

  /** 只在类型位置使用：不产生运行时导入 */
  typed(service: TypedOnlyService): TypedOnlyService {
    return service
  }
}
