import { describe, expect, it } from 'vitest'
import {
  CircularDependencyError,
  Container,
  createToken,
  inject,
  ResolutionError,
  Scope,
  ScopeError,
} from '../src'

class Repo {
  items = ['a']
}

class Service {
  repo = inject(Repo)
}

describe('container', () => {
  it('auto-binds classes as singletons and injects field dependencies', () => {
    const c = new Container()
    const a = c.make(Service)
    expect(a.repo).toBeInstanceOf(Repo)
    expect(c.make(Service)).toBe(a)
    expect(c.make(Repo)).toBe(a.repo)
  })

  it('binds interfaces to implementations and tokens to factories', () => {
    abstract class Mailer {
      abstract send(): string
    }
    class SmtpMailer extends Mailer {
      send(): string {
        return 'smtp'
      }
    }
    const Url = createToken<string>('url')

    const c = new Container()
      .bind(Mailer, SmtpMailer)
      .singleton(Url, () => 'postgres://local')

    expect(c.make(Mailer).send()).toBe('smtp')
    expect(c.make(Url)).toBe('postgres://local')
  })

  it('creates a new instance for transient bindings', () => {
    const c = new Container().transient(Repo)
    expect(c.make(Repo)).not.toBe(c.make(Repo))
  })

  it('respects static scope declared on the class', () => {
    class PerRequest {
      static scope = Scope.Request
    }
    const root = new Container()
    expect(() => root.make(PerRequest)).toThrow(ScopeError)

    const a = root.createChild()
    const b = root.createChild()
    expect(a.make(PerRequest)).toBe(a.make(PerRequest))
    expect(a.make(PerRequest)).not.toBe(b.make(PerRequest))
  })

  it('shares singletons between request containers', () => {
    const root = new Container()
    expect(root.createChild().make(Service)).toBe(root.createChild().make(Service))
  })

  it('rejects singletons depending on request-scoped services', () => {
    class Current {
      static scope = Scope.Request
    }
    class Cache {
      current = inject(Current)
    }
    const child = new Container().createChild()
    expect(() => child.make(Cache)).toThrow(/Cache \(singleton\) cannot depend on Current \(request-scoped\)/)
  })

  it('detects circular dependencies with the full chain', () => {
    class A {
      b = inject(B)
    }
    class B {
      a = inject(A)
    }
    const c = new Container()
    expect(() => c.make(A)).toThrow(CircularDependencyError)
    expect(() => c.make(A)).toThrow('A -> B -> A')
  })

  it('throws for unbound tokens', () => {
    const Missing = createToken<number>('missing')
    expect(() => new Container().make(Missing)).toThrow(ResolutionError)
  })

  it('throws when inject() is used outside an injection context', () => {
    expect(() => inject(Repo)).toThrow(/must be called during construction/)
  })

  it('supports inject() inside container.call()', () => {
    const c = new Container()
    expect(c.call(() => inject(Repo))).toBe(c.make(Repo))
  })

  it('overrides bindings and clears the cached instance', () => {
    class FakeRepo extends Repo {
      override items = ['fake']
    }
    const c = new Container()
    c.make(Repo)
    c.instance(Repo, new FakeRepo())
    expect(c.make(Repo).items).toEqual(['fake'])
  })

  it('disposes owned instances in reverse order', async () => {
    const order: string[] = []
    class First {
      [Symbol.dispose](): void {
        order.push('first')
      }
    }
    class Second {
      first = inject(First)
      async [Symbol.asyncDispose](): Promise<void> {
        order.push('second')
      }
    }
    const external = {
      [Symbol.dispose]: () => order.push('external'),
    }
    const ExternalToken = createToken<typeof external>('external')

    const c = new Container().instance(ExternalToken, external)
    c.make(Second)
    await c.dispose()
    expect(order).toEqual(['second', 'first'])
    expect(() => c.make(First)).toThrow(/disposed/)
  })
})
