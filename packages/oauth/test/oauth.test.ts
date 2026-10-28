import type { Application, HttpContext } from '@hazejs/core'
import type { AppleProvider, OAuthConfig, OAuthUser } from '../src'
import type { MockProviders } from './mock-providers'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { createApplication, defineRoutes, generateKey } from '@hazejs/core'
import { decodeJwt, decodeProtectedHeader, exportJWK } from 'jose'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { alipaySign, alipaySignContent, clearDiscoveryCache, clearJwksCache, defineOAuthProvider, extractResponseNode, OAuth, registerOAuthProvider, rsaSign, rsaVerify, signClientSecret, verifyIdToken } from '../src'
import { APPLE_KEY_ID, APPLE_TEAM, CLIENT_ID, CLIENT_SECRET, createMockProviders } from './mock-providers'

const APP_KEY = generateKey()
let mock: MockProviders

beforeAll(async () => {
  mock = await createMockProviders()
})

beforeEach(() => {
  clearJwksCache()
  clearDiscoveryCache()
  mock.state.corruptAlipaySign = false
})

const client = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirect: '/auth/callback' }

function providers(): OAuthConfig['providers'] {
  return {
    github: { ...client, redirect: '/auth/github/callback' },
    google: { ...client, redirect: '/auth/google/callback' },
    apple: {
      clientId: CLIENT_ID,
      redirect: '/auth/apple/callback',
      teamId: APPLE_TEAM,
      keyId: APPLE_KEY_ID,
      privateKey: mock.keys.applePrivateKey.replace(/\n/g, '\\n'),
    },
    microsoft: { ...client, redirect: '/auth/microsoft/callback', tenant: 'organizations' },
    gitlab: { ...client, redirect: '/auth/gitlab/callback', baseUrl: 'https://git.example.com' },
    discord: { ...client, redirect: '/auth/discord/callback' },
    wechat: { ...client, redirect: '/auth/wechat/callback' },
    wechat_mp: { ...client, redirect: '/auth/wechat_mp/callback', idField: 'unionid' },
    qq: { ...client, redirect: '/auth/qq/callback' },
    dingtalk: { ...client, redirect: '/auth/dingtalk/callback' },
    feishu: { ...client, redirect: '/auth/feishu/callback' },
    wecom: {
      ...client,
      redirect: '/auth/wecom/callback',
      agentId: 1000002,
      profile: true,
    },
    alipay: {
      clientId: CLIENT_ID,
      redirect: '/auth/alipay/callback',
      privateKey: mock.keys.alipayAppPrivateKey,
      alipayPublicKey: mock.keys.alipayPublicKey,
    },
    keycloak: {
      ...client,
      driver: 'oidc',
      redirect: '/auth/keycloak/callback',
      issuer: 'https://idp.example.com',
    },
    // 未配置环境变量：视为未启用
    twitter: { clientId: '', redirect: '/auth/twitter/callback' },
  }
}

function boot(oauth: Partial<OAuthConfig> = {}): Promise<Application> {
  return createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: { key: APP_KEY, url: 'https://app.test' },
      oauth: {
        fetch: mock.fetch,
        providers: providers(),
        ...oauth,
      },
    },
    routes: [
      defineRoutes((r) => {
        r.get('/auth/:provider', (ctx) => {
          const driver = OAuth.driver(ctx.param('provider')!)
          if (ctx.query('scope'))
            driver.setScopes(ctx.query('scope')!)
          if (ctx.query('stateless'))
            driver.stateless()
          return driver.with({ prompt: 'consent' }).redirect(ctx)
        })
        const callback = (ctx: HttpContext) => {
          const driver = OAuth.driver(ctx.param('provider')!)
          if (ctx.query('stateless'))
            driver.stateless()
          return driver.user(ctx)
        }
        r.get('/auth/:provider/callback', callback)
        r.post('/auth/:provider/callback', callback)
        r.get('/enabled', () => ({
          github: OAuth.enabled('github'),
          twitter: OAuth.enabled('twitter'),
          providers: OAuth.providers(),
        }))
      }),
    ],
  })
}

/** 模拟浏览器：保存 Set-Cookie 并在后续请求中带上 */
function browser(app: Application) {
  const jar = new Map<string, string>()
  const setCookies: string[] = []
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size)
      headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
    const res = await app.request(path, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) {
      setCookies.push(cookie)
      const [pair, ...attributes] = cookie.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index)
      const value = pair.slice(index + 1)
      if (attributes.some(attribute => /max-age=0/i.test(attribute)) || !value)
        jar.delete(name)
      else
        jar.set(name, value)
    }
    return res
  }
  return { request, jar, setCookies }
}

/** 完整走一遍：跳转 → 模拟授权 → 回调 */
async function login(app: Application, provider: string, options: { post?: Record<string, string>, query?: string } = {}) {
  const b = browser(app)
  const redirect = await b.request(`/auth/${provider}${options.query ?? ''}`)
  expect(redirect.status).toBe(302)
  const location = redirect.headers.get('location')!
  const callback = mock.authorize(location)
  const res = options.post
    ? await b.request(`/auth/${provider}/callback${options.query ?? ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...callback,
          ...options.post,
        }).toString(),
      })
    : await b.request(`/auth/${provider}/callback?${new URLSearchParams(callback)}${options.query
        ? `&${options.query.slice(1)}`
        : ''}`)
  const body = await res.json() as { code: number | string, message: string, data: OAuthUser }
  return {
    res,
    body,
    user: body.data,
    location: new URL(location),
    browser: b,
  }
}

describe('provider flows against the mock servers', () => {
  it('github: PKCE, primary email fallback, authorize parameters', async () => {
    const app = await boot()
    const { user, location, res, body } = await login(app, 'github')
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: 'https://app.test/auth/github/callback',
      response_type: 'code',
      scope: 'read:user user:email',
      code_challenge_method: 'S256',
      prompt: 'consent',
    })
    expect(user).toMatchObject({
      provider: 'github',
      id: '583231',
      name: 'The Octocat',
      nickname: 'octocat',
      email: 'octocat@example.com',
      avatar: 'https://avatars.example/octocat.png',
      token: { tokenType: 'bearer' },
    })
    expect(user.token.accessToken).toMatch(/^at-/)
  })

  it('google: OIDC id_token (RS256 + nonce) merged with userinfo', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'google')
    expect(location.searchParams.get('nonce')).toBeTruthy()
    expect(location.searchParams.get('scope')).toBe('openid profile email')
    expect(user).toMatchObject({
      id: 'google-1',
      name: 'Grace Hopper',
      email: 'grace@example.com',
      avatar: 'https://lh3.example/grace.jpg',
    })
    expect(user.token.idToken).toBeTruthy()
  })

  it('apple: form_post callback, ES256 client secret, id_token and first-login name', async () => {
    const app = await boot()
    const { user, location, browser: b, res } = await login(app, 'apple', {
      post: {
        user: JSON.stringify({
          name: { firstName: 'Tim', lastName: 'Apple' },
          email: 'tim@privaterelay.appleid.com',
        }),
      },
    })
    expect(res.status).toBe(200)
    expect(location.searchParams.get('response_mode')).toBe('form_post')
    expect(location.searchParams.get('scope')).toBe('name email')
    expect(location.searchParams.has('code_challenge')).toBe(false)
    // form_post 是跨站 POST：state Cookie 必须 SameSite=None; Secure
    const cookie = b.setCookies.find(item => item.startsWith('haze_oauth_apple='))!
    expect(cookie).toMatch(/SameSite=None/i)
    expect(cookie).toMatch(/Secure/i)
    expect(user).toMatchObject({ id: '001234.apple', name: 'Tim Apple', email: 'tim@privaterelay.appleid.com' })
  })

  it('microsoft: tenant endpoint and Graph /me', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'microsoft')
    expect(location.href).toContain('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize')
    expect(user).toMatchObject({ id: 'ms-1', name: 'Ada Lovelace', email: 'ada@contoso.com' })
  })

  it('gitlab: self-hosted base URL', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'gitlab')
    expect(location.origin).toBe('https://git.example.com')
    expect(user).toMatchObject({ id: '42', nickname: 'linus', email: 'linus@example.com' })
  })

  it('discord: animated avatar URL', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'discord')
    expect(location.searchParams.has('code_challenge')).toBe(false)
    expect(user).toMatchObject({
      id: '80351110224678912',
      name: 'Nelly',
      nickname: 'nelly',
      avatar: 'https://cdn.discordapp.com/avatars/80351110224678912/a_8342729096ea3675442027381ff50dfe.gif',
    })
  })

  it('wechat: appid, fixed parameter order and #wechat_redirect; openid as id', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'wechat')
    expect(location.href).toMatch(/^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?appid=test-client&redirect_uri=[^&]+&response_type=code&scope=snsapi_login&state=[\w-]+&prompt=consent#wechat_redirect$/)
    expect(user).toMatchObject({
      id: 'wx-openid',
      name: '微信用户',
      avatar: 'https://thirdwx.example/head.png',
      raw: { unionid: 'wx-unionid' },
    })
    expect(user.token).toMatchObject({ refreshToken: 'wx-refresh', expiresIn: 7200 })
    expect(user.token.tokenType).toBeUndefined()
  })

  it('wechat_mp: snsapi_base skips userinfo; snsapi_userinfo uses unionid as id', async () => {
    const app = await boot()
    const before = mock.requests.length
    const base = await login(app, 'wechat_mp', { query: '?scope=snsapi_base' })
    expect(base.location.href).toContain('https://open.weixin.qq.com/connect/oauth2/authorize?appid=')
    expect(base.user).toMatchObject({ id: 'wx-unionid', name: null })
    expect(mock.requests.slice(before).some(req => req.url.pathname === '/sns/userinfo')).toBe(false)

    const full = await login(app, 'wechat_mp')
    expect(full.user).toMatchObject({ id: 'wx-unionid', nickname: '微信用户' })
  })

  it('qq: token with fmt=json, openid / unionid via /oauth2.0/me', async () => {
    const app = await boot()
    const { user } = await login(app, 'qq')
    expect(user).toMatchObject({
      id: 'qq-openid',
      name: 'QQ用户',
      avatar: 'https://qq.example/100',
      raw: { unionid: 'qq-unionid' },
    })
  })

  it('dingtalk: JSON token request and x-acs-dingtalk-access-token', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'dingtalk')
    expect(location.origin).toBe('https://login.dingtalk.com')
    expect(location.searchParams.get('prompt')).toBe('consent')
    expect(user).toMatchObject({
      id: 'dt-union',
      name: '钉钉用户',
      email: 'dt@example.com',
      token: { refreshToken: 'dt-refresh', expiresIn: 7200 },
    })
  })

  it('feishu: authen v2 token with PKCE and user_info', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'feishu')
    expect(location.href).toContain('https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=')
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(user).toMatchObject({ id: 'ou_1', name: '飞书用户', email: 'fs@example.com' })
  })

  it('wecom: QR login, cached corp token, getuserinfo + user/get', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'wecom')
    expect(location.origin + location.pathname).toBe('https://login.work.weixin.qq.com/wwlogin/sso/login')
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ login_type: 'CorpApp', appid: CLIENT_ID, agentid: '1000002' })
    expect(user).toMatchObject({
      id: 'zhangsan',
      name: '张三',
      email: 'zhangsan@corp.example',
      token: { accessToken: '' },
    })
    await login(app, 'wecom')
    expect(mock.counters.wecomToken).toBe(1)
  })

  it('alipay: auth_code callback, RSA2-signed gateway calls and verified responses', async () => {
    const app = await boot()
    const b = browser(app)
    const location = new URL((await b.request('/auth/alipay')).headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://openauth.alipay.com/oauth2/publicAppAuthorize.htm')
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ app_id: CLIENT_ID, scope: 'auth_user' })
    const { code, state } = mock.authorize(location.href)
    const res = await b.request(`/auth/alipay/callback?auth_code=${code}&state=${state}&app_id=${CLIENT_ID}`)
    const body = await res.json() as { data: OAuthUser }
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.data).toMatchObject({
      id: 'ali-open',
      name: '支付宝用户',
      token: { refreshToken: 'ali-refresh', expiresIn: 1296000 },
    })

    // 平台响应签名被篡改 → 502
    mock.state.corruptAlipaySign = true
    const bad = browser(app)
    const next = mock.authorize((await bad.request('/auth/alipay')).headers.get('location')!)
    const rejected = await bad.request(`/auth/alipay/callback?auth_code=${next.code}&state=${next.state}`)
    expect(rejected.status).toBe(502)
  })

  it('generic OIDC: discovery, JWKS (ES256) and nonce, then userinfo', async () => {
    const app = await boot()
    const { user, location } = await login(app, 'keycloak')
    expect(location.origin + location.pathname).toBe('https://idp.example.com/authorize')
    expect(location.searchParams.get('nonce')).toBeTruthy()
    expect(user).toMatchObject({
      provider: 'keycloak',
      id: 'oidc-1',
      name: 'Key Cloak',
      nickname: 'keycloak',
      email: 'kc@example.com',
    })
    // discovery 被缓存
    const discovery = mock.counters.discovery
    await login(app, 'keycloak')
    expect(mock.counters.discovery).toBe(discovery)
  })
})

describe('state, PKCE and errors', () => {
  it('rejects a callback without the state cookie, with a mismatched state, or replayed', async () => {
    const app = await boot()
    const b = browser(app)
    const { code, state } = mock.authorize((await b.request('/auth/github')).headers.get('location')!)

    // 没有 Cookie（另一个浏览器）
    const stranger = await app.request(`/auth/github/callback?code=${code}&state=${state}`)
    expect(stranger.status).toBe(400)
    expect(await stranger.json()).toMatchObject({ code: 'invalid_state' })

    // state 不一致（Cookie 随后被清除）
    const mismatch = await b.request(`/auth/github/callback?code=${code}&state=forged`)
    expect(mismatch.status).toBe(400)
    expect(b.setCookies.at(-1)).toMatch(/^haze_oauth_github=;.*Max-Age=0/i)

    // state 只能使用一次
    const replay = await b.request(`/auth/github/callback?code=${code}&state=${state}`)
    expect(replay.status).toBe(400)
  })

  it('rejects a tampered or cross-provider state cookie', async () => {
    const app = await boot()
    const b = browser(app)
    const { code, state } = mock.authorize((await b.request('/auth/gitlab')).headers.get('location')!)
    const cookie = b.jar.get('haze_oauth_gitlab')!
    // 把 gitlab 的 Cookie 改名给 github：附加数据绑定了 Cookie 名，解密失败
    const swapped = await app.request(`/auth/github/callback?code=${code}&state=${state}`, {
      headers: { cookie: `haze_oauth_github=${cookie}` },
    })
    expect(swapped.status).toBe(400)
    const tampered = await app.request(`/auth/gitlab/callback?code=${code}&state=${state}`, {
      headers: { cookie: `haze_oauth_gitlab=${cookie.slice(0, -2)}AA` },
    })
    expect(tampered.status).toBe(400)
  })

  it('expires the state after stateTtl', async () => {
    const app = await boot({ stateTtl: 0 })
    const b = browser(app)
    const { code, state } = mock.authorize((await b.request('/auth/github')).headers.get('location')!)
    const res = await b.request(`/auth/github/callback?code=${code}&state=${state}`)
    expect(res.status).toBe(400)
  })

  it('pKCE: the verifier from the cookie must match the challenge sent to the provider', async () => {
    const app = await boot()
    const a = browser(app)
    const b = browser(app)
    const first = mock.authorize((await a.request('/auth/github')).headers.get('location')!)
    await b.request('/auth/github')
    // 用 b 的 Cookie（另一个 code_verifier）配上 a 的 state 无法通过 state 校验；
    // 直接伪造：把 a 的授权码配上 b 自己的 state，提供方的 PKCE 校验失败
    const stateB = mock.authorize((await b.request('/auth/github')).headers.get('location')!).state
    const res = await b.request(`/auth/github/callback?code=${first.code}&state=${stateB}`)
    expect(res.status).toBe(400)
    expect((await res.json() as { message: string }).message).toContain('PKCE verification failed')
  })

  it('surfaces provider errors: access_denied, reused code (errcode), unknown / disabled provider', async () => {
    const app = await boot()
    const b = browser(app)
    const { state } = mock.authorize((await b.request('/auth/github')).headers.get('location')!)
    const denied = await b.request(`/auth/github/callback?error=access_denied&error_description=User+denied&state=${state}`)
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ code: 'access_denied', message: '[github] User denied' })

    const wx = browser(app)
    const grant = mock.authorize((await wx.request('/auth/wechat')).headers.get('location')!)
    mock.grants.delete(grant.code)
    const invalid = await wx.request(`/auth/wechat/callback?code=${grant.code}&state=${grant.state}`)
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 40029 })

    expect((await app.request('/auth/twitter')).status).toBe(404)
    expect((await app.request('/auth/nope')).status).toBe(404)
    expect((await (await app.request('/enabled')).json() as { data: unknown }).data).toEqual({
      github: true,
      twitter: false,
      providers: expect.arrayContaining(['github', 'alipay', 'keycloak']),
    })
  })

  it('stateless() sets no cookie and skips state verification', async () => {
    const app = await boot()
    const redirect = await app.request('/auth/discord?stateless=1')
    expect(redirect.headers.getSetCookie()).toEqual([])
    const { code } = mock.authorize(redirect.headers.get('location')!)
    const res = await app.request(`/auth/discord/callback?code=${code}&stateless=1`)
    expect(res.status).toBe(200)
  })

  it('stores the state in the session when stateStore is session', async () => {
    const app = await boot({ stateStore: 'session' })
    const { res, user, browser: b } = await login(app, 'gitlab')
    expect(res.status).toBe(200)
    expect(user.id).toBe('42')
    expect(b.setCookies.some(cookie => cookie.startsWith('haze_oauth_'))).toBe(false)
  })
})

describe('tokens and signatures', () => {
  it('userFromToken(): access token (+ openid for WeChat), Apple identity token', async () => {
    const app = await boot()
    const issued = await login(app, 'github')
    const again = await withApp(app, () => OAuth.driver('github').userFromToken(issued.user.token.accessToken))
    expect(again.id).toBe('583231')

    const wx = await login(app, 'wechat')
    const wxUser = await withApp(app, () => OAuth.driver('wechat').userFromToken(wx.user.token.accessToken, { openid: 'wx-openid' }))
    expect(wxUser.nickname).toBe('微信用户')
    await expect(withApp(app, () => OAuth.driver('wechat').userFromToken(wx.user.token.accessToken))).rejects.toThrow(/openid is required/)

    const idToken = await mock.idToken({
      iss: 'https://appleid.apple.com',
      aud: CLIENT_ID,
      sub: 'apple-native',
      email: 'native@example.com',
    }, 'ES256')
    const apple = await withApp(app, () => OAuth.driver('apple').userFromToken(idToken))
    expect(apple).toMatchObject({ id: 'apple-native', email: 'native@example.com' })
    const forged = await mock.idToken({ iss: 'https://appleid.apple.com', aud: 'someone-else', sub: 'x' }, 'ES256')
    await expect(withApp(app, () => OAuth.driver('apple').userFromToken(forged))).rejects.toThrow(/Invalid id_token/)
  })

  it('apple client secret: ES256 JWT with kid, iss = team, sub = client, cached', async () => {
    const provider = OAuth.build('apple', {
      clientId: CLIENT_ID,
      redirect: 'https://app.test/cb',
      teamId: APPLE_TEAM,
      keyId: APPLE_KEY_ID,
      privateKey: mock.keys.applePrivateKey,
    }, { fetch: mock.fetch }) as AppleProvider
    const secret = await provider.createClientSecret()
    expect(decodeProtectedHeader(secret)).toEqual({ alg: 'ES256', kid: APPLE_KEY_ID })
    const claims = decodeJwt(secret)
    expect(claims).toMatchObject({ iss: APPLE_TEAM, sub: CLIENT_ID, aud: 'https://appleid.apple.com' })
    expect(claims.exp! - claims.iat!).toBe(3600)
    expect(await provider.createClientSecret()).toBe(secret)

    // 独立的签名函数（base64 主体也可以）
    const body = mock.keys.applePrivateKey.replace(/-----[A-Z ]+-----|\s/g, '')
    const other = await signClientSecret({
      privateKey: body,
      keyId: 'K',
      issuer: 'T',
      subject: 'S',
      audience: 'A',
      expiresIn: 60,
    })
    expect(decodeJwt(other)).toMatchObject({ iss: 'T', sub: 'S', aud: 'A' })
  })

  it('verifyIdToken(): nonce, audience, issuer and JWKS key rotation', async () => {
    const options = {
      jwksUri: 'https://idp.example.com/jwks',
      issuer: 'https://idp.example.com',
      audience: CLIENT_ID,
      fetch: mock.fetch,
    }
    const token = await mock.idToken({
      iss: 'https://idp.example.com',
      aud: CLIENT_ID,
      sub: 's',
      nonce: 'n-1',
    }, 'ES256')
    expect((await verifyIdToken(token, { ...options, nonce: 'n-1' })).sub).toBe('s')
    await expect(verifyIdToken(token, { ...options, nonce: 'n-2' })).rejects.toThrow(/nonce/)
    await expect(verifyIdToken(token, { ...options, audience: 'other' })).rejects.toThrow()
    await expect(verifyIdToken(token, { ...options, issuer: 'https://evil.example' })).rejects.toThrow()

    // 新密钥（新 kid）：缓存中找不到时重新拉取 JWKS
    const rotated = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwks = mock.counters.jwks
    mock.extraJwks.push({
      ...await exportJWK(rotated.publicKey),
      kid: 'ec-2',
      alg: 'ES256',
    })
    const fresh = await mock.idToken({ iss: 'https://idp.example.com', aud: CLIENT_ID, sub: 'r' }, 'ES256', 'ec-2', rotated.privateKey)
    expect((await verifyIdToken(fresh, options)).sub).toBe('r')
    expect(mock.counters.jwks).toBe(jwks + 1)
    mock.extraJwks.length = 0

    // 未知密钥签名
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const forged = await mock.idToken({ iss: 'https://idp.example.com', aud: CLIENT_ID, sub: 'x' }, 'ES256', 'ec-1', stranger.privateKey)
    await expect(verifyIdToken(forged, options)).rejects.toThrow()
  })

  it('alipay signing: content order, PKCS#8 / PKCS#1 / bare keys, response node extraction', async () => {
    const params = {
      method: 'alipay.system.oauth.token',
      app_id: '2021',
      sign: 'ignored',
      empty: '',
      charset: 'utf-8',
      code: 'a&b',
    }
    expect(alipaySignContent(params)).toBe('app_id=2021&charset=utf-8&code=a&b&method=alipay.system.oauth.token')

    for (const key of [
      mock.keys.alipayAppPrivateKey,
      mock.keys.alipayAppPrivateKeyPkcs1,
      mock.keys.alipayAppPrivateKeyPkcs1.replace(/-----[A-Z ]+-----|\s/g, ''),
    ]) {
      const sign = await alipaySign(params, key)
      expect(createVerify('RSA-SHA256').update(alipaySignContent(params)).verify(mock.keys.alipayAppPublicKey, sign, 'base64')).toBe(true)
    }

    const spki = mock.keys.alipayAppPublicKey.export({ type: 'spki', format: 'pem' }) as string
    const signature = await rsaSign('hello', mock.keys.alipayAppPrivateKey)
    expect(await rsaVerify('hello', signature, spki)).toBe(true)
    expect(await rsaVerify('hellO', signature, spki)).toBe(false)

    const text = '{"alipay_user_info_share_response":{"code":"10000","nick_name":"a}\\"{b","x":{"y":1}},"sign":"abc"}'
    expect(extractResponseNode(text, 'alipay_user_info_share_response')).toBe('{"code":"10000","nick_name":"a}\\"{b","x":{"y":1}}')
  })
})

describe('custom providers', () => {
  it('defineOAuthProvider() + registerOAuthProvider() or an inline driver', async () => {
    const Gitea = defineOAuthProvider<{ clientId: string, clientSecret: string, redirect: string, baseUrl: string }>({
      endpoints: config => ({
        authorize: `${config.baseUrl}/oauth/authorize`,
        token: `${config.baseUrl}/oauth/token`,
        user: `${config.baseUrl}/api/v4/user`,
      }),
      scopes: ['read_user'],
      mapUser: raw => ({ id: raw.id, nickname: raw.username, email: raw.email }),
    })
    registerOAuthProvider('gitea', Gitea)
    const app = await boot({
      providers: {
        ...providers(),
        gitea: {
          ...client,
          driver: 'gitea',
          redirect: '/auth/gitea/callback',
          baseUrl: 'https://git.example.com',
        },
        inline: {
          ...client,
          driver: Gitea,
          redirect: '/auth/inline/callback',
          baseUrl: 'https://git.example.com',
        },
      },
    })
    for (const name of ['gitea', 'inline']) {
      const { user, location } = await login(app, name)
      expect(location.searchParams.get('code_challenge_method')).toBe('S256')
      expect(user).toMatchObject({
        provider: name,
        id: '42',
        nickname: 'linus',
        email: 'linus@example.com',
        name: null,
      })
    }
  })
})

/** 在请求之外调用 OAuth 门面：config() 读取最近启动的应用 */
async function withApp<T>(_app: Application, fn: () => Promise<T>): Promise<T> {
  return fn()
}
