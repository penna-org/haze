import * as v from 'valibot'

export const RegisterSchema = v.object({
  name: v.pipe(v.string('名称必填'), v.trim(), v.minLength(1, '名称不能为空')),
  email: v.pipe(v.string('邮箱必填'), v.email('邮箱格式不正确')),
  password: v.pipe(v.string('密码必填'), v.minLength(8, '密码至少 8 位')),
})

export const LoginSchema = v.object({
  email: v.pipe(v.string('邮箱必填'), v.email('邮箱格式不正确')),
  password: v.pipe(v.string('密码必填'), v.minLength(1, '密码必填')),
})

export const AvatarSchema = v.object({
  avatar: v.pipe(
    v.file('请选择图片'),
    v.mimeType(['image/png', 'image/jpeg', 'image/webp'], '只支持 png / jpeg / webp'),
    v.maxSize(2 * 1024 * 1024, '图片不能超过 2MB'),
  ),
})

export const CreateTokenSchema = v.object({
  name: v.pipe(v.string('名称必填'), v.trim(), v.minLength(1, '名称不能为空'), v.maxLength(100, '名称最多 100 个字符')),
  // 能力（abilities:posts:write 中间件检查）；省略时为全部能力 ['*']
  abilities: v.optional(v.array(v.picklist(['users:read', 'users:write'], '未知的能力'))),
  expiresInDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365))),
})

export const ForgotPasswordSchema = v.object({
  email: v.pipe(v.string('邮箱必填'), v.email('邮箱格式不正确')),
})

export const ResetPasswordSchema = v.object({
  email: v.pipe(v.string('邮箱必填'), v.email('邮箱格式不正确')),
  token: v.pipe(v.string('令牌必填'), v.minLength(1, '令牌必填')),
  password: v.pipe(v.string('密码必填'), v.minLength(8, '密码至少 8 位')),
})
