import { describe, expect, it } from 'vitest'
import { clientIp, lambdaEventToRequest, setClientAddress, trustedProxyHops } from '../src'

function request(forwardedFor?: string, address?: string) {
  return setClientAddress(new Request('http://demo.test/', {
    headers: forwardedFor
      ? { 'x-forwarded-for': forwardedFor }
      : {},
  }), address)
}

describe('client ip', () => {
  it('maps trustProxy to the number of trusted hops', () => {
    expect(trustedProxyHops(false)).toBe(0)
    expect(trustedProxyHops(true)).toBe(1)
    expect(trustedProxyHops(2)).toBe(2)
    expect(trustedProxyHops(0)).toBe(0)
    expect(trustedProxyHops(undefined)).toBe(0)
  })

  it('uses the platform address and ignores X-Forwarded-For unless proxies are trusted', () => {
    expect(clientIp(request('1.1.1.1', '10.0.0.9'), false)).toBe('10.0.0.9')
    expect(clientIp(request('1.1.1.1'), false)).toBeUndefined()
    expect(clientIp(request(undefined, '10.0.0.9'), true)).toBe('10.0.0.9')
  })

  it('takes the entry appended by the nearest trusted proxy, not the one the client sent', () => {
    // 客户端自己发 "6.6.6.6"，代理追加真实地址 1.1.1.1
    expect(clientIp(request('6.6.6.6, 1.1.1.1', '10.0.0.9'), true)).toBe('1.1.1.1')
    // 两层可信代理（CDN → 负载均衡）：从右数第二项
    expect(clientIp(request('6.6.6.6, 1.1.1.1, 172.16.0.2', '10.0.0.9'), 2)).toBe('1.1.1.1')
    // 可信层数多于实际项数时取最左一项
    expect(clientIp(request('1.1.1.1', '10.0.0.9'), 3)).toBe('1.1.1.1')
    expect(clientIp(request(' , '), true)).toBeUndefined()
  })

  it('setClientAddress keeps the request usable and does not expose the address as a header', () => {
    const req = request(undefined, '203.0.113.5')
    expect(req.headers.get('x-forwarded-for')).toBeNull()
    expect(clientIp(req, false)).toBe('203.0.113.5')
    expect(setClientAddress(new Request('http://demo.test/'), null).url).toBe('http://demo.test/')
  })

  it('lambda events carry the API Gateway source address', () => {
    const v2 = lambdaEventToRequest({
      version: '2.0',
      rawPath: '/',
      requestContext: {
        http: { method: 'GET', sourceIp: '203.0.113.5' },
      },
    })
    expect(clientIp(v2, false)).toBe('203.0.113.5')
    const v1 = lambdaEventToRequest({
      httpMethod: 'GET',
      path: '/',
      requestContext: {
        identity: { sourceIp: '203.0.113.6' },
      },
    })
    expect(clientIp(v1, false)).toBe('203.0.113.6')
    // ALB 事件没有 sourceIp：位于 ALB 之后需开启 trustProxy
    const alb = lambdaEventToRequest({
      httpMethod: 'GET',
      path: '/',
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' },
    })
    expect(clientIp(alb, false)).toBeUndefined()
    expect(clientIp(alb, true)).toBe('203.0.113.7')
  })
})
