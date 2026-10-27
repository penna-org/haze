import * as v from 'valibot'

export const UserIdParams = v.object({
  id: v.pipe(v.string(), v.transform(Number), v.integer('用户 ID 必须是整数')),
})

export const CreateUserSchema = v.object({
  name: v.pipe(v.string('名称必填'), v.trim(), v.minLength(2, '名称至少 2 个字符')),
  email: v.pipe(v.string('邮箱必填'), v.email('邮箱格式不正确')),
})

export const UpdateUserSchema = v.partial(CreateUserSchema)

export type CreateUserInput = v.InferOutput<typeof CreateUserSchema>
export type UpdateUserInput = v.InferOutput<typeof UpdateUserSchema>
