/** 时间条件的输入：Date、毫秒数或可被解析的日期字符串（`2024-05-01`、`2024-05-01 08:00:00`） */
export type TimeInput = Date | string | number

/** 时间区间关键字（whereTime 两个参数时使用） */
export type TimeKeyword = 'today' | 'yesterday' | 'week' | 'last week' | 'month' | 'last month' | 'year' | 'last year'

export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

/** 解析为本地时间（`2024-05-01` 这类纯日期按本地零点，而不是 Date 默认的 UTC） */
export function toDate(value: TimeInput): Date {
  if (value instanceof Date)
    return new Date(value.getTime())
  if (typeof value === 'number')
    return new Date(value)
  const match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(value.trim())
  if (match) {
    const [, year, month, day = '1', hour = '0', minute = '0', second = '0'] = match
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    throw new TypeError(`Invalid time "${value}"`)
  return date
}

export function addTime(date: Date, unit: TimeUnit, step: number): Date {
  const result = new Date(date.getTime())
  switch (unit) {
    case 'second': result.setSeconds(result.getSeconds() + step)
      break
    case 'minute': result.setMinutes(result.getMinutes() + step)
      break
    case 'hour': result.setHours(result.getHours() + step)
      break
    case 'day': result.setDate(result.getDate() + step)
      break
    case 'week': result.setDate(result.getDate() + step * 7)
      break
    case 'month': result.setMonth(result.getMonth() + step)
      break
    case 'year': result.setFullYear(result.getFullYear() + step)
      break
  }
  return result
}

function startOf(date: Date, unit: 'day' | 'week' | 'month' | 'year'): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (unit === 'week')
    result.setDate(result.getDate() - (result.getDay() + 6) % 7) // 周一为一周的开始
  if (unit === 'month' || unit === 'year')
    result.setDate(1)
  if (unit === 'year')
    result.setMonth(0)
  return result
}

/** 某个时间所在的整天 / 周 / 月 / 年：[开始, 下一个周期开始) */
export function periodOf(unit: 'day' | 'week' | 'month' | 'year', value: TimeInput | undefined, offset = 0): [Date, Date] {
  const start = addTime(startOf(value === undefined
    ? new Date()
    : toDate(value), unit), unit, offset)
  return [
    start,
    addTime(start, unit, 1),
  ]
}

export function keywordRange(keyword: TimeKeyword): [Date, Date] {
  switch (keyword) {
    case 'today': return periodOf('day', undefined)
    case 'yesterday': return periodOf('day', undefined, -1)
    case 'week': return periodOf('week', undefined)
    case 'last week': return periodOf('week', undefined, -1)
    case 'month': return periodOf('month', undefined)
    case 'last month': return periodOf('month', undefined, -1)
    case 'year': return periodOf('year', undefined)
    case 'last year': return periodOf('year', undefined, -1)
    default:
      throw new TypeError(`Unknown time keyword "${String(keyword)}"`)
  }
}

export function isTimeKeyword(value: unknown): value is TimeKeyword {
  return typeof value === 'string' && [
    'today',
    'yesterday',
    'week',
    'last week',
    'month',
    'last month',
    'year',
    'last year',
  ].includes(value)
}
