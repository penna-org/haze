import type { SQL, Table } from 'drizzle-orm'
import type { Paginated } from '../types'
import type { ModelClass, ModelLike, TableOf } from './model'
import type { ActiveRecord, RelationName } from './record'
import { isNotNull, isNull } from 'drizzle-orm'
import { ModelNotFoundException } from '../errors'
import { andAll, QueryBuilder } from '../query/builder'
import { nowFor, pascalCase } from '../utils'
import { metaOf } from './meta'
import { hydrateModel } from './model'
import { loadRelations } from './relations'

type TrashedMode = 'without' | 'with' | 'only'

/** 模型查询：结果为模型实例，自动应用软删除范围，支持预加载关联与作用域 */
export class ModelQuery<M extends ModelLike> extends QueryBuilder<TableOf<M> & Table, M> {
  readonly model: ModelClass<M>
  protected trashed: TrashedMode = 'without'
  protected eager: string[] = []

  constructor(model: ModelClass<M>) {
    super(metaOf(model).table as TableOf<M> & Table, { connection: model.connection })
    this.model = model
  }

  /** 包含已软删除的数据 */
  withTrashed(): this {
    this.trashed = 'with'
    return this
  }

  /** 只查询已软删除的数据 */
  onlyTrashed(): this {
    this.trashed = 'only'
    return this
  }

  /** 预加载关联：`with('posts', 'posts.comments', 'profile')` */
  with(...relations: Array<RelationName<M> | `${RelationName<M>}.${string}`>): this {
    this.eager.push(...relations)
    return this
  }

  /** 调用模型上的 `static scopeXxx(query, ...args)`：`scope('active')` */
  scope(name: string, ...args: unknown[]): this {
    const method = (this.model as unknown as Record<string, unknown>)[`scope${pascalCase(name)}`]
    if (typeof method !== 'function')
      throw new TypeError(`Scope "${name}" is not defined on ${this.model.name} (expected static scope${pascalCase(name)}(query))`)
    method.call(this.model, this, ...args)
    return this
  }

  /** 按主键查询；不传主键时取第一条 */
  override async find(id?: unknown): Promise<M | undefined> {
    if (id === undefined)
      return super.find()
    return this.clone().where(this.primaryKey() as never, id as never).limit(1).select().then(rows => rows[0])
  }

  override async findOrFail(id?: unknown): Promise<M> {
    const model = await this.find(id)
    if (!model)
      throw new ModelNotFoundException(this.model.name, id)
    return model
  }

  override paginate(page = 1, perPage = 15): Promise<Paginated<M>> {
    return super.paginate(page, perPage)
  }

  /** 批量删除：启用软删除时只标记删除时间 */
  override async delete(options: { all?: boolean } = {}): Promise<number> {
    const { softDelete, columns } = metaOf(this.model)
    if (softDelete && this.trashed !== 'only') {
      return this.update({
        [softDelete]: nowFor(columns[softDelete]),
      }, options)
    }
    return super.delete(options)
  }

  /** 物理删除（忽略软删除） */
  async forceDelete(options: { all?: boolean } = {}): Promise<number> {
    return super.delete(options)
  }

  /** 恢复软删除的数据 */
  async restore(options: { all?: boolean } = {}): Promise<number> {
    const { softDelete } = metaOf(this.model)
    if (!softDelete)
      return 0
    return this.withTrashed().update({ [softDelete]: null }, options)
  }

  protected override scopedWhere(): SQL | undefined {
    const { softDelete } = metaOf(this.model)
    if (!softDelete || this.trashed === 'with')
      return this.buildWhere()
    const column = this.columnOf(softDelete)
    return andAll(this.buildWhere(), this.trashed === 'only'
      ? isNotNull(column)
      : isNull(column))
  }

  protected override async transform(rows: Array<Record<string, unknown>>): Promise<M[]> {
    const models = rows.map(row => hydrateModel(this.model, row))
    if (this.eager.length)
      await loadRelations(models as unknown as ActiveRecord[], this.eager)
    return models
  }

  protected override label(): string {
    return this.model.name
  }

  override clone(): this {
    const copy = super.clone()
    copy.eager = [...this.eager]
    return copy
  }

  protected primaryKey(): string {
    const key = metaOf(this.model).primaryKey
    if (!key)
      throw new Error(`Model ${this.model.name} has no single-column primary key`)
    return key
  }
}
