import { defineMailConfig, env } from '@hazejs/core'

/**
 * 邮件：await Mail.to(user.email).send(WelcomeMail, { name })，排队发送用 .queue() / .later('10m', ...)。
 * 开发环境默认 log（只写日志）；本地查看真实邮件可运行 Mailpit 并设置 MAIL_MAILER=smtp MAIL_PORT=1025。
 */
export default defineMailConfig(() => ({
  default: env('MAIL_MAILER', 'log'),
  from: {
    address: env('MAIL_FROM_ADDRESS', 'hello@example.com'),
    name: env('MAIL_FROM_NAME', '{{name}}'),
  },
  mailers: {
    // 需要 pnpm add nodemailer（Cloudflare Workers 不支持 SMTP，请用下面的 HTTP 接口驱动）
    smtp: {
      driver: 'smtp',
      host: env('MAIL_HOST', '127.0.0.1'),
      port: env('MAIL_PORT', 1025),
      username: env('MAIL_USERNAME', ''),
      password: env('MAIL_PASSWORD', ''),
    },
    resend: {
      driver: 'resend',
      key: env('RESEND_API_KEY', ''),
    },
    // postmark: { driver: 'postmark', token: env('POSTMARK_TOKEN', '') },
    // mailgun: { driver: 'mailgun', key: env('MAILGUN_SECRET', ''), domain: env('MAILGUN_DOMAIN', '') },
    // 需要 pnpm add @aws-sdk/client-sesv2
    // ses: { driver: 'ses', region: env('AWS_REGION', 'us-east-1') },
  },
}))
