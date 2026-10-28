import type { Logger } from '../../logger'
import type { MailTransport, ResolvedMessage } from '../types'
import { formatAddress } from '../address'

/** 只写日志（开发环境默认） */
export function logTransport(logger: Logger): MailTransport {
  return {
    driver: 'log',
    async send(message) {
      const messageId = `<${crypto.randomUUID()}@think-h3.log>`
      logger.info(`Mail "${message.subject}" → ${message.to.map(formatAddress).join(', ')}`, {
        messageId,
        from: formatAddress(message.from),
        cc: message.cc.map(formatAddress),
        bcc: message.bcc.map(formatAddress),
        attachments: message.attachments.map(item => item.filename),
      })
      if (message.text)
        logger.debug(message.text)
      return { messageId }
    },
  }
}

/** 保存在内存中（测试 / 预览），`transport.messages` 读取 */
export function arrayTransport(): MailTransport & { messages: ResolvedMessage[] } {
  const messages: ResolvedMessage[] = []
  return {
    driver: 'array',
    messages,
    async send(message) {
      messages.push(message)
      return { messageId: `<${crypto.randomUUID()}@think-h3.array>` }
    },
  }
}
