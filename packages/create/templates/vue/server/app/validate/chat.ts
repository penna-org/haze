import * as v from 'valibot'

/** 对话消息：与 @hazejs/ai 的 Message 格式一致（前端 useChat 直接发送） */
const MessageSchema = v.looseObject({
  role: v.picklist(['user', 'assistant', 'tool'], 'role 不正确'),
  content: v.union([
    v.string(),
    v.array(v.looseObject({
      type: v.string(),
    })),
  ]),
})

export const ChatSchema = v.object({
  messages: v.pipe(v.array(MessageSchema), v.minLength(1, '至少需要一条消息'), v.maxLength(100, '对话过长')),
})
