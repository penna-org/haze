import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ValidationIssue } from '../exception/exceptions'
import type { HttpContext, ValidationTargets } from './context'
import { getQuery } from 'h3'
import { ValidationException } from '../exception/exceptions'

type Target = keyof ValidationTargets

const sources: Record<Target, (ctx: HttpContext) => unknown> = {
  params: ctx => ctx.params(),
  query: ctx => getQuery(ctx.event),
  headers: ctx => Object.fromEntries(ctx.req.headers),
  body: ctx => ctx.body(),
}

/** 按 params → query → headers → body 顺序校验，汇总所有错误后一次性抛出 422 */
export async function validateRequest(ctx: HttpContext, schemas: ValidationTargets): Promise<void> {
  const issues: ValidationIssue[] = []
  const validated: Record<string, unknown> = {}

  for (const target of Object.keys(sources) as Target[]) {
    const schema = schemas[target]
    if (!schema)
      continue
    const result = await schema['~standard'].validate(await sources[target](ctx))
    if (result.issues)
      issues.push(...result.issues.map(issue => toIssue(issue, target)))
    else
      validated[target] = result.value
  }

  if (issues.length)
    throw new ValidationException(issues)
  Object.assign(ctx.validated, validated)
}

/** 直接用 Standard Schema（zod / valibot / arktype ...）校验任意值 */
export async function validate<S extends StandardSchemaV1>(schema: S, value: unknown): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema['~standard'].validate(value)
  if (result.issues)
    throw new ValidationException(result.issues.map(issue => toIssue(issue)))
  return result.value
}

function toIssue(issue: StandardSchemaV1.Issue, target?: string): ValidationIssue {
  const path = (issue.path ?? [])
    .map(segment => String(typeof segment === 'object'
      ? segment.key
      : segment))
    .join('.')
  return { target, path, message: issue.message }
}
