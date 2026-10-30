export class UserController {
  private users: UserService = new UserService()
  private box: Box = new Box(1)
  role: Role = Role.Admin

  index(): UserDto[] {
    return this.users.list().map((_, id) => ({ id }))
  }

  run(): unknown[] {
    const parsed: ParsedPath = path.parse('/a/b.txt')
    return [
      UserRegistered.emit({ name: 'ada' }),
      sendReceipt(7),
      new OrderService().total(),
      formatName('ada'),
      ErrorCode.EmailTaken,
      new Named('named').value,
      this.box.value,
      this.role,
      basename(parsed.base, '.txt'),
    ]
  }

  errors(): unknown {
    // @ts-expect-error 方法不存在
    this.users.nope()
    // @ts-expect-error payload 类型错误
    UserRegistered.emit({ name: 1 })
    // @ts-expect-error 违反泛型约束（约束引用了源文件私有的类型）
    const box: Box<string> = new Box('x')
    // @ts-expect-error 类型别名
    const id: UserId = 'x'
    // @ts-expect-error 默认导出的泛型类
    const named: Named<number> = new Named('x')
    // @ts-expect-error 再导出的类型
    const format: Formatter = (value: number) => value
    return [box, id, named, format]
  }
}
