import { useTestApp } from '@hazejs/testing'
import { describe, expect, it } from 'vitest'

const t = useTestApp()

describe('home', () => {
  it('renders the welcome page with a TSX view', async () => {
    const res = await t.get('/', {
      headers: { accept: 'text/html' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.body).toContain('<!DOCTYPE html>')
    expect(res.body).toContain('<h1>{{name}}</h1>')
  })
})
