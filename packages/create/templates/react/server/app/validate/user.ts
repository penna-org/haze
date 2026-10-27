import * as v from 'valibot'

export const UserIdParams = v.object({
  id: v.pipe(v.string(), v.transform(Number), v.integer('用户 ID 必须是整数')),
})

export const CreateUserSchema = v.object({
  name: v.pipe(v.string('名称必填'), v.trim(), v.minLength(1, '名称不能为空')),
  email: v.pipe(v.string('邮箱必填'), v.email('邮箱格式不正确')),
})

export const UpdateUserSchema = v.partial(CreateUserSchema)
