import { fromBase64Url, toBase64Url } from './key'

/**
 * 密码哈希。默认 scrypt（node:crypto，Node / Bun / Deno / Workers nodejs_compat 均可用），
 * 不可用时使用 PBKDF2-SHA256（Web Crypto）。哈希串自带算法与参数：
 * `$scrypt$n=16384,r=8,p=1$<salt>$<hash>` / `$pbkdf2-sha256$i=600000$<salt>$<hash>`
 *
 * 从其它系统迁移来的 bcrypt（`$2a$` / `$2b$` / `$2y$`）与 argon2（`$argon2id$` 等）哈希也能校验，
 * `needsRehash()` 对它们返回 true，登录成功后换成当前算法
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

/** bcrypt：`$2b$<cost>$<22 位盐><31 位哈希>`（PHP 的 `$2y$`、旧版的 `$2a$` 算法相同） */
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/
/** argon2 的 PHC 串：`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`（标准 base64，无填充） */
const ARGON2_RE = /^\$(argon2(?:id|i|d))\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

function isForeign(hash: string): boolean {
  return BCRYPT_RE.test(hash) || ARGON2_RE.test(hash)
}

async function importOptional<T>(name: string, importer: () => Promise<T>, purpose: string): Promise<T> {
  try {
    return await importer()
  }
  catch (error) {
    throw new Error(`Verifying ${purpose} requires ${name}. Install it with: pnpm add ${name}`, { cause: error })
  }
}

async function verifyBcrypt(hash: string, password: string): Promise<boolean> {
  const module = await importOptional('bcryptjs', () => import('bcryptjs'), 'bcrypt hashes')
  return (module.default ?? module).compare(password, hash)
}

type Argon2 = (algorithm: string, params: { message: string, nonce: Uint8Array, parallelism: number, tagLength: number, memory: number, passes: number }, callback: (error: Error | null, key: Uint8Array) => void) => void

let argon2Impl: Promise<Argon2 | undefined> | undefined

/** node:crypto 的 argon2（Node ≥ 24.7、Bun） */
function loadArgon2(): Promise<Argon2 | undefined> {
  argon2Impl ??= import('node:crypto').then(module => (module as { argon2?: Argon2 }).argon2, () => undefined)
  return argon2Impl
}

async function verifyArgon2(hash: string, password: string): Promise<boolean> {
  const [, algorithm, memory, passes, parallelism, salt, key] = ARGON2_RE.exec(hash)!
  const impl = await loadArgon2()
  if (!impl) {
    // 运行时没有 argon2（Node 22、Workers）：使用 hash-wasm（WASM）
    const { argon2Verify } = await importOptional('hash-wasm', () => import('hash-wasm'), 'argon2 hashes on this runtime (Node.js < 24.7)')
    return argon2Verify({ password, hash })
  }
  const expected = fromBase64Url(key)
  const derived = await new Promise<Uint8Array>((resolve, reject) => impl(algorithm, {
    message: password,
    nonce: fromBase64Url(salt),
    parallelism: Number(parallelism),
    tagLength: expected.length,
    memory: Number(memory),
    passes: Number(passes),
  }, (error, result) => error
    ? reject(error)
    : resolve(new Uint8Array(result))))
  return equal(derived, expected)
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
  try {
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
  catch {
    // 盐或哈希不是合法的 base64（其它格式的哈希串）
    return undefined
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

  /**
   * 校验密码（恒定时间比较），格式无法识别时返回 false。
   * bcrypt 哈希需要安装 `bcryptjs`；argon2 哈希在 Node < 24.7 上需要安装 `hash-wasm`，缺少时抛出错误
   */
  async verify(hash: string, password: string): Promise<boolean> {
    if (BCRYPT_RE.test(hash))
      return verifyBcrypt(hash, password)
    if (ARGON2_RE.test(hash))
      return verifyArgon2(hash, password)
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

  /** 哈希的算法或参数与当前设置不一致时返回 true（登录成功后可重新哈希保存；modelUserProvider 会自动处理） */
  needsRehash(hash: string, options: HashOptions = {}): boolean {
    // bcrypt / argon2：只校验不生成，总是换成当前算法
    if (isForeign(hash))
      return true
    const parsed = parse(hash)
    if (!parsed)
      return true
    if ((options.algorithm ?? 'scrypt') === 'scrypt')
      return parsed.algorithm !== 'scrypt' || parsed.params.n !== (options.cost ?? DEFAULTS.cost)
    return parsed.algorithm !== 'pbkdf2-sha256' || parsed.params.i !== (options.iterations ?? DEFAULTS.iterations)
  },
}
