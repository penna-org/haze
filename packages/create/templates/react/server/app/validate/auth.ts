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
