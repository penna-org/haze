export interface Address {
  address: string
  name?: string
}

export type AddressInput = string | Address | Array<string | Address>

export interface Attachment {
  filename: string
  /** 内容（字节或文本）；与 disk / path 二选一 */
  content?: string | Uint8Array
  /** 从存储磁盘读取（发送时读取，排队时只记录路径） */
  disk?: string
  path?: string
  contentType?: string
  /** 内嵌图片：HTML 中用 `<img src="cid:logo">` 引用 */
  cid?: string
}

/** 邮件内容（defineMail 的返回值，或 Mail.send() 的原始消息） */
export interface MailContent {
  subject: string
  html?: string
  /** 纯文本版本，省略时由 html 生成 */
  text?: string
  from?: AddressInput
  replyTo?: AddressInput
  cc?: AddressInput
  bcc?: AddressInput
  attachments?: Attachment[]
  headers?: Record<string, string>
  /** 服务商标签（Resend / Postmark / Mailgun / SES） */
  tags?: Record<string, string>
}

export interface MailMessage extends MailContent {
  to: AddressInput
}

export interface ResolvedAttachment {
  filename: string
  content: Uint8Array
  contentType: string
  cid?: string
}

/** 交给传输驱动的消息：地址已规范化，附件已读取 */
export interface ResolvedMessage {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  subject: string
  html?: string
  text?: string
  attachments: ResolvedAttachment[]
  headers: Record<string, string>
  tags: Record<string, string>
}

export interface SentMessage {
  mailer: string
  /** 服务商返回的消息 ID */
  messageId?: string
}

/** 邮件传输驱动 */
export interface MailTransport {
  readonly driver: string
  send: (message: ResolvedMessage) => Promise<{ messageId?: string }>
  close?: () => Promise<void> | void
}
