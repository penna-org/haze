/**
 * 中文翻译：t('messages.welcome_mail.subject', { name: 'Ada' })。
 * {name} 为占位符；复数用 { one, other } 并传入 count：t('messages.users', { count: 3 })。
 * 校验消息与字段名可在 lang/zh-CN/validation.ts 中覆盖（如 attributes: { email: '邮箱' }）。
 */
export default {
  welcome_mail: {
    subject: '欢迎加入，{name}',
    greeting: '你好，{name}',
  },
  users: {
    other: '共 {count} 位用户',
  },
}
