import type {
  DocumentNode,
  GraphQLDirective,
  GraphQLEnumTypeConfig,
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLFieldConfigMap,
  GraphQLInputFieldConfigMap,
  GraphQLInputObjectTypeConfig,
  GraphQLIsTypeOfFn,
  GraphQLNamedType,
  GraphQLNullableType,
  GraphQLObjectTypeConfig,
  GraphQLResolveInfo,
  GraphQLSchemaConfig,
  GraphQLType,
  GraphQLTypeResolver,
} from 'graphql'
import type { GraphQLContext } from './context'
import {
  buildASTSchema,
  concatAST,
  GraphQLDirective as Directive,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLUnionType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isIntrospectionType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isSpecifiedDirective,
  isSpecifiedScalarType,
  isUnionType,
  parse,
} from 'graphql'

/** 字段解析函数：ctx 为 hazejs 的 GraphQL 上下文 */
export type ResolverFn<TSource = any, TArgs = any, TResult = unknown> = (
  source: TSource,
  args: TArgs,
  ctx: GraphQLContext,
  info: GraphQLResolveInfo,
) => TResult

/** 字段的对象写法：订阅字段需要 subscribe（返回 AsyncIterable），resolve 可选 */
export interface ResolverObject<TSource = any, TArgs = any> {
  resolve?: ResolverFn<TSource, TArgs>
  subscribe?: ResolverFn<TSource, TArgs, AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>>
  /** 复杂度：固定值，或按参数与子字段复杂度计算（见 maxComplexity） */
  complexity?: Complexity
}

export type Complexity = number | ((options: { args: Record<string, unknown>, childComplexity: number }) => number)

/** 类型解析器：字段名 → 解析函数；接口 / 联合类型用 `__resolveType`，对象类型可用 `__isTypeOf` */
export interface TypeResolvers {
  // info 写作 any：与字段解析函数的签名兼容，字段解析函数才能获得上下文类型推断
  __resolveType?: (value: any, ctx: GraphQLContext, info: any) => string | undefined | Promise<string | undefined>
  __isTypeOf?: (value: any, ctx: GraphQLContext, info: any) => boolean | Promise<boolean>
  [field: string]: ResolverFn | ResolverObject | undefined
}

/** 枚举的内部值：`{ Role: { ADMIN: 'admin' } }` */
export type EnumValues = Record<string, string | number | boolean | object>

/**
 * 解析器映射：类型名 → 字段解析器；自定义标量直接给 GraphQLScalarType，
 * 枚举给 `{ 名称: 内部值 }`
 */
export type Resolvers = Record<string, TypeResolvers | GraphQLScalarType | EnumValues>

export interface SchemaDefinition {
  /** SDL：字符串、多个字符串（可用 `extend type Query` 拆分）或已解析的 DocumentNode */
  typeDefs: string | DocumentNode | Array<string | DocumentNode>
  /** 解析器，数组会按顺序合并 */
  resolvers?: Resolvers | Resolvers[]
}

/**
 * 定义 GraphQL schema：
 *
 * - Schema-first：`defineSchema({ typeDefs, resolvers })`；
 * - Code-first：`defineSchema({ query: new GraphQLObjectType(...) })`（即 GraphQLSchemaConfig）；
 * - 已有的 GraphQLSchema 原样返回。
 *
 * ```ts
 * export default defineSchema({
 *   typeDefs: `type Query { hello(name: String): String! }`,
 *   resolvers: { Query: { hello: (_, { name }) => `Hello ${name ?? 'world'}` } },
 * })
 * ```
 */
export function defineSchema(definition: SchemaDefinition | GraphQLSchemaConfig | GraphQLSchema): GraphQLSchema {
  if (definition instanceof GraphQLSchema)
    return definition
  if ('typeDefs' in definition)
    return buildFromSDL(definition)
  return new GraphQLSchema(definition)
}

function buildFromSDL({ typeDefs, resolvers }: SchemaDefinition): GraphQLSchema {
  const documents = (Array.isArray(typeDefs)
    ? typeDefs
    : [typeDefs]).map(item => typeof item === 'string'
    ? parse(item)
    : item)
  // 只有 extend type Query 时补一个空的根类型，便于按模块拆分 SDL
  const base = buildASTSchema(concatAST(withRootTypes(documents)))
  return applyResolvers(base, mergeResolvers(Array.isArray(resolvers)
    ? resolvers
    : resolvers
      ? [resolvers]
      : []))
}

function withRootTypes(documents: DocumentNode[]): DocumentNode[] {
  const defined = new Set<string>()
  const extended = new Set<string>()
  for (const document of documents) {
    for (const node of document.definitions) {
      if (node.kind === 'ObjectTypeDefinition')
        defined.add(node.name.value)
      else if (node.kind === 'ObjectTypeExtension')
        extended.add(node.name.value)
    }
  }
  const missing = ['Query', 'Mutation', 'Subscription'].filter(name => extended.has(name) && !defined.has(name))
  return missing.length
    ? [
        parse(missing.map(name => `type ${name}`).join('\n')),
        ...documents,
      ]
    : documents
}

function mergeResolvers(list: Resolvers[]): Resolvers {
  const merged: Resolvers = {}
  for (const resolvers of list) {
    for (const [type, value] of Object.entries(resolvers)) {
      merged[type] = value instanceof GraphQLScalarType || !(type in merged)
        ? value
        : {
            ...merged[type],
            ...value,
          } as TypeResolvers
    }
  }
  return merged
}

/**
 * 把解析器写入 schema：按类型配置（toConfig）重建所有具名类型，
 * 不修改 graphql-js 的内部字段，graphql 16 与 17 都适用。
 */
function applyResolvers(schema: GraphQLSchema, resolvers: Resolvers): GraphQLSchema {
  const typeMap = schema.getTypeMap()
  for (const name of Object.keys(resolvers)) {
    if (!typeMap[name])
      throw new Error(`Resolvers are defined for type "${name}", which is not in the schema`)
  }

  const rebuilt = new Map<string, GraphQLNamedType>()
  const named = <T extends GraphQLNamedType>(type: T): T => (rebuilt.get(type.name) ?? type) as T
  const wrap = <T extends GraphQLType>(type: T): T => {
    if (isListType(type))
      return new GraphQLList(wrap(type.ofType)) as unknown as T
    if (isNonNullType(type))
      return new GraphQLNonNull(wrap(type.ofType)) as unknown as T
    return named(type as GraphQLNamedType) as unknown as T
  }
  const args = (map: GraphQLFieldConfigArgumentMap): GraphQLFieldConfigArgumentMap =>
    Object.fromEntries(Object.entries(map).map(([key, arg]) => [
      key,
      {
        ...arg,
        type: wrap(arg.type),
      },
    ]))

  for (const type of Object.values(typeMap)) {
    if (isIntrospectionType(type) || isSpecifiedScalarType(type))
      continue
    const own = resolvers[type.name]
    if (isObjectType(type) || isInterfaceType(type)) {
      const config = type.toConfig()
      const map = (own ?? {}) as TypeResolvers
      for (const key of Object.keys(map)) {
        if (!key.startsWith('__') && !(key in config.fields))
          throw new Error(`Resolver "${type.name}.${key}" is defined, but the field is not in the schema`)
      }
      const fields = (): GraphQLFieldConfigMap<unknown, unknown> => Object.fromEntries(Object.entries(config.fields).map(([key, field]) => {
        const resolver = map[key]
        const next: GraphQLFieldConfig<unknown, unknown> = {
          ...field,
          type: wrap(field.type),
          args: args(field.args ?? {}),
        }
        if (typeof resolver === 'function') {
          next.resolve = resolver as GraphQLFieldConfig<unknown, unknown>['resolve']
        }
        else if (resolver) {
          if (resolver.resolve)
            next.resolve = resolver.resolve as GraphQLFieldConfig<unknown, unknown>['resolve']
          if (resolver.subscribe)
            next.subscribe = resolver.subscribe as GraphQLFieldConfig<unknown, unknown>['subscribe']
          if (resolver.complexity !== undefined)
            next.extensions = { ...field.extensions, complexity: resolver.complexity }
        }
        return [key, next]
      }))
      const interfaces = (): GraphQLInterfaceType[] => config.interfaces.map(named)
      if (isObjectType(type)) {
        rebuilt.set(type.name, new GraphQLObjectType({
          ...(config as GraphQLObjectTypeConfig<unknown, unknown>),
          fields,
          interfaces,
          ...(map.__isTypeOf && { isTypeOf: map.__isTypeOf as GraphQLIsTypeOfFn<unknown, unknown> }),
        }))
      }
      else {
        rebuilt.set(type.name, new GraphQLInterfaceType({
          ...type.toConfig(),
          fields,
          interfaces,
          ...(map.__resolveType && { resolveType: map.__resolveType as GraphQLTypeResolver<unknown, unknown> }),
        }))
      }
    }
    else if (isUnionType(type)) {
      const config = type.toConfig()
      const map = (own ?? {}) as TypeResolvers
      rebuilt.set(type.name, new GraphQLUnionType({
        ...config,
        types: () => config.types.map(named),
        ...(map.__resolveType && { resolveType: map.__resolveType as GraphQLTypeResolver<unknown, unknown> }),
      }))
    }
    else if (isInputObjectType(type)) {
      const config = type.toConfig()
      rebuilt.set(type.name, new GraphQLInputObjectType({
        ...config,
        fields: (): GraphQLInputFieldConfigMap => Object.fromEntries(Object.entries(config.fields).map(([key, field]) => [
          key,
          {
            ...field,
            type: wrap(field.type),
          },
        ])),
      }))
    }
    else if (isEnumType(type)) {
      const config = type.toConfig() as GraphQLEnumTypeConfig
      const values = own as EnumValues | undefined
      for (const key of Object.keys(values ?? {})) {
        if (!(key in config.values))
          throw new Error(`Enum value "${type.name}.${key}" is not in the schema`)
      }
      rebuilt.set(type.name, new GraphQLEnumType({
        ...config,
        values: Object.fromEntries(Object.entries(config.values).map(([key, value]) => [
          key,
          values && key in values
            ? { ...value, value: values[key] }
            : value,
        ])),
      }))
    }
    else if (isScalarType(type)) {
      if (own && !(own instanceof GraphQLScalarType))
        throw new TypeError(`Resolver for scalar "${type.name}" must be a GraphQLScalarType`)
      // 自定义标量：使用传入的实现，保留 SDL 中的描述
      rebuilt.set(type.name, own
        ? new GraphQLScalarType({
            ...own.toConfig(),
            name: type.name,
            description: own.description ?? type.description,
            astNode: type.astNode,
          })
        : type)
    }
  }

  const config = schema.toConfig()
  const root = (type: GraphQLObjectType | null | undefined): GraphQLObjectType | undefined => type
    ? named(type)
    : undefined
  return new GraphQLSchema({
    ...config,
    query: root(config.query),
    mutation: root(config.mutation),
    subscription: root(config.subscription),
    types: [
      ...rebuilt.values(),
    ],
    directives: config.directives.map(directive => isSpecifiedDirective(directive)
      ? directive
      : rebuildDirective(directive, args)),
  })
}

function rebuildDirective(directive: GraphQLDirective, args: (map: GraphQLFieldConfigArgumentMap) => GraphQLFieldConfigArgumentMap): GraphQLDirective {
  const config = directive.toConfig()
  return new Directive({
    ...config,
    args: args(config.args),
  })
}

// ---------------------------------------------------------------------------
// Code-first：在 graphql-js 的类型构造器上补充上下文类型，可与原生写法混用
// ---------------------------------------------------------------------------

export type FieldConfig<TSource = any, TArgs = any> = Omit<GraphQLFieldConfig<TSource, GraphQLContext, TArgs>, 'extensions'> & {
  /** 复杂度（见 maxComplexity），也可写在 extensions.complexity */
  complexity?: Complexity
  extensions?: GraphQLFieldConfig<TSource, GraphQLContext, TArgs>['extensions']
}

/** 字段：解析函数的 ctx 为 GraphQLContext */
export function field<TSource = any, TArgs = any>(config: FieldConfig<TSource, TArgs>): GraphQLFieldConfig<TSource, GraphQLContext, TArgs> {
  const { complexity, ...rest } = config
  return complexity === undefined
    ? rest
    : {
        ...rest,
        extensions: { ...rest.extensions, complexity },
      }
}

/** 对象类型：`objectType<User>({ name: 'User', fields: () => ({ ... }) })` */
export function objectType<TSource = any>(config: GraphQLObjectTypeConfig<TSource, GraphQLContext>): GraphQLObjectType<TSource, GraphQLContext> {
  return new GraphQLObjectType(config)
}

/** 输入类型 */
export function inputType(config: GraphQLInputObjectTypeConfig): GraphQLInputObjectType {
  return new GraphQLInputObjectType(config)
}

/** `nonNull(GraphQLString)` → `String!` */
export function nonNull<T extends GraphQLNullableType>(type: T): GraphQLNonNull<T> {
  return new GraphQLNonNull(type)
}

/** `list(User)` → `[User]` */
export function list<T extends GraphQLType>(type: T): GraphQLList<T> {
  return new GraphQLList(type)
}
