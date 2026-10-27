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
