# 全文搜索

`@hazejs/search` 为[模型](./models)提供全文搜索：把模型标记为可搜索后，模型增删改时自动同步索引，再用一个精简的构造器搜索，按相关度返回模型。多种引擎共用同一套 API：

| 引擎 | 索引在哪里 | 需要什么 |
| --- | --- | --- |
| `database` | 业务数据库本身：MySQL `FULLTEXT`、PostgreSQL `tsvector`、SQLite FTS5，或 `LIKE` | 全文索引（一条命令即可创建） |
| `meilisearch` | [Meilisearch](https://www.meilisearch.com) | Meilisearch 服务 |
| `typesense` | [Typesense](https://typesense.org) | Typesense 服务 |
| `elasticsearch` / `opensearch` | Elasticsearch 8 / 9 或 OpenSearch 2 / 3 | 集群 |
| `memory` | 当前进程 | 无（测试、原型） |

外部引擎都用 `fetch` 直接调用 HTTP 接口，不依赖 SDK，在 Edge 上也能用。

```bash
pnpm add @hazejs/search
```

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 安装与配置

注册服务提供者：

```ts
// app/provider/SearchProvider.ts
import { searchProvider } from '@hazejs/search'

export default searchProvider()
```

在 `config/search.ts` 中声明引擎。没有这个文件时使用 `database` 引擎。

```ts
// config/search.ts
import { env } from '@hazejs/core'
import { defineSearchConfig } from '@hazejs/search'

export default defineSearchConfig(() => ({
  default: env('SEARCH_ENGINE', 'database'),
  engines: {
    database: {},
    meilisearch: { url: env('MEILISEARCH_URL', 'http://127.0.0.1:7700'), key: env('MEILISEARCH_KEY', '') },
    typesense: { url: env('TYPESENSE_URL', 'http://127.0.0.1:8108'), key: env('TYPESENSE_KEY', '') },
    elasticsearch: {
      url: env('ELASTICSEARCH_URL', 'http://127.0.0.1:9200'),
      auth: { username: 'elastic', password: env('ELASTICSEARCH_PASSWORD', '') },
    },
    // OpenSearch 的选项相同：{ driver: 'opensearch', url, auth }
  },
  // 所有索引名的前缀（多个环境共用一个搜索服务时区分）
  prefix: env('SEARCH_PREFIX', ''),
  // 通过队列同步索引，而不是在请求中同步
  queue: false,
}))
```

| 选项 | 说明 |
| --- | --- |
| `default` | 未指定引擎的模型使用的引擎，默认 `database` |
| `engines` | 按名字声明的引擎。`driver` 缺省时取键名，所以 `meilisearch: {...}` 就是 Meilisearch 引擎 |
| `prefix` | 加在所有索引名前面的前缀 |
| `queue` | `true` 或 `{ connection, queue }`：通过[队列](./queues)同步索引，默认 `false` |
| `chunk` | `search:import` 每批读取的数量，默认 `500` |

各引擎的选项：

| 引擎 | 选项 |
| --- | --- |
| `database` | `mode`（`fulltext` 或 `like`）、`language`（PostgreSQL 的文本搜索配置，默认 `english`）、`mysqlMode`（`natural` 或 `boolean`） |
| `meilisearch` | `url`、`key`、`wait`（写入后等待任务完成，默认 `false`）、`waitTimeout` |
| `typesense` | `url`、`key` |
| `elasticsearch` / `opensearch` | `url`、`auth`（`{ username, password }` 或 `{ apiKey }`）、`refresh`（写入后 `true` / `'wait_for'`）、`keywordSuffix`（默认 `.keyword`） |
| `custom` | `{ driver: 'custom', engine }`，`engine` 实现 `SearchEngine` 接口 |

所有引擎都接受 `fetch` 选项，用于代理或测试。

## 让模型可搜索

在模型文件中调用 `searchable()`：

```ts
// app/model/Post.ts
import { Model } from '@hazejs/orm'
import { searchable } from '@hazejs/search'
import { posts } from '../../database/schema/posts'

export class Post extends Model.define(posts) {
  static override softDelete = true
}

searchable(Post, {
  index: 'posts', // 默认为表名
  toSearchable: post => ({
    title: post.title,
    body: post.body,
    status: post.status,
    views: post.views,
  }),
  shouldBeSearchable: post => post.status !== 'archived',
  settings: {
    searchable: ['title', 'body'],
    filterable: ['status'],
    sortable: ['views'],
  },
})
```

| 选项 | 说明 |
| --- | --- |
| `index` | 索引名，默认为表名；前面会加上配置中的 `prefix` |
| `engine` | `config/search.ts` 中的引擎名，默认为 `default` |
| `toSearchable` | 写入索引的文档，默认为 `model.toJSON()`（`hidden` 字段不会进入索引）。可以是异步函数（在这里加载关联）。主键会自动加入 |
| `shouldBeSearchable` | 返回 `false` 的模型不进入索引；不再满足条件的模型会被移出 |
| `settings` | `searchable`、`filterable`、`sortable`，以及各引擎专有的 `meilisearch`、`typesense`、`elasticsearch` 设置，由 `search:sync-settings` 同步 |
| `queue` | 覆盖配置中的 `queue` |
| `importQuery` | 调整 `search:import` 使用的查询，如 `q => q.with('author')` |
| `database` | database 引擎的选项（见下文） |

模型事件发生后同步索引：

- **新增 / 修改**（`save()`、`create()`、`update()`）：写入文档；`shouldBeSearchable` 返回 `false` 时移出；
- **删除**：移出索引。软删除同样移出，`restore()` 后重新写入；
- **物理删除**：移出索引。

通过查询构造器批量更新 / 删除（`Post.where(...).update()`）不触发模型事件，也就不会同步索引，之后请执行 `search:import`。

批量写入时不想同步（如数据填充），把操作包在 `withoutSyncing` 中：

```ts
import { withoutSyncing } from '@hazejs/search'

await withoutSyncing(async () => {
  for (const row of rows)
    await Post.create(row)
})
```

::: warning 事务
同步在写入之后立即进行，即使处于事务中。事务回滚后，索引中仍有该文档。在事务中写入时，可以用 `withoutSyncing` 包裹并在之后导入，或开启 `queue` 让任务稍后执行。
:::

## 搜索

```ts
import { search } from '@hazejs/search'

// 按相关度返回模型
const posts = await search(Post, 'haze framework').get()

// 过滤、排序、分页
const page = await search(Post, 'haze')
  .where('status', 'published')
  .whereIn('category', ['news', 'blog'])
  .whereNotIn('id', [1, 2])
  .orderBy('views', 'desc')
  .paginate(1, 20)
// { data: Post[], total, page, perPage, lastPage }，与 ORM 的 paginate() 结构相同
```

`searchable()` 返回的是同一个类，带有 `search` 方法的类型，所以也可以在它的返回值上写 `Post.search('haze')`：

```ts
export const SearchablePost = searchable(Post, { /* ... */ })
await SearchablePost.search('haze').get()
```

| 方法 | 说明 |
| --- | --- |
| `where(field, value)` / `whereIn` / `whereNotIn` | 精确过滤。外部引擎要求字段在 `settings.filterable` 中 |
| `orderBy(field, direction?)` | 按字段排序，替代相关度。外部引擎要求字段在 `settings.sortable` 中 |
| `take(n)` | `get()` / `keys()` / `raw()` 取回的数量，默认 1000 |
| `options({...})` | 引擎的原生选项，合并到请求中（见下文） |
| `constrain(q => ...)` | 约束加载模型的 ORM 查询（预加载关联、附加条件）；database 引擎直接作用于搜索查询 |
| `within(index)` | 搜索同一模型的其它索引 |
| `get()` / `first()` | 按相关度返回模型 |
| `paginate(page?, perPage?)` | 一页模型，以及引擎统计的 `total`。默认 `page = 1`、`perPage = 15` |
| `keys()` | 只返回主键（不查数据库） |
| `count()` | 匹配数量 |
| `raw()` | 引擎的原始响应 |

引擎返回结果后，按主键从数据库加载模型并保持引擎给出的顺序。数据库中已不存在（或已软删除）的记录会被略过，因此 `data` 可能少于 `perPage`。

通过 `options()` 传入的原生选项：

- **Meilisearch**：任意[搜索参数](https://www.meilisearch.com/docs/reference/api/search)，如 `attributesToHighlight`、`matchingStrategy`、`showRankingScoreDetails`；
- **Typesense**：任意搜索参数，如 `num_typos`、`prefix`、`query_by_weights`；
- **Elasticsearch / OpenSearch**：`_search` 请求体的顶层字段，如 `highlight`、`min_score`；
- **database**：`mode`（`fulltext` / `like`）、`mysqlMode`（`natural` / `boolean`），以及 `raw: true`（原样传入 SQLite FTS5 查询语法）。

## database 引擎

database 引擎直接搜索模型自己的表，不需要额外的服务。结果直接来自 ORM 查询，软删除、全局作用域与[租户隔离](./tenancy)都会自动生效。

| 方言 | 查询 | 索引 |
| --- | --- | --- |
| MySQL | `MATCH (cols) AGAINST (? IN NATURAL LANGUAGE MODE)`（或 `BOOLEAN MODE`），按相关度排序 | 这些列上的 `FULLTEXT` 索引 |
| PostgreSQL / PGlite | `to_tsvector(lang, cols) @@ websearch_to_tsquery(lang, ?)`，按 `ts_rank` 排序 | 同一表达式上的 GIN 索引，或生成的 `tsvector` 列 |
| SQLite / libsql / Turso / D1 | FTS5 `MATCH`，按 `bm25()` 排序 | FTS5 虚拟表 |
| 任意 | `mode: 'like'`：每个词都要出现在某一列中（PostgreSQL 用 `ILIKE`） | 无 |

选项写在 `searchable()` 的 `database` 中：

```ts
searchable(Post, {
  settings: { searchable: ['title', 'body'] },
  database: {
    columns: ['title', 'body'], // 默认为 settings.searchable，否则为全部字符串列
    mode: 'fulltext', // 或 'like'
    language: 'english', // PostgreSQL
    vectorColumn: 'searchVector', // PostgreSQL：使用已有的 tsvector 列
    mysqlMode: 'natural', // 或 'boolean'
    indexName: 'posts_search',
    fts: { table: 'posts_fts', sync: 'triggers', tokenize: 'unicode61' }, // SQLite
  },
})
```

### 创建索引

`haze search:sync-settings` 会在全文索引不存在时创建它，重复执行没有影响。如果想放进迁移，可以打印出语句，粘贴到自定义迁移中（`drizzle-kit generate --custom`）：

```ts
import { dropSearchIndexSql, searchIndexSql } from '@hazejs/search'

searchIndexSql(Post) // up
dropSearchIndexSql(Post) // down
// 也可以在代码中创建：await createSearchIndex(Post)
```

各方言创建的内容：

- **MySQL**：`alter table posts add fulltext index posts_search (title, body)`。`MATCH` 中的列必须与某个 `FULLTEXT` 索引的列完全一致。
- **PostgreSQL**：`create index posts_search on posts using gin (to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(body, '')))`。查询使用同一个表达式，因此能用上索引。也可以把向量存成生成列，再设置 `vectorColumn`：

  ```sql
  alter table posts add column search_vector tsvector
    generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) stored;
  ```

- **SQLite FTS5** 有两种同步方式：
  - `triggers`（默认）：外部内容表（`content='posts'`），由 3 个触发器在增删改时同步，创建时执行一次 `rebuild` 导入已有数据。只能索引表中的列。
  - `engine`：独立的 FTS5 表，由搜索包在模型事件中写入 `toSearchable()` 的字段，因此可以索引计算字段（如作者名）。不经过模型事件修改的数据需要 `search:import`。

  中文、日文等词之间没有空格的语言，可使用 `fts: { tokenize: 'trigram' }` 做子串匹配。

传给 FTS5 的搜索词会逐个加引号，最后一个词做前缀匹配；用户输入中的 `"`、`*`、`-` 等字符不会造成语法错误。需要原样使用 FTS5 语法时，传 `options({ raw: true })`。

## 外部引擎

### Meilisearch

Meilisearch 的写入是异步任务：调用返回后稍等片刻文档才可被搜索到。设置 `wait: true` 会等待每个任务完成（测试中常用）；`search:import`、`search:flush`、`search:sync-settings` 始终会等待。`search:sync-settings` 以模型主键创建索引，再同步 `searchableAttributes`、`filterableAttributes`、`sortableAttributes` 与 `settings.meilisearch` 中的其它设置。

过滤字段必须先加入 `filterable`，排序字段必须先加入 `sortable`，否则 Meilisearch 会报错。

### Typesense

集合在第一次写入或 `search:sync-settings` 时创建。默认结构为 `{ name: '.*', type: 'auto' }`，按第一条文档推断字段类型，其中数字字段可以排序。字符串字段需要排序时，在 `settings.typesense.fields` 中声明：

```ts
settings: {
  searchable: ['title', 'body'], // 作为 query_by
  typesense: {
    fields: [
      { name: 'title', type: 'string', sort: true },
      { name: 'body', type: 'string' },
      { name: 'status', type: 'string', facet: true },
      { name: 'views', type: 'int32' },
    ],
  },
}
```

文档 `id` 是主键的字符串形式，加载模型时会转回数字。Typesense 每页最多返回 250 条，需要更多时 `get()` 会分多页取回。`search:flush` 会删除整个集合，下次写入时重建；修改字段结构时，先 flush 再重新同步设置。

### Elasticsearch 与 OpenSearch

文档通过 `_bulk` 接口写入，`_id` 为主键。查询为 `bool`：在 `settings.searchable` 上做 `multi_match`（所有词都要匹配），过滤用 `term` / `terms`。动态映射会把字符串映射为 `text` 并带一个 `.keyword` 子字段，因此字符串过滤使用 `field.keyword`。如果自定义 mappings 直接把字段映射为 `keyword`，请设置 `keywordSuffix: ''`。排序请使用数字、日期或 `title.keyword`，不要用 `text` 字段。

`search:sync-settings` 在索引不存在时按 `settings.elasticsearch.mappings` / `settings` 创建，已存在时追加新的映射。写入是近实时的，设置 `refresh: true`（测试）或 `'wait_for'` 可以让写入立即可见。

## 通过队列同步

开启 `queue: true`（配置中或模型上）后，模型事件改为投递内置任务 `search:sync`，不再在请求中调用引擎。文档在投递时就已生成，worker 不需要加载模型。照常运行 worker（`haze queue:work`），worker 中同样要注册 `searchProvider()`。任务最多执行 3 次（间隔 5 秒、30 秒）。

database 引擎始终立即同步：它的索引就在同一个数据库中。

## 命令

| 命令 | 说明 |
| --- | --- |
| `haze search:import Post` | 把全部记录写入索引（跳过已软删除的和 `shouldBeSearchable` 不通过的）。database 引擎会重建 FTS5 表，MySQL / PostgreSQL 的索引始终是最新的，无需操作 |
| `haze search:flush Post` | 清空模型索引中的全部文档 |
| `haze search:sync-settings [Post]` | 创建索引并同步设置；不指定模型时处理全部可搜索的模型 |

模型名可以是类名或索引名。命令会加载 `app/model`（以及 `app/<应用>/model`）下的文件，因此 `searchable()` 需要写在模型文件中。代码中也可以直接调用：`importSearchable(Post)`、`flushSearchable(Post)`、`syncSearchSettings()`。`Search.engine(name?)` 返回配置中的引擎实例（默认为 `default`），例如自行调用 `deleteIndex()`。

## 多租户

配合[多租户](./tenancy)使用时：

- **单库 + `tenant_id` 列**（`static belongsToTenant = true`）：文档中自动包含租户列，在租户上下文中搜索时自动按它过滤；database 引擎直接使用模型的租户作用域。
- **每个租户独立数据库**：不同租户的主键会重复，因此索引名自动加上租户前缀（`acme_posts`）。导入时在 `Tenancy.run()` 中逐个租户执行 `search:import`。

## 测试

`Search.fake()` 把所有引擎替换为同一个内存引擎，同步也不再经过队列：

```ts
import { search, Search } from '@hazejs/search'

it('indexes published posts', async () => {
  const engine = Search.fake()
  await Post.create({ title: 'Hello', status: 'published' })
  expect(engine.documents('posts')).toHaveLength(1)
  expect((await search(Post, 'hello').get())[0]!.title).toBe('Hello')
  Search.restore()
})
```

内存引擎（`engines: { memory: {} }`）在开发中也很方便：每个词都要出现在某个 `searchable` 字段中（不区分大小写的子串匹配），按出现次数排序。

## 限制

- 同步与事务无关（见上文），查询构造器的批量更新不会同步。
- database 引擎只搜索一张表。需要跨关联搜索时，配合外部引擎的 `toSearchable()`，或使用 SQLite FTS5 的 `engine` 模式。
- MySQL 全文搜索遵循 InnoDB 的规则：短于 `innodb_ft_min_token_size`（3）的词与停用词会被忽略。
- 没有声明 `sortable` 时，Typesense 只能对数字字段排序，Elasticsearch 不能对 `text` 字段排序。
