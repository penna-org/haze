import { fromBase64Url, toBase64Url } from './key'

/**
 * 密码哈希。默认 scrypt（node:crypto，Node / Bun / Deno / Workers nodejs_compat 均可用），
 * 不可用时使用 PBKDF2-SHA256（Web Crypto）。哈希串自带算法与参数：
 * `$scrypt$n=16384,r=8,p=1$<salt>$<hash>` / `$pbkdf2-sha256$i=600000$<salt>$<hash>`
 */
export interface HashOptions {
  algorithm?: 'scrypt' | 'pbkdf2'
  /** scrypt 的 N（CPU / 内存成本），默认 16384 */
  cost?: number
  /** PBKDF2 迭代次数，默认 600000（OWASP 2023） */
  iterations?: number
}

const DEFAULTS = {
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  iterations: 600_000,
  keyLength: 32,
}

type Scrypt = (password: string, salt: Uint8Array, keylen: number, options: { N: number, r: number, p: number, maxmem: number }, callback: (error: Error | null, key: Uint8Array) => void) => void

let scryptImpl: Promise<Scrypt | undefined> | undefined

function loadScrypt(): Promise<Scrypt | undefined> {
  scryptImpl ??= import('node:crypto').then(module => module.scrypt as unknown as Scrypt, () => undefined)
  return scryptImpl
}

async function scrypt(password: string, salt: Uint8Array, n: number, r: number, p: number): Promise<Uint8Array | undefined> {
  const impl = await loadScrypt()
  if (!impl)
    return undefined
  return new Promise((resolve, reject) => impl(password, salt, DEFAULTS.keyLength, { N: n, r, p, maxmem: 256 * n * r }, (error, key) => error
    ? reject(error)
    : resolve(new Uint8Array(key))))
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: salt as Uint8Array<ArrayBuffer>,
    iterations,
  }, key, DEFAULTS.keyLength * 8)
  return new Uint8Array(bits)
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false
  let diff = 0
  for (let index = 0; index < a.length; index++)
    diff |= a[index] ^ b[index]
  return diff === 0
}

function parse(hash: string): { algorithm: string, params: Record<string, number>, salt: Uint8Array, key: Uint8Array } | undefined {
  const [, algorithm, params, salt, key] = hash.split('$')
  if (!algorithm || !params || !salt || !key)
    return undefined
  return {
    algorithm,
    params: Object.fromEntries(params.split(',').map(pair => pair.split('=')).map(([name, value]) => [
      name,
      Number(value),
    ])),
    salt: fromBase64Url(salt),
    key: fromBase64Url(key),
  }
}

export const Hash = {
  async make(password: string, options: HashOptions = {}): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    if ((options.algorithm ?? 'scrypt') === 'scrypt') {
      const n = options.cost ?? DEFAULTS.cost
      const key = await scrypt(password, salt, n, DEFAULTS.blockSize, DEFAULTS.parallelization)
      if (key)
        return `$scrypt$n=${n},r=${DEFAULTS.blockSize},p=${DEFAULTS.parallelization}$${toBase64Url(salt)}$${toBase64Url(key)}`
    }
    const iterations = options.iterations ?? DEFAULTS.iterations
    return `$pbkdf2-sha256$i=${iterations}$${toBase64Url(salt)}$${toBase64Url(await pbkdf2(password, salt, iterations))}`
  },

  async verify(hash: string, password: string): Promise<boolean> {
    const parsed = parse(hash)
    if (!parsed)
      return false
    const { algorithm, params, salt, key } = parsed
    if (algorithm === 'scrypt') {
      const derived = await scrypt(password, salt, params.n, params.r, params.p)
      return Boolean(derived && equal(derived, key))
    }
    if (algorithm === 'pbkdf2-sha256')
      return equal(await pbkdf2(password, salt, params.i), key)
    return false
  },

  /** 哈希的算法或参数与当前设置不一致时返回 true（登录成功后可重新哈希保存） */
  needsRehash(hash: string, options: HashOptions = {}): boolean {
    const parsed = parse(hash)
    if (!parsed)
      return true
    if ((options.algorithm ?? 'scrypt') === 'scrypt')
      return parsed.algorithm !== 'scrypt' || parsed.params.n !== (options.cost ?? DEFAULTS.cost)
    return parsed.algorithm !== 'pbkdf2-sha256' || parsed.params.i !== (options.iterations ?? DEFAULTS.iterations)
  },
}
