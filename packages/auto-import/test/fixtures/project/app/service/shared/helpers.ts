export function formatName(name: string): string {
  return name.toUpperCase()
}

export type Formatter = (name: string) => string
