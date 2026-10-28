import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, createApplication, defineConfig, env, loadEnv } from '../src'

const touched: string[] = []

function setEnv(key: string, value: string): void {
  process.env[key] = value
  touched.push(key)
}

afterEach(() => {
  for (const key of touched.splice(0))
    delete process.env[key]
})

describe('env', () => {
  it('casts values based on the default type', () => {
    setEnv('T_PORT', '8080')
    setEnv('T_DEBUG', 'yes')
    setEnv('T_NAME', 'demo')
    expect(env('T_PORT', 3000)).toBe(8080)
    expect(env('T_DEBUG', false)).toBe(true)
    expect(env('T_NAME', 'x')).toBe('demo')
    expect(env('T_MISSING', 42)).toBe(42)
    expect(env('T_MISSING')).toBeUndefined()
  })

  it('loads .env files by mode without overriding real env vars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haze-env-'))
    try {
      writeFileSync(join(dir, '.env'), 'T_A=base\nT_B=base\nT_C=base\n')
      writeFileSync(join(dir, '.env.local'), 'T_B=local\n')
      writeFileSync(join(dir, '.env.production'), 'T_C=prod\n')
      setEnv('T_A', 'real')
      touched.push('T_B', 'T_C')

      loadEnv({ cwd: dir, mode: 'production' })
      expect(process.env.T_A).toBe('real')
      expect(process.env.T_B).toBe('local')
      expect(process.env.T_C).toBe('prod')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips .env.local in test mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haze-env-'))
    try {
      writeFileSync(join(dir, '.env'), 'T_L=base\n')
      writeFileSync(join(dir, '.env.local'), 'T_L=local\n')
      touched.push('T_L')
      loadEnv({ cwd: dir, mode: 'test' })
      expect(process.env.T_L).toBe('base')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('config', () => {
  it('reads and writes dot paths', () => {
    const config = new Config({
      db: { host: 'localhost', port: 5432 },
    })
    expect(config.get('db.host')).toBe('localhost')
    expect(config.get('db.user', 'root')).toBe('root')
    config.set('db.pool.max', 10)
    expect(config.get('db.pool')).toEqual({ max: 10 })
    expect(config.has('db.port')).toBe(true)
  })

  it('merges user config over defaults and evaluates function configs after env is loaded', async () => {
    const app = await createApplication({
      mode: 'test',
      env: { T_APP_NAME: 'from-env' },
      config: {
        app: defineConfig(() => ({
          name: env('T_APP_NAME', 'fallback'),
        })),
        database: { url: 'sqlite://memory' },
      },
    })
    touched.push('T_APP_NAME')

    expect(app.config.get('app.name')).toBe('from-env')
    expect(app.config.get('app.response.envelope')).toBe(true)
    expect(app.config.get('database.url')).toBe('sqlite://memory')
  })

  it('accepts import.meta.glob style module records', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        '/config/app.ts': {
          default: { name: 'glob' },
        },
        '/config/cache.ts': {
          default: { driver: 'memory' },
        },
      },
    })
    expect(app.config.get('app.name')).toBe('glob')
    expect(app.config.get('cache.driver')).toBe('memory')
  })
})
