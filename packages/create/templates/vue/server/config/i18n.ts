import { defineI18nConfig } from '@hazejs/core'

// 多语言：翻译文件在 lang/<语言>/*.ts，用 t('messages.xxx') 读取；
// 存在本文件时，校验错误与框架的异常消息（401 / 403 / 404 / 429 ...）也会按请求的语言翻译
export default defineI18nConfig({
  defaultLocale: 'zh-CN',
  // 当前语言缺少某条翻译时使用的语言
  fallbackLocale: 'en',
  locales: ['zh-CN', 'en'],
  // 依次检测：?lang=en → Cookie locale → Accept-Language
  detect: ['query:lang', 'cookie:locale', 'header'],
})
