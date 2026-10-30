/**
 * 框架内置的翻译（校验错误与 HTTP 异常），项目的 `lang/<locale>/validation.ts`、`lang/<locale>/http.ts` 可逐条覆盖。
 *
 * 校验消息的占位符：`{attribute}` 字段名（`validation.attributes` 中可设置显示名），
 * `{min}` / `{max}` / `{size}` 长度或数值界限，`{values}` 可选值。
 */
export const en = {
  validation: {
    failed: 'The given data was invalid.',
    required: 'The {attribute} field is required.',
    string: 'The {attribute} field must be a string.',
    number: 'The {attribute} field must be a number.',
    integer: 'The {attribute} field must be an integer.',
    boolean: 'The {attribute} field must be true or false.',
    array: 'The {attribute} field must be an array.',
    object: 'The {attribute} field must be an object.',
    date: 'The {attribute} field must be a valid date.',
    file: 'The {attribute} field must be a file.',
    email: 'The {attribute} field must be a valid email address.',
    url: 'The {attribute} field must be a valid URL.',
    uuid: 'The {attribute} field must be a valid UUID.',
    ip: 'The {attribute} field must be a valid IP address.',
    regex: 'The {attribute} field format is invalid.',
    in: 'The selected {attribute} is invalid.',
    multiple_of: 'The {attribute} field must be a multiple of {value}.',
    unknown_keys: 'The {attribute} field contains unknown keys: {keys}.',
    mimes: 'The {attribute} field must be a file of type: {values}.',
    min: {
      string: 'The {attribute} field must be at least {min} characters.',
      number: 'The {attribute} field must be at least {min}.',
      array: 'The {attribute} field must have at least {min} items.',
      file: 'The {attribute} field must be at least {min}.',
    },
    max: {
      string: 'The {attribute} field must not be greater than {max} characters.',
      number: 'The {attribute} field must not be greater than {max}.',
      array: 'The {attribute} field must not have more than {max} items.',
      file: 'The {attribute} field must not be greater than {max}.',
    },
    size: {
      string: 'The {attribute} field must be {size} characters.',
      array: 'The {attribute} field must contain {size} items.',
    },
    invalid: 'The {attribute} field is invalid.',
    /** 字段显示名：`attributes: { email: 'email address' }` */
    attributes: {} as Record<string, string>,
  },
  http: {
    400: 'Bad Request',
    401: 'Unauthenticated.',
    403: 'This action is unauthorized.',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    413: 'Payload Too Large',
    419: 'Page Expired',
    422: 'The given data was invalid.',
    429: 'Too Many Requests',
    500: 'Server Error',
    503: 'Service Unavailable',
    route_not_found: 'Cannot find any route matching [{method}] {path}',
    invalid_signature: 'Invalid signature.',
    /** @hazejs/orm 的 UniqueConstraintException */
    unique_violation: 'The record already exists.',
    maintenance: 'The application is down for maintenance. Please check back soon.',
    maintenance_title: 'Down for maintenance',
  },
}

export type FrameworkMessages = typeof en

export const zhCN: FrameworkMessages = {
  validation: {
    failed: '提交的数据不合法',
    required: '{attribute}不能为空',
    string: '{attribute}必须是字符串',
    number: '{attribute}必须是数字',
    integer: '{attribute}必须是整数',
    boolean: '{attribute}必须是布尔值',
    array: '{attribute}必须是数组',
    object: '{attribute}必须是对象',
    date: '{attribute}必须是有效的日期',
    file: '{attribute}必须是文件',
    email: '{attribute}必须是有效的邮箱地址',
    url: '{attribute}必须是有效的 URL',
    uuid: '{attribute}必须是有效的 UUID',
    ip: '{attribute}必须是有效的 IP 地址',
    regex: '{attribute}格式不正确',
    in: '所选的{attribute}无效',
    multiple_of: '{attribute}必须是 {value} 的倍数',
    unknown_keys: '{attribute}包含未知的字段：{keys}',
    mimes: '{attribute}必须是以下类型的文件：{values}',
    min: {
      string: '{attribute}至少为 {min} 个字符',
      number: '{attribute}不能小于 {min}',
      array: '{attribute}至少需要 {min} 项',
      file: '{attribute}不能小于 {min}',
    },
    max: {
      string: '{attribute}不能超过 {max} 个字符',
      number: '{attribute}不能大于 {max}',
      array: '{attribute}不能超过 {max} 项',
      file: '{attribute}不能大于 {max}',
    },
    size: {
      string: '{attribute}必须为 {size} 个字符',
      array: '{attribute}必须为 {size} 项',
    },
    invalid: '{attribute}无效',
    attributes: {},
  },
  http: {
    400: '请求无效',
    401: '未登录或登录已过期',
    403: '无权执行此操作',
    404: '未找到',
    405: '请求方法不被允许',
    409: '资源冲突',
    413: '请求体过大',
    419: 'CSRF token 无效或已过期，请刷新页面后重试',
    422: '提交的数据不合法',
    429: '请求过于频繁，请稍后再试',
    500: '服务器错误',
    503: '服务暂不可用',
    route_not_found: '找不到与 [{method}] {path} 匹配的路由',
    invalid_signature: '签名无效或链接已过期',
    unique_violation: '数据已存在（违反唯一约束）',
    maintenance: '系统正在维护，请稍后再访问。',
    maintenance_title: '系统维护中',
  },
}

/** 按语言提供的框架翻译 */
export const frameworkMessages: Record<string, FrameworkMessages> = {
  'en': en,
  'zh-CN': zhCN,
}
