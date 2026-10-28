import type { Address, AddressInput } from './types'

/** `"Ada <ada@example.com>"` / `"ada@example.com"` / `{ address, name }` → Address[] */
export function normalizeAddresses(input: AddressInput | undefined): Address[] {
  if (!input)
    return []
  const list = Array.isArray(input)
    ? input
    : [input]
  return list.map((item) => {
    if (typeof item !== 'string')
      return item
    const value = item.trim()
    const open = value.lastIndexOf('<')
    if (open === -1 || !value.endsWith('>'))
      return { address: value }
    const name = value.slice(0, open).trim().replace(/^"(.*)"$/, '$1')
    return {
      address: value.slice(open + 1, -1).trim(),
      ...(name && { name }),
    }
  })
}

/** `Name <address>`，名称含特殊字符时加引号 */
export function formatAddress(address: Address): string {
  if (!address.name)
    return address.address
  const name = /[",<>@;:()[\]\\]/.test(address.name)
    ? `"${address.name.replace(/["\\]/g, '\\$&')}"`
    : address.name
  return `${name} <${address.address}>`
}
