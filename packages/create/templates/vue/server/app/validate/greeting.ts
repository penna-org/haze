import * as v from 'valibot'

export const GreetSchema = v.object({
  name: v.pipe(v.string('name 必填'), v.trim(), v.minLength(1, 'name 不能为空'), v.maxLength(50, 'name 最多 50 个字符')),
})
