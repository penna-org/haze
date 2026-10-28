import type { MailTransport } from '../types'
import { formatAddress } from '../address'

export interface SesMailerConfig {
  driver: 'ses'
  region?: string
  /** 省略时使用 AWS SDK 的默认凭证链（环境变量、IAM 角色等） */
  accessKeyId?: string
  secretAccessKey?: string
  /** 覆盖接口地址（本地模拟 / VPC 终端节点） */
  endpoint?: string
  /** 配置集（事件发布 / 跟踪） */
  configurationSet?: string
}

/** Amazon SES（@aws-sdk/client-sesv2） */
export function sesTransport(config: SesMailerConfig): MailTransport {
  let client: Promise<{ sdk: typeof import('@aws-sdk/client-sesv2'), ses: import('@aws-sdk/client-sesv2').SESv2Client }> | undefined
  const connect = (): NonNullable<typeof client> => {
    client ??= import('@aws-sdk/client-sesv2').then(sdk => ({
      sdk,
      ses: new sdk.SESv2Client({
        region: config.region ?? 'us-east-1',
        endpoint: config.endpoint,
        ...(config.accessKeyId && config.secretAccessKey && {
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        }),
      }),
    }), (error) => {
      client = undefined
      throw new Error('Mail driver "ses" requires @aws-sdk/client-sesv2. Install it with: pnpm add @aws-sdk/client-sesv2', { cause: error })
    })
    return client
  }
  const content = (data: string): { Data: string, Charset: string } => ({ Data: data, Charset: 'UTF-8' })
  return {
    driver: 'ses',
    async send(message) {
      const { sdk, ses } = await connect()
      const result = await ses.send(new sdk.SendEmailCommand({
        FromEmailAddress: formatAddress(message.from),
        Destination: {
          ToAddresses: message.to.map(formatAddress),
          CcAddresses: message.cc.map(formatAddress),
          BccAddresses: message.bcc.map(formatAddress),
        },
        ReplyToAddresses: message.replyTo.map(formatAddress),
        ConfigurationSetName: config.configurationSet,
        EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })),
        Content: {
          Simple: {
            Subject: content(message.subject),
            Body: {
              ...(message.html && {
                Html: content(message.html),
              }),
              ...(message.text && {
                Text: content(message.text),
              }),
            },
            Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
            ...(message.attachments.length && {
              Attachments: message.attachments.map(item => ({
                FileName: item.filename,
                RawContent: item.content,
                ContentType: item.contentType,
                ContentDisposition: item.cid ? 'INLINE' : 'ATTACHMENT',
                ...(item.cid && { ContentId: item.cid }),
              })),
            }),
          },
        },
      }))
      return { messageId: result.MessageId }
    },
    close() {
      void client?.then(({ ses }) => ses.destroy(), () => {})
      client = undefined
    },
  }
}
