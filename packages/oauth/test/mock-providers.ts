import type { KeyObject } from 'node:crypto'
import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto'
import { exportJWK, jwtVerify, SignJWT } from 'jose'
import { alipaySignContent } from '../src'

/**
 * 进程内的模拟授权服务器：按 host + path 实现各家的令牌与用户接口，
 * 以 fetch 函数的形式注入（config/oauth.ts 的 fetch）。授权页由 authorize() 模拟：
 * 记录 client、redirect_uri、PKCE challenge 与 nonce，签发一次性授权码。
 */

export const CLIENT_ID = 'test-client'
export const CLIENT_SECRET = 'test-secret'
export const APPLE_TEAM = 'TEAM123456'
export const APPLE_KEY_ID = 'KEY1234567'

interface Grant {
  clientId: string
  redirectUri: string
  challenge?: string
  nonce?: string
  scope?: string
}

class MockError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super('mock error')
  }
}

function pem(key: KeyObject, type: 'pkcs8' | 'spki' | 'pkcs1'): string {
  return key.export({ type, format: 'pem' }) as string
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url')

export interface Request {
  method: string
  url: URL
  headers: Headers
  form: Record<string, string>
  json: Record<string, any>
}

export async function createMockProviders() {
  const grants = new Map<string, Grant>()
  const tokens = new Set<string>()
  const requests: Request[] = []
  let codes = 0
  let issued = 0

  // id_token 签名密钥：RS256（Google）与 ES256（Apple / 通用 OIDC）
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const rsaJwk = {
    ...await exportJWK(rsa.publicKey),
    kid: 'rsa-1',
    alg: 'RS256',
    use: 'sig',
  }
  const ecJwk = {
    ...await exportJWK(ec.publicKey),
    kid: 'ec-1',
    alg: 'ES256',
    use: 'sig',
  }
  // 开发者的 Apple .p8 私钥（client secret JWT）
  const appleClient = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  // 支付宝：应用密钥对（应用签名请求）与平台密钥对（平台签名响应）
  const alipayApp = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const alipayPlatform = generateKeyPairSync('rsa', { modulusLength: 2048 })

  const extraJwks: Array<Record<string, unknown>> = []
  const state = { corruptAlipaySign: false }
  const counters = { wecomToken: 0, discovery: 0, jwks: 0 }

  const keys = {
    applePrivateKey: pem(appleClient.privateKey, 'pkcs8'),
    alipayAppPrivateKey: pem(alipayApp.privateKey, 'pkcs8'),
    alipayAppPrivateKeyPkcs1: pem(alipayApp.privateKey, 'pkcs1'),
    alipayAppPublicKey: alipayApp.publicKey,
    // 支付宝控制台给出的是不带 PEM 头尾的 base64
    alipayPublicKey: pem(alipayPlatform.publicKey, 'spki').replace(/-----[A-Z ]+-----|\s/g, ''),
    rsa,
    ec,
  }

  function idToken(claims: Record<string, unknown>, alg: 'RS256' | 'ES256' = 'RS256', kid?: string, key?: KeyObject): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg, kid: kid ?? (alg === 'RS256'
        ? 'rsa-1'
        : 'ec-1') })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key ?? (alg === 'RS256'
        ? rsa.privateKey
        : ec.privateKey))
  }

  /** 模拟用户在授权页同意：返回回调参数 */
  function authorize(location: string): Record<string, string> {
    const url = new URL(location)
    const params = url.searchParams
    const clientId = params.get('client_id') ?? params.get('appid') ?? params.get('app_id')
    const redirectUri = params.get('redirect_uri')
    if (!clientId || !redirectUri)
      throw new Error(`authorize: missing client / redirect_uri in ${location}`)
    const code = `code-${++codes}`
    grants.set(code, {
      clientId,
      redirectUri,
      challenge: params.get('code_challenge') ?? undefined,
      nonce: params.get('nonce') ?? undefined,
      scope: params.get('scope') ?? undefined,
    })
    return { code, state: params.get('state') ?? '' }
  }

  /** 兑换授权码：一次性，校验 PKCE 与 redirect_uri */
  function redeem(code: string | undefined, verifier?: string, redirectUri?: string): Grant {
    const grant = code
      ? grants.get(code)
      : undefined
    if (!grant)
      throw new MockError(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' })
    grants.delete(code!)
    if (grant.challenge && (!verifier || sha256(verifier) !== grant.challenge))
      throw new MockError(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
    if (redirectUri !== undefined && redirectUri !== grant.redirectUri)
      throw new MockError(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
    if (grant.clientId !== CLIENT_ID)
      throw new MockError(400, { error: 'invalid_client' })
    return grant
  }

  function issue(): string {
    const token = `at-${++issued}`
    tokens.add(token)
    return token
  }

  function bearer(req: Request, header = 'authorization'): string {
    const value = req.headers.get(header)?.replace(/^Bearer /, '') ?? req.url.searchParams.get('access_token') ?? ''
    if (!tokens.has(value))
      throw new MockError(401, { error: 'invalid_token' })
    return value
  }

  function secret(value: string | undefined): void {
    if (value !== CLIENT_SECRET)
      throw new MockError(401, { error: 'invalid_client' })
  }

  async function alipayResponse(node: string, value: Record<string, unknown>): Promise<Response> {
    const content = JSON.stringify(value)
    const sign = createSign('RSA-SHA256').update(content).sign(alipayPlatform.privateKey, 'base64')
    return new Response(`{"${node}":${content},"sign":"${state.corruptAlipaySign
      ? `x${sign.slice(1)}`
      : sign}"}`, {
      headers: { 'content-type': 'text/html;charset=utf-8' },
    })
  }

  const routes: Record<string, (req: Request) => unknown | Promise<unknown>> = {
    // GitHub
    'POST github.com/login/oauth/access_token': ({ form }) => {
      secret(form.client_secret)
      redeem(form.code, form.code_verifier, form.redirect_uri)
      return {
        access_token: issue(),
        token_type: 'bearer',
        scope: 'read:user,user:email',
      }
    },
    'GET api.github.com/user': (req) => {
      bearer(req)
      return {
        id: 583231,
        login: 'octocat',
        name: 'The Octocat',
        email: null,
        avatar_url: 'https://avatars.example/octocat.png',
      }
    },
    'GET api.github.com/user/emails': (req) => {
      bearer(req)
      return [
        { email: 'spam@example.com', primary: false, verified: true },
        { email: 'octocat@example.com', primary: true, verified: true },
      ]
    },

    // Google
    'POST oauth2.googleapis.com/token': async ({ form }) => {
      secret(form.client_secret)
      const grant = redeem(form.code, form.code_verifier, form.redirect_uri)
      return {
        access_token: issue(),
        expires_in: 3599,
        token_type: 'Bearer',
        scope: grant.scope,
        id_token: await idToken({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          sub: 'google-1',
          email: 'grace@example.com',
          nonce: grant.nonce,
        }),
      }
    },
    'GET www.googleapis.com/oauth2/v3/certs': () => ({
      keys: [rsaJwk],
    }),
    'GET openidconnect.googleapis.com/v1/userinfo': (req) => {
      bearer(req)
      return {
        sub: 'google-1',
        name: 'Grace Hopper',
        email: 'grace@example.com',
        email_verified: true,
        picture: 'https://lh3.example/grace.jpg',
      }
    },

    // Apple：client_secret 是开发者私钥签名的 JWT
    'POST appleid.apple.com/auth/token': async ({ form }) => {
      const { payload, protectedHeader } = await jwtVerify(form.client_secret, appleClient.publicKey, {
        issuer: APPLE_TEAM,
        subject: CLIENT_ID,
        audience: 'https://appleid.apple.com',
        algorithms: ['ES256'],
      })
      if (protectedHeader.kid !== APPLE_KEY_ID || payload.exp! - payload.iat! > 15777000)
        throw new MockError(400, { error: 'invalid_client' })
      const grant = redeem(form.code, undefined, form.redirect_uri)
      return {
        access_token: issue(),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'apple-refresh',
        id_token: await idToken({
          iss: 'https://appleid.apple.com',
          aud: CLIENT_ID,
          sub: '001234.apple',
          email: 'tim@privaterelay.appleid.com',
          nonce: grant.nonce,
        }, 'ES256'),
      }
    },
    'GET appleid.apple.com/auth/keys': () => ({
      keys: [ecJwk, ...extraJwks],
    }),

    // Microsoft（租户 organizations）
    'POST login.microsoftonline.com/organizations/oauth2/v2.0/token': ({ form }) => {
      secret(form.client_secret)
      redeem(form.code, form.code_verifier, form.redirect_uri)
      return {
        access_token: issue(),
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: 'opaque',
        scope: 'User.Read',
      }
    },
    'GET graph.microsoft.com/v1.0/me': (req) => {
      bearer(req)
      return {
        id: 'ms-1',
        displayName: 'Ada Lovelace',
        mail: null,
        userPrincipalName: 'ada@contoso.com',
      }
    },

    // GitLab 自建实例
    'POST git.example.com/oauth/token': ({ form }) => {
      secret(form.client_secret)
      redeem(form.code, form.code_verifier, form.redirect_uri)
      return {
        access_token: issue(),
        token_type: 'Bearer',
        expires_in: 7200,
        refresh_token: 'gl-refresh',
      }
    },
    'GET git.example.com/api/v4/user': (req) => {
      bearer(req)
      return {
        id: 42,
        username: 'linus',
        name: 'Linus',
        email: 'linus@example.com',
        avatar_url: 'https://git.example.com/avatar.png',
      }
    },

    // Discord
    'POST discord.com/api/oauth2/token': ({ form }) => {
      secret(form.client_secret)
      redeem(form.code, form.code_verifier, form.redirect_uri)
      return {
        access_token: issue(),
        token_type: 'Bearer',
        expires_in: 604800,
        refresh_token: 'dc-refresh',
        scope: 'identify email',
      }
    },
    'GET discord.com/api/users/@me': (req) => {
      bearer(req)
      return {
        id: '80351110224678912',
        username: 'nelly',
        global_name: 'Nelly',
        avatar: 'a_8342729096ea3675442027381ff50dfe',
        email: 'nelly@example.com',
        verified: true,
      }
    },

    // 微信（开放平台 / 公众号共用）：GET + errcode
    'GET api.weixin.qq.com/sns/oauth2/access_token': ({ url }) => {
      const query = Object.fromEntries(url.searchParams)
      if (query.secret !== CLIENT_SECRET || query.grant_type !== 'authorization_code')
        return { errcode: 40125, errmsg: 'invalid appsecret' }
      const grant = grants.get(query.code)
      if (!grant || grant.clientId !== query.appid)
        return { errcode: 40029, errmsg: 'invalid code' }
      grants.delete(query.code)
      return {
        access_token: issue(),
        expires_in: 7200,
        refresh_token: 'wx-refresh',
        openid: 'wx-openid',
        scope: grant.scope,
        unionid: 'wx-unionid',
      }
    },
    'GET api.weixin.qq.com/sns/userinfo': (req) => {
      bearer(req)
      if (req.url.searchParams.get('openid') !== 'wx-openid')
        return { errcode: 40003, errmsg: 'invalid openid' }
      return {
        openid: 'wx-openid',
        nickname: '微信用户',
        headimgurl: 'https://thirdwx.example/head.png',
        unionid: 'wx-unionid',
        privilege: [],
      }
    },

    // QQ
    'GET graph.qq.com/oauth2.0/token': ({ url }) => {
      const query = Object.fromEntries(url.searchParams)
      secret(query.client_secret)
      if (query.fmt !== 'json')
        throw new MockError(400, 'expected fmt=json')
      redeem(query.code, undefined, query.redirect_uri)
      return {
        access_token: issue(),
        expires_in: '7776000',
        refresh_token: 'qq-refresh',
      }
    },
    'GET graph.qq.com/oauth2.0/me': (req) => {
      bearer(req)
      const body = {
        client_id: CLIENT_ID,
        openid: 'qq-openid',
        unionid: req.url.searchParams.get('unionid') === '1'
          ? 'qq-unionid'
          : undefined,
      }
      // 不带 fmt=json 时 QQ 返回 JSONP
      return req.url.searchParams.get('fmt') === 'json'
        ? body
        : new Response(`callback( ${JSON.stringify(body)} );`)
    },
    'GET graph.qq.com/user/get_user_info': (req) => {
      bearer(req)
      if (req.url.searchParams.get('oauth_consumer_key') !== CLIENT_ID || req.url.searchParams.get('openid') !== 'qq-openid')
        return { ret: -1, msg: 'invalid openid' }
      return {
        ret: 0,
        msg: '',
        nickname: 'QQ用户',
        figureurl_qq_1: 'https://qq.example/40',
        figureurl_qq_2: 'https://qq.example/100',
      }
    },

    // 钉钉：JSON 请求、驼峰字段
    'POST api.dingtalk.com/v1.0/oauth2/userAccessToken': ({ json }) => {
      secret(json.clientSecret)
      if (json.grantType !== 'authorization_code' || json.clientId !== CLIENT_ID)
        throw new MockError(400, { code: 'InvalidParameter', message: 'grantType' })
      redeem(json.code)
      return {
        accessToken: issue(),
        refreshToken: 'dt-refresh',
        expireIn: 7200,
        corpId: 'ding-corp',
      }
    },
    'GET api.dingtalk.com/v1.0/contact/users/me': (req) => {
      bearer(req, 'x-acs-dingtalk-access-token')
      return {
        nick: '钉钉用户',
        avatarUrl: 'https://dingtalk.example/a.png',
        openId: 'dt-open',
        unionId: 'dt-union',
        email: 'dt@example.com',
        stateCode: '86',
      }
    },

    // 飞书：v2 令牌接口（JSON、PKCE）
    'POST open.feishu.cn/open-apis/authen/v2/oauth/token': ({ json }) => {
      secret(json.client_secret)
      redeem(json.code, json.code_verifier, json.redirect_uri)
      return {
        code: 0,
        access_token: issue(),
        expires_in: 7200,
        refresh_token: 'fs-refresh',
        token_type: 'Bearer',
        scope: '',
      }
    },
    'GET open.feishu.cn/open-apis/authen/v1/user_info': (req) => {
      bearer(req)
      return {
        code: 0,
        msg: 'success',
        data: {
          name: '飞书用户',
          en_name: 'Feishu User',
          avatar_url: 'https://feishu.example/a.png',
          open_id: 'ou_1',
          union_id: 'on_1',
          user_id: 'u1',
          email: 'fs@example.com',
        },
      }
    },

    // 企业微信
    'GET qyapi.weixin.qq.com/cgi-bin/gettoken': ({ url }) => {
      if (url.searchParams.get('corpsecret') !== CLIENT_SECRET || url.searchParams.get('corpid') !== CLIENT_ID)
        return { errcode: 40001, errmsg: 'invalid credential' }
      counters.wecomToken++
      tokens.add('corp-token')
      return {
        errcode: 0,
        errmsg: 'ok',
        access_token: 'corp-token',
        expires_in: 7200,
      }
    },
    'GET qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo': (req) => {
      bearer(req)
      const code = req.url.searchParams.get('code')!
      if (!grants.delete(code))
        return { errcode: 40029, errmsg: 'invalid code' }
      return { errcode: 0, errmsg: 'ok', userid: 'zhangsan' }
    },
    'GET qyapi.weixin.qq.com/cgi-bin/user/get': (req) => {
      bearer(req)
      return {
        errcode: 0,
        errmsg: 'ok',
        userid: req.url.searchParams.get('userid'),
        name: '张三',
        biz_mail: 'zhangsan@corp.example',
        avatar: 'https://wework.example/a.png',
      }
    },

    // 支付宝网关：校验 RSA2 请求签名，响应用平台私钥签名
    'POST openapi.alipay.com/gateway.do': async ({ form }) => {
      const valid = createVerify('RSA-SHA256').update(alipaySignContent(form)).verify(alipayApp.publicKey, form.sign, 'base64')
      if (!valid || form.sign_type !== 'RSA2' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(form.timestamp)) {
        return {
          error_response: {
            code: '40002',
            msg: 'Invalid Arguments',
            sub_code: 'isv.invalid-signature',
            sub_msg: '验签出错',
          },
          sign: '',
        }
      }
      if (form.method === 'alipay.system.oauth.token') {
        const grant = grants.get(form.code)
        if (!grant || form.grant_type !== 'authorization_code') {
          return {
            error_response: {
              code: '40002',
              msg: 'Invalid Arguments',
              sub_code: 'isv.code-invalid',
              sub_msg: '授权码无效',
            },
          }
        }
        grants.delete(form.code)
        return alipayResponse('alipay_system_oauth_token_response', {
          user_id: '2088000000000000',
          open_id: 'ali-open',
          access_token: issue(),
          expires_in: '1296000',
          refresh_token: 'ali-refresh',
          re_expires_in: '2592000',
        })
      }
      if (form.method === 'alipay.user.info.share') {
        if (!tokens.has(form.auth_token)) {
          return alipayResponse('alipay_user_info_share_response', {
            code: '20001',
            msg: 'Invalid Auth Token',
            sub_code: 'aop.invalid-auth-token',
            sub_msg: '无效的访问令牌',
          })
        }
        return alipayResponse('alipay_user_info_share_response', {
          code: '10000',
          msg: 'Success',
          open_id: 'ali-open',
          nick_name: '支付宝用户',
          avatar: 'https://alipay.example/a.png',
        })
      }
      throw new MockError(400, 'unknown method')
    },

    // 通用 OIDC：discovery + JWKS（ES256）
    'GET idp.example.com/.well-known/openid-configuration': () => {
      counters.discovery++
      return {
        issuer: 'https://idp.example.com',
        authorization_endpoint: 'https://idp.example.com/authorize',
        token_endpoint: 'https://idp.example.com/token',
        userinfo_endpoint: 'https://idp.example.com/userinfo',
        jwks_uri: 'https://idp.example.com/jwks',
      }
    },
    'GET idp.example.com/jwks': () => {
      counters.jwks++
      return {
        keys: [ecJwk, rsaJwk, ...extraJwks],
      }
    },
    'POST idp.example.com/token': async ({ form }) => {
      secret(form.client_secret)
      const grant = redeem(form.code, form.code_verifier, form.redirect_uri)
      return {
        access_token: issue(),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: await idToken({
          iss: 'https://idp.example.com',
          aud: CLIENT_ID,
          sub: 'oidc-1',
          email: 'kc@example.com',
          nonce: grant.nonce,
        }, 'ES256'),
      }
    },
    'GET idp.example.com/userinfo': (req) => {
      bearer(req)
      return {
        sub: 'oidc-1',
        preferred_username: 'keycloak',
        name: 'Key Cloak',
        email: 'kc@example.com',
      }
    },
  }

  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    const raw = typeof init.body === 'string'
      ? init.body
      : ''
    const isJson = headers.get('content-type')?.includes('json')
    const req: Request = {
      method,
      url,
      headers,
      form: isJson
        ? {}
        : Object.fromEntries(new URLSearchParams(raw)),
      json: isJson && raw
        ? JSON.parse(raw)
        : {},
    }
    requests.push(req)
    const handler = routes[`${method} ${url.host}${url.pathname}`]
    if (!handler)
      return Response.json({ error: 'not_found', error_description: `${method} ${url.href}` }, { status: 404 })
    try {
      const result = await handler(req)
      return result instanceof Response
        ? result
        : Response.json(result)
    }
    catch (error) {
      if (error instanceof MockError) {
        return typeof error.body === 'string'
          ? new Response(error.body, { status: error.status })
          : Response.json(error.body, { status: error.status })
      }
      return Response.json({ error: 'server_error', error_description: (error as Error).message }, { status: 400 })
    }
  }

  return {
    fetch,
    authorize,
    idToken,
    keys,
    requests,
    counters,
    state,
    extraJwks,
    grants,
  }
}

export type MockProviders = Awaited<ReturnType<typeof createMockProviders>>
