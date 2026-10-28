import { fromBase64, toBase64 } from './crypto'

type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

const encoder = new TextEncoder()
const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }

/** PEM / 纯 base64 → DER 字节 */
function derOf(key: string): { der: Uint8Array<ArrayBuffer>, label?: string } {
  const text = key.replace(/\\n/g, '\n').trim()
  const label = /-----BEGIN ([A-Z ]+)-----/.exec(text)?.[1]
  const body = text.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '')
  return {
    der: fromBase64(body),
    label,
  }
}

function derLength(length: number): number[] {
  if (length < 0x80)
    return [length]
  const bytes: number[] = []
  while (length > 0) {
    bytes.unshift(length & 0xFF)
    length >>= 8
  }
  return [0x80 | bytes.length, ...bytes]
}

/** PKCS#1（RSAPrivateKey）包装为 PKCS#8（Web Crypto 只支持后者） */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  // AlgorithmIdentifier：rsaEncryption（1.2.840.113549.1.1.1）+ NULL
  const algorithm = [
    0x30,
    0x0D,
    0x06,
    0x09,
    0x2A,
    0x86,
    0x48,
    0x86,
    0xF7,
    0x0D,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ]
  const version = [0x02, 0x01, 0x00]
  const octet = [
    0x04,
    ...derLength(pkcs1.length),
  ]
  const content = version.length + algorithm.length + octet.length + pkcs1.length
  const out = new Uint8Array([
    0x30,
    ...derLength(content),
    ...version,
    ...algorithm,
    ...octet,
    ...pkcs1,
  ])
  return out
}

/** 判断 DER 是否为 PKCS#1：SEQUENCE { INTEGER 0, INTEGER n, ... }（PKCS#8 的第二项是 SEQUENCE） */
function isPkcs1(der: Uint8Array): boolean {
  let offset = 1
  const first = der[offset]
  offset += first & 0x80
    ? 1 + (first & 0x7F)
    : 1
  // 跳过版本号 02 01 00
  return der[offset] === 0x02 && der[offset + 3] === 0x02
}

const privateKeys = new Map<string, Promise<WebCryptoKey>>()
const publicKeys = new Map<string, Promise<WebCryptoKey>>()

/** 导入 RSA 私钥：支持 PKCS#8 / PKCS#1 的 PEM，或支付宝开放平台工具生成的纯 base64 */
export function importRsaPrivateKey(key: string): Promise<WebCryptoKey> {
  let imported = privateKeys.get(key)
  if (!imported) {
    const { der, label } = derOf(key)
    const pkcs8 = label === 'RSA PRIVATE KEY' || (!label && isPkcs1(der))
      ? pkcs1ToPkcs8(der)
      : der
    imported = crypto.subtle.importKey('pkcs8', pkcs8, ALGORITHM, false, ['sign'])
    imported.catch(() => privateKeys.delete(key))
    privateKeys.set(key, imported)
  }
  return imported
}

/** 导入 RSA 公钥（SPKI 的 PEM 或纯 base64，如支付宝公钥） */
export function importRsaPublicKey(key: string): Promise<WebCryptoKey> {
  let imported = publicKeys.get(key)
  if (!imported) {
    imported = crypto.subtle.importKey('spki', derOf(key).der, ALGORITHM, false, ['verify'])
    imported.catch(() => publicKeys.delete(key))
    publicKeys.set(key, imported)
  }
  return imported
}

/** RSA2（SHA256withRSA）签名，返回 base64 */
export async function rsaSign(content: string, privateKey: string): Promise<string> {
  const signature = await crypto.subtle.sign(ALGORITHM, await importRsaPrivateKey(privateKey), encoder.encode(content))
  return toBase64(new Uint8Array(signature))
}

/** 校验 RSA2 签名 */
export async function rsaVerify(content: string, signature: string, publicKey: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(ALGORITHM, await importRsaPublicKey(publicKey), fromBase64(signature), encoder.encode(content))
  }
  catch {
    return false
  }
}
