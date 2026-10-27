export interface NameParts {
  /** 子目录，例如 `admin` */
  dir: string
  /** PascalCase 名称（已去除类型后缀），例如 `UserProfile` */
  name: string
}

/** `admin/user-profile`、`Admin/UserProfileController` → { dir: 'admin', name: 'UserProfile' } */
export function parseName(input: string, suffix = ''): NameParts {
  const segments = input.replace(/\\/g, '/').split('/').filter(Boolean)
  const last = segments.pop()
  if (!last)
    throw new Error('Name is required')
  let name = pascalCase(last)
  if (suffix && name.endsWith(suffix) && name !== suffix)
    name = name.slice(0, -suffix.length)
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name))
    throw new Error(`Invalid name "${input}"`)
  return {
    dir: segments.map(kebabCase).join('/'),
    name,
  }
}

export function pascalCase(value: string): string {
  return value
    .replace(/[-_\s]+(.)?/g, (_, char: string | undefined) => (char ?? '').toUpperCase())
    .replace(/^./, char => char.toUpperCase())
}

export function camelCase(value: string): string {
  const pascal = pascalCase(value)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

export function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
}

/** 简单的英文复数，用于路由路径提示 */
export function plural(value: string): string {
  if (/(?:[sxz]|ch|sh)$/.test(value))
    return `${value}es`
  if (/[^aeiou]y$/.test(value))
    return `${value.slice(0, -1)}ies`
  return `${value}s`
}
