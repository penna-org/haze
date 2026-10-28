/**
 * 雪花算法 ID（64 位）：1 位符号 + 41 位毫秒时间戳 + 5 位数据中心 + 5 位机器 + 12 位序列号。
 *
 * 位布局与默认纪元（1288834974657，2010-11-04）与 Java 的 MyBatis-Plus `IdType.ASSIGN_ID`、
 * Hutool `Snowflake` 相同：只要 workerId / datacenterId 不重复，Node 与 Java 服务可以共用同一张表的 ID。
 *
 * 64 位整数超出 JavaScript number 的安全范围（2^53），因此 ID 以字符串或 BigInt 表示，不使用 number。
 */
export interface SnowflakeOptions {
  /** 机器 ID 0–31，默认读取环境变量 SNOWFLAKE_WORKER_ID，否则随机 */
  workerId?: number
  /** 数据中心 ID 0–31，默认读取环境变量 SNOWFLAKE_DATACENTER_ID，否则随机 */
  datacenterId?: number
  /** 纪元（毫秒时间戳或 Date），默认 1288834974657，与 MyBatis-Plus / Hutool 一致 */
  epoch?: number | Date
}

export interface SnowflakeParts {
  /** 生成时间 */
  time: Date
  datacenterId: number
  workerId: number
  sequence: number
}

export const DEFAULT_SNOWFLAKE_EPOCH = 1288834974657

const WORKER_BITS = 5n
const DATACENTER_BITS = 5n
const SEQUENCE_BITS = 12n
const MAX_ID = 31
const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n
const WORKER_SHIFT = SEQUENCE_BITS
const DATACENTER_SHIFT = SEQUENCE_BITS + WORKER_BITS
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_BITS + DATACENTER_BITS
/** 时钟回拨在此范围内（毫秒）时等待追平，超过则报错 */
const MAX_BACKWARDS = 5

function envId(name: string): number | undefined {
  // Edge 运行时可能没有 process
  // eslint-disable-next-line node/prefer-global/process
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
  return value === undefined || value === ''
    ? undefined
    : Number(value)
}

function checkId(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_ID)
    throw new RangeError(`Snowflake ${name} must be an integer between 0 and ${MAX_ID}, got ${value}`)
  return value
}

/**
 * 雪花 ID 生成器：
 *
 * ```ts
 * const generator = new Snowflake({ workerId: 1, datacenterId: 1 })
 * generator.nextId()        // '1849302746129387521'
 * generator.nextBigInt()    // 1849302746129387522n
 * Snowflake.parse('1849302746129387521')  // { time, datacenterId, workerId, sequence }
 * ```
 */
export class Snowflake {
  readonly workerId: number
  readonly datacenterId: number
  readonly epoch: number
  #lastTimestamp = -1
  #sequence = 0n

  constructor(options: SnowflakeOptions = {}) {
    this.workerId = checkId('workerId', options.workerId ?? envId('SNOWFLAKE_WORKER_ID') ?? Math.floor(Math.random() * (MAX_ID + 1)))
    this.datacenterId = checkId('datacenterId', options.datacenterId ?? envId('SNOWFLAKE_DATACENTER_ID') ?? Math.floor(Math.random() * (MAX_ID + 1)))
    this.epoch = options.epoch instanceof Date
      ? options.epoch.getTime()
      : options.epoch ?? DEFAULT_SNOWFLAKE_EPOCH
  }

  /** 下一个 ID（BigInt） */
  nextBigInt(): bigint {
    let timestamp = Date.now()
    if (timestamp < this.#lastTimestamp) {
      const offset = this.#lastTimestamp - timestamp
      if (offset > MAX_BACKWARDS)
        throw new Error(`Clock moved backwards by ${offset}ms; refusing to generate snowflake ids`)
      timestamp = this.#waitUntil(this.#lastTimestamp)
    }
    if (timestamp === this.#lastTimestamp) {
      this.#sequence = (this.#sequence + 1n) & SEQUENCE_MASK
      // 同一毫秒内序列号用完：等到下一毫秒
      if (this.#sequence === 0n)
        timestamp = this.#waitUntil(this.#lastTimestamp + 1)
    }
    else {
      // 新的毫秒从 1 或 2 开始（与 MyBatis-Plus 相同），避免低并发时 ID 总是偶数导致分库分表不均
      this.#sequence = BigInt(1 + Math.floor(Math.random() * 2))
    }
    this.#lastTimestamp = timestamp
    return (BigInt(timestamp - this.epoch) << TIMESTAMP_SHIFT)
      | (BigInt(this.datacenterId) << DATACENTER_SHIFT)
      | (BigInt(this.workerId) << WORKER_SHIFT)
      | this.#sequence
  }

  /** 下一个 ID（十进制字符串，推荐：可直接作为 JSON 返回给前端） */
  nextId(): string {
    return this.nextBigInt().toString()
  }

  /** 解析 ID 的组成部分 */
  static parse(id: bigint | string | number, epoch: number | Date = DEFAULT_SNOWFLAKE_EPOCH): SnowflakeParts {
    const value = BigInt(id)
    const base = epoch instanceof Date
      ? epoch.getTime()
      : epoch
    return {
      time: new Date(Number(value >> TIMESTAMP_SHIFT) + base),
      datacenterId: Number((value >> DATACENTER_SHIFT) & 31n),
      workerId: Number((value >> WORKER_SHIFT) & 31n),
      sequence: Number(value & SEQUENCE_MASK),
    }
  }

  #waitUntil(target: number): number {
    let now = Date.now()
    while (now < target)
      now = Date.now()
    return now
  }
}

let generator: Snowflake | undefined

/** 设置默认生成器（databaseProvider() 读取 config/database.ts 的 snowflake 配置后调用） */
export function configureSnowflake(options: SnowflakeOptions | Snowflake | undefined): void {
  generator = options instanceof Snowflake
    ? options
    : options
      ? new Snowflake(options)
      : undefined
}

/** 默认生成器（首次使用时按环境变量创建） */
export function useSnowflake(): Snowflake {
  return generator ??= new Snowflake()
}

/** 生成雪花 ID（字符串）：`await Order.create({ id: snowflakeId(), ... })` */
export function snowflakeId(): string {
  return useSnowflake().nextId()
}
