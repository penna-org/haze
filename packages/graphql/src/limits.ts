import type { FieldNode, FragmentDefinitionNode, GraphQLCompositeType, GraphQLField, OperationDefinitionNode, SelectionSetNode, ValidationContext, ValidationRule } from 'graphql'
import type { Complexity } from './schema'
import { getNamedType, GraphQLError, isCompositeType, isInterfaceType, isObjectType, valueFromASTUntyped } from 'graphql'
import { ErrorCode } from './errors'

/** 内省字段（__schema / __type）的子树不计入深度与复杂度，内省由 introspection 选项控制 */
const isIntrospectionField = (node: FieldNode): boolean => node.name.value.startsWith('__')

/** 查询深度限制：`{ a { b { c } } }` 的深度为 3 */
export function depthLimit(maxDepth: number): ValidationRule {
  return (context: ValidationContext) => ({
    OperationDefinition(operation: OperationDefinitionNode) {
      const depth = measureDepth(operation.selectionSet, context, new Set())
      if (depth > maxDepth) {
        context.reportError(new GraphQLError(`Query depth ${depth} exceeds the maximum allowed depth of ${maxDepth}`, {
          nodes: [operation],
          extensions: { code: ErrorCode.DEPTH_LIMIT_EXCEEDED },
        }))
      }
    },
  })
}

function measureDepth(selectionSet: SelectionSetNode, context: ValidationContext, visited: Set<string>): number {
  let max = 0
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      if (isIntrospectionField(selection))
        continue
      const child = selection.selectionSet
        ? measureDepth(selection.selectionSet, context, visited)
        : 0
      max = Math.max(max, 1 + child)
    }
    else if (selection.kind === 'InlineFragment') {
      max = Math.max(max, measureDepth(selection.selectionSet, context, visited))
    }
    else {
      const name = selection.name.value
      const fragment = context.getFragment(name)
      // 循环引用由内置的 NoFragmentCycles 规则报告
      if (!fragment || visited.has(name))
        continue
      visited.add(name)
      max = Math.max(max, measureDepth(fragment.selectionSet, context, visited))
      visited.delete(name)
    }
  }
  return max
}

/**
 * 复杂度限制：每个字段默认 1 + 子字段之和；字段可用 `complexity`
 * （code-first 写在字段的 extensions.complexity，schema-first 写在解析器对象上）声明固定值，
 * 或 `({ args, childComplexity }) => number`（如按分页参数放大：`args.first * childComplexity`）。
 */
export function complexityLimit(maxComplexity: number, variables: Record<string, unknown> = {}): ValidationRule {
  return (context: ValidationContext) => ({
    OperationDefinition(operation: OperationDefinitionNode) {
      const schema = context.getSchema()
      const root = operation.operation === 'query'
        ? schema.getQueryType()
        : operation.operation === 'mutation'
          ? schema.getMutationType()
          : schema.getSubscriptionType()
      if (!root)
        return
      const cost = measureComplexity(operation.selectionSet, root, context, variables, new Set())
      if (cost > maxComplexity) {
        context.reportError(new GraphQLError(`Query complexity ${cost} exceeds the maximum allowed complexity of ${maxComplexity}`, {
          nodes: [operation],
          extensions: { code: ErrorCode.COMPLEXITY_LIMIT_EXCEEDED, complexity: cost, maxComplexity },
        }))
      }
    },
  })
}

function measureComplexity(
  selectionSet: SelectionSetNode,
  parent: GraphQLCompositeType,
  context: ValidationContext,
  variables: Record<string, unknown>,
  visited: Set<string>,
): number {
  let total = 0
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      if (isIntrospectionField(selection))
        continue
      const definition: GraphQLField<unknown, unknown> | undefined = isObjectType(parent) || isInterfaceType(parent)
        ? parent.getFields()[selection.name.value]
        : undefined
      if (!definition)
        continue
      const type = getNamedType(definition.type)
      const childComplexity = selection.selectionSet && isCompositeType(type)
        ? measureComplexity(selection.selectionSet, type, context, variables, visited)
        : 0
      const complexity = (definition.extensions as { complexity?: Complexity } | undefined)?.complexity
      if (typeof complexity === 'function') {
        const args = Object.fromEntries((selection.arguments ?? []).map(arg => [
          arg.name.value,
          valueFromASTUntyped(arg.value, variables),
        ]))
        total += complexity({ args, childComplexity })
      }
      else {
        total += (complexity ?? 1) + childComplexity
      }
    }
    else if (selection.kind === 'InlineFragment') {
      const condition = selection.typeCondition
        ? context.getSchema().getType(selection.typeCondition.name.value)
        : parent
      if (condition && isCompositeType(condition))
        total += measureComplexity(selection.selectionSet, condition, context, variables, visited)
    }
    else {
      const name = selection.name.value
      const fragment: FragmentDefinitionNode | null | undefined = context.getFragment(name)
      if (!fragment || visited.has(name))
        continue
      const condition = context.getSchema().getType(fragment.typeCondition.name.value)
      if (!condition || !isCompositeType(condition))
        continue
      visited.add(name)
      total += measureComplexity(fragment.selectionSet, condition, context, variables, visited)
      visited.delete(name)
    }
  }
  return total
}
