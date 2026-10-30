export function ms(value: unknown): string {
  if (typeof value !== 'number' || Number.isNaN(value))
    return '–'
  if (value >= 1000)
    return `${(value / 1000).toFixed(2)} s`
  if (value >= 10)
    return `${Math.round(value)} ms`
  return `${value.toFixed(1)} ms`
}

export function clock(time: number): string {
  return new Date(time).toLocaleTimeString(undefined, { hour12: false })
}

export function ago(time: number | string | undefined): string {
  if (time === undefined)
    return '–'
  const diff = new Date(time).getTime() - Date.now()
  const abs = Math.abs(diff)
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1000, 'second'],
  ]
  const [size, unit] = units.find(([size]) => abs >= size) ?? [1000, 'second']
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff / size), unit)
}

export function tokens(value: number): string {
  return value >= 10_000
    ? `${(value / 1000).toFixed(1)}k`
    : String(value)
}

export function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
}

export function statusClass(status: number): string {
  if (status >= 500)
    return 'bad'
  if (status >= 400)
    return 'warn'
  return 'ok'
}
