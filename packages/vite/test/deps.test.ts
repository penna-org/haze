import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanExternals } from '../src/presets'
import { verifyIntegrity } from '../src/presets/binary'
import { importSpecifiers } from '../src/presets/deps'

let dir: string | undefined

afterEach(() => {
  if (dir)
    rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function output(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'hazejs-deps-'))
  for (const [name, code] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), code)
  }
  return dir
}

describe('scanExternals', () => {
  it('finds bare imports in the regular Rolldown output', () => {
    expect(scanExternals(output({
      'index.mjs': [
        `import { Pool } from "pg";`,
        `import * as redis from "ioredis";`,
        `import "reflect-metadata";`,
        `import { readFileSync } from "node:fs";`,
        `import path from "path";`,
        `import { helper } from "./chunks/helper.mjs";`,
        `export { Queue } from "bullmq";`,
        `export * from "@libsql/client/web";`,
        `const mysql = await import("mysql2/promise");`,
        `export { Pool, redis, path, helper, readFileSync, mysql };`,
      ].join('\n'),
    }))).toEqual([
      '@libsql/client',
      'bullmq',
      'ioredis',
      'mysql2',
      'pg',
      'reflect-metadata',
    ])
  })

  it('finds imports without whitespace in minified output', () => {
    expect(scanExternals(output({
      'index.mjs': `import{a}from"pg";import*as x from"ioredis";import d,{e as f}from"postgres";import"reflect-metadata";import{readFileSync as r}from"node:fs";export{y}from"bullmq";export*from"@libsql/client";export*as m from"mongodb";const n=()=>import("mysql2/promise"),t=()=>import(\`nodemailer\`);export{a,x,d,f,r,n,t};`,
      'chunks/a.js': `import{b}from"@aws-sdk/client-s3";export{b};`,
      // node_modules（追踪复制的依赖）与非 JS 文件不扫描
      'node_modules/dep/index.mjs': `import"inner-dep";`,
      'index.mjs.map': `import"not-code";`,
    }))).toEqual([
      '@aws-sdk/client-s3',
      '@libsql/client',
      'bullmq',
      'ioredis',
      'mongodb',
      'mysql2',
      'nodemailer',
      'pg',
      'postgres',
      'reflect-metadata',
    ])
  })

  it('ignores import-like text in strings and comments, and non-literal import()', () => {
    expect(scanExternals(output({
      'index.mjs': `/* import a from "in-comment" */const s='import b from "in-string"',t=\`export*from"in-template"\`;const from="x";const load=n=>import(n),tpl=n=>import(\`pkg-\${n}\`);import{c}from"real";export{s,t,from,load,tpl,c};`,
    }))).toEqual(['real'])
  })
})

describe('importSpecifiers', () => {
  it('falls back to a regex when the code cannot be parsed', () => {
    // 语法错误（未闭合的括号）：解析器报错后仍能找到导入
    const code = `import{a}from"pg";import*as x from"ioredis";import"side-effect";export{y}from"bullmq";export*from"mysql2";const m=import("mongodb");const broken=(;`
    expect(importSpecifiers(code).sort()).toEqual([
      'bullmq',
      'ioredis',
      'mongodb',
      'mysql2',
      'pg',
      'side-effect',
    ])
  })
})

describe('verifyIntegrity', () => {
  const data = new TextEncoder().encode('native addon tarball')
  const sha512 = `sha512-${createHash('sha512').update(data).digest('base64')}`

  it('accepts content matching the sha512 integrity', () => {
    expect(() => verifyIntegrity(data, sha512, 'pkg@1.0.0')).not.toThrow()
    // 多个算法并存时取 sha512
    expect(() => verifyIntegrity(data, `sha1-AAAA ${sha512}`, 'pkg@1.0.0')).not.toThrow()
  })

  it('rejects tampered content and missing sha512 integrity', () => {
    expect(() => verifyIntegrity(new TextEncoder().encode('tampered'), sha512, 'pkg@1.0.0')).toThrow('Integrity check failed for pkg@1.0.0')
    expect(() => verifyIntegrity(data, undefined, 'pkg@1.0.0')).toThrow('no sha512 integrity')
    expect(() => verifyIntegrity(data, 'sha1-AAAA', 'pkg@1.0.0')).toThrow('no sha512 integrity')
  })
})
