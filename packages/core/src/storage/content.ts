import type { PutContent } from './types'

const encoder = new TextEncoder()

export async function toBytes(content: PutContent): Promise<Uint8Array> {
  if (typeof content === 'string')
    return encoder.encode(content)
  if (content instanceof Uint8Array)
    return content
  if (content instanceof ArrayBuffer)
    return new Uint8Array(content)
  if (content instanceof Blob)
    return new Uint8Array(await content.arrayBuffer())
  return new Uint8Array(await new Response(content).arrayBuffer())
}

export function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}
