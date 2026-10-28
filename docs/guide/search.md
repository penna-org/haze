# Full-Text Search

`@hazejs/search` adds full-text search to [models](./models). You mark a model as searchable, and the package keeps its search index in sync. You then query it with a small builder that returns models in relevance order. Several engines share the same API:

| Engine | Where the index lives | Needs |
| --- | --- | --- |
| `database` | Your SQL database: MySQL `FULLTEXT`, PostgreSQL `tsvector`, SQLite FTS5, or `LIKE` | A full-text index (one command creates it) |
| `meilisearch` | [Meilisearch](https://www.meilisearch.com) | A Meilisearch server |
| `typesense` | [Typesense](https://typesense.org) | A Typesense server |
| `elasticsearch` / `opensearch` | Elasticsearch 8 / 9 or OpenSearch 2 / 3 | A cluster |
| `memory` | The current process | Nothing (tests, prototypes) |

The external engines talk to the servers' HTTP APIs with `fetch`. They have no SDK dependencies, so they also run on the edge.

```bash
pnpm add @hazejs/search
```

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Setup

Register the provider:

```ts
// app/provider/SearchProvider.ts
import { searchProvider } from '@hazejs/search'

export default searchProvider()
```

Then declare the engines in `config/search.ts`. Without the file, the `database` engine is used.

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
    // OpenSearch uses the same options: { driver: 'opensearch', url, auth }
  },
  // Prepended to every index name (share one server between environments)
  prefix: env('SEARCH_PREFIX', ''),
  // Sync through the queue instead of during the request
  queue: false,
}))
```

| Option | Description |
| --- | --- |
| `default` | Engine used by models that don't pick one. Default `database` |
| `engines` | Named engines. `driver` defaults to the key, so `meilisearch: {...}` is a Meilisearch engine |
| `prefix` | Prefix added to every index name |
| `queue` | `true` or `{ connection, queue }` to sync indexes through the [queue](./queues). Default `false` |
| `chunk` | Batch size of `search:import`. Default `500` |

Engine options:

| Engine | Options |
| --- | --- |
| `database` | `mode` (`fulltext` or `like`), `language` (PostgreSQL text search configuration, default `english`), `mysqlMode` (`natural` or `boolean`) |
| `meilisearch` | `url`, `key`, `wait` (wait for write tasks to finish, default `false`), `waitTimeout` |
| `typesense` | `url`, `key` |
| `elasticsearch` / `opensearch` | `url`, `auth` (`{ username, password }` or `{ apiKey }`), `refresh` (`true` / `'wait_for'` after writes), `keywordSuffix` (default `.keyword`) |
| `custom` | `{ driver: 'custom', engine }`, where `engine` implements `SearchEngine` |

Every engine also accepts `fetch`, a custom fetch function for proxies or tests.

## Making a model searchable

Call `searchable()` next to the model:

```ts
// app/model/Post.ts
import { Model } from '@hazejs/orm'
import { searchable } from '@hazejs/search'
import { posts } from '../../database/schema/posts'

export class Post extends Model.define(posts) {
  static override softDelete = true
}

searchable(Post, {
  index: 'posts', // default: the table name
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

| Option | Description |
| --- | --- |
| `index` | Index name. Defaults to the table name. The configured `prefix` is added in front |
| `engine` | Engine name from `config/search.ts`. Defaults to `default` |
| `toSearchable` | Document written to the index. Defaults to `model.toJSON()`, so `hidden` fields stay out. It may be async (load relations here). The primary key is added for you |
| `shouldBeSearchable` | Return `false` to keep a model out of the index. A model that stops qualifying is removed |
| `settings` | `searchable`, `filterable`, `sortable`, plus engine-specific `meilisearch`, `typesense` and `elasticsearch` settings. Applied by `search:sync-settings` |
| `queue` | Override the config's `queue` for this model |
| `importQuery` | Adjust the query used by `search:import`, for example `q => q.with('author')` |
| `database` | Options for the database engine (see below) |

The index is updated after model events:

- **create / update** (`save()`, `create()`, `update()`): the document is written, or removed when `shouldBeSearchable` returns `false`;
- **delete**: the document is removed. A soft-deleted model is removed too, and `restore()` writes it back;
- **force delete**: the document is removed.

Mass updates and deletes through the query builder (`Post.where(...).update()`) don't fire model events, so they don't touch the index. Run `search:import` afterwards.

To change models without syncing, for example in a seeder, wrap the work in `withoutSyncing`:

```ts
import { withoutSyncing } from '@hazejs/search'

await withoutSyncing(async () => {
  for (const row of rows)
    await Post.create(row)
})
```

::: warning Transactions
Syncing happens right after the write, even inside a transaction. If the transaction rolls back, the index still contains the document. Write inside a transaction with `withoutSyncing` and import afterwards, or enable `queue` so the job runs later.
:::

## Searching

```ts
import { search } from '@hazejs/search'

// Models in relevance order
const posts = await search(Post, 'haze framework').get()

// Filters, sorting, pagination
const page = await search(Post, 'haze')
  .where('status', 'published')
  .whereIn('category', ['news', 'blog'])
  .whereNotIn('id', [1, 2])
  .orderBy('views', 'desc')
  .paginate(1, 20)
// { data: Post[], total, page, perPage, lastPage }: the same shape as the ORM's paginate()
```

`searchable()` returns the same class, typed with a `search` method, so you can also write `Post.search('haze')` on the value it returns:

```ts
export const SearchablePost = searchable(Post, { /* ... */ })
await SearchablePost.search('haze').get()
```

| Method | Description |
| --- | --- |
| `where(field, value)` / `whereIn` / `whereNotIn` | Exact filters. External engines need the field in `settings.filterable` |
| `orderBy(field, direction?)` | Sort instead of relevance. External engines need the field in `settings.sortable` |
| `take(n)` | Limit for `get()` / `keys()` / `raw()`. Default 1000 |
| `options({...})` | Engine-native options, merged into the request (see below) |
| `constrain(q => ...)` | Constrain the ORM query that loads the models (eager loading, extra conditions). With the database engine it applies to the search query itself |
| `within(index)` | Search another index of the same model |
| `get()` / `first()` | Models in relevance order |
| `paginate(page, perPage)` | Page of models plus `total` from the engine |
| `keys()` | Primary keys only (no database query) |
| `count()` | Number of matches |
| `raw()` | The engine's raw response |

Models are loaded from the database by primary key after the engine answers, and they keep the engine's order. Hits whose rows no longer exist (or are soft-deleted) are skipped, so `data` can be shorter than `perPage`.

Engine options passed through `options()`:

- **Meilisearch**: any [search parameter](https://www.meilisearch.com/docs/reference/api/search), such as `attributesToHighlight`, `matchingStrategy` or `showRankingScoreDetails`;
- **Typesense**: any search parameter, such as `num_typos`, `prefix` or `query_by_weights`;
- **Elasticsearch / OpenSearch**: top-level `_search` body fields, such as `highlight` or `min_score`;
- **database**: `mode` (`fulltext` / `like`), `mysqlMode` (`natural` / `boolean`), and `raw: true` to pass SQLite FTS5 query syntax unchanged.

## The database engine

The database engine searches the model's own table, so no separate server is needed. The results come straight from the ORM query, so soft deletes, global scopes and [tenant scopes](./tenancy) apply automatically.

| Dialect | Query | Index |
| --- | --- | --- |
| MySQL | `MATCH (cols) AGAINST (? IN NATURAL LANGUAGE MODE)` (or `BOOLEAN MODE`), ordered by relevance | `FULLTEXT` index on the columns |
| PostgreSQL / PGlite | `to_tsvector(lang, cols) @@ websearch_to_tsquery(lang, ?)`, ordered by `ts_rank` | GIN index on the same expression, or a generated `tsvector` column |
| SQLite / libsql / Turso / D1 | FTS5 `MATCH`, ordered by `bm25()` | FTS5 virtual table |
| Any | `mode: 'like'`: every word must appear in one of the columns (`ILIKE` on PostgreSQL) | None |

Options go under `database` in `searchable()`:

```ts
searchable(Post, {
  settings: { searchable: ['title', 'body'] },
  database: {
    columns: ['title', 'body'], // default: settings.searchable, otherwise all string columns
    mode: 'fulltext', // or 'like'
    language: 'english', // PostgreSQL
    vectorColumn: 'searchVector', // PostgreSQL: use an existing tsvector column
    mysqlMode: 'natural', // or 'boolean'
    indexName: 'posts_search',
    fts: { table: 'posts_fts', sync: 'triggers', tokenize: 'unicode61' }, // SQLite
  },
})
```

### Creating the index

`haze search:sync-settings` creates the full-text index if it is missing. It is safe to run more than once. For a migration, print the statements and paste them into a custom migration (`drizzle-kit generate --custom`):

```ts
import { dropSearchIndexSql, searchIndexSql } from '@hazejs/search'

searchIndexSql(Post) // up
dropSearchIndexSql(Post) // down
// or create it in code: await createSearchIndex(Post)
```

What gets created:

- **MySQL**: `alter table posts add fulltext index posts_search (title, body)`. MySQL only matches a `MATCH` whose columns are exactly the columns of a `FULLTEXT` index.
- **PostgreSQL**: `create index posts_search on posts using gin (to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(body, '')))`. The query uses the same expression, so the index is used. To store the vector instead, add a generated column and set `vectorColumn`:

  ```sql
  alter table posts add column search_vector tsvector
    generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) stored;
  ```

- **SQLite FTS5** has two sync modes:
  - `triggers` (default): an external-content table (`content='posts'`). Three triggers keep it up to date on insert, update and delete, and a `rebuild` fills it from existing rows. Only real columns can be indexed.
  - `engine`: a standalone FTS5 table that the search package writes from `toSearchable()` on model events. It can index computed fields, for example an author name. Rows changed outside model events need `search:import`.

  For languages without spaces between words, such as Chinese or Japanese, use `fts: { tokenize: 'trigram' }` for substring matching.

Search terms are quoted for FTS5, and the last term is a prefix match. Characters such as `"`, `*` or `-` in user input never cause syntax errors. Use `options({ raw: true })` to pass FTS5 syntax unchanged.

## External engines

### Meilisearch

Writes are asynchronous tasks in Meilisearch: a document becomes searchable shortly after the call returns. Set `wait: true` to wait for each task, which is useful in tests. `search:import`, `search:flush` and `search:sync-settings` always wait. `search:sync-settings` creates the index with the model's primary key, then applies `searchableAttributes`, `filterableAttributes`, `sortableAttributes` and anything under `settings.meilisearch`.

Filters must be listed in `filterable` and sort fields in `sortable` before you use them; otherwise Meilisearch returns an error.

### Typesense

The collection is created on the first write, or by `search:sync-settings`. The default schema is `{ name: '.*', type: 'auto' }`, so field types are detected from the first document. Numeric fields can be sorted. Declare string fields you want to sort with `settings.typesense.fields`:

```ts
settings: {
  searchable: ['title', 'body'], // becomes query_by
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

Document ids are the primary key as a string, and they are converted back to numbers when the models load. Typesense returns at most 250 hits per page; `get()` fetches several pages when needed. `search:flush` drops the collection, and the next write recreates it. To change the schema, flush and sync the settings again.

### Elasticsearch and OpenSearch

Documents are written with the `_bulk` API, using the primary key as `_id`. Queries are a `bool` query: `multi_match` on `settings.searchable` (all words must match) and `term` / `terms` filters. Dynamic mapping turns strings into `text` with a `.keyword` sub-field, so string filters use `field.keyword`. If your own mappings make a field a `keyword` directly, set `keywordSuffix: ''`. Sort on numbers, dates or `title.keyword`, not on `text` fields.

`search:sync-settings` creates the index with `settings.elasticsearch.mappings` / `settings` if it does not exist, or adds new mappings to an existing index. Writes are near real-time. Set `refresh: true` (tests) or `'wait_for'` to make them visible immediately.

## Queued syncing

With `queue: true` (in the config or per model), model events dispatch the built-in job `search:sync` instead of calling the engine during the request. The document is computed when the job is dispatched, so the worker doesn't need to load the model. Run a worker as usual (`haze queue:work`). The worker must register `searchProvider()`. The job retries 3 times (after 5 s, then 30 s).

The database engine always syncs immediately: its index lives in the same database.

## Commands

| Command | Description |
| --- | --- |
| `haze search:import Post` | Write every record to the index (skips soft-deleted ones and those `shouldBeSearchable` rejects). For the database engine, rebuilds the FTS5 table or does nothing (MySQL / PostgreSQL indexes are always current) |
| `haze search:flush Post` | Remove every document from the model's index |
| `haze search:sync-settings [Post]` | Create indexes and apply settings; without a model, every searchable model |

The model name is the class name or the index name. The commands load the files in `app/model` (and `app/<app>/model`), so `searchable()` must be called in the model's file. The same operations are available in code: `importSearchable(Post)`, `flushSearchable(Post)` and `syncSearchSettings()`.

## Multi-tenancy

With [tenancy](./tenancy):

- **Single database with a `tenant_id` column** (`static belongsToTenant = true`): documents include the tenant column, and inside a tenant context searches filter on it automatically. The database engine uses the model's tenant scope.
- **Database per tenant**: primary keys repeat across tenants, so the index name gets the tenant prefix (`acme_posts`). Run `search:import` for each tenant inside `Tenancy.run()`.

## Testing

`Search.fake()` replaces every engine with one in-memory engine and syncs without the queue:

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

The memory engine (`engines: { memory: {} }`) is also handy in development. Every word must appear in one of the `searchable` fields (case-insensitive substring match), and documents are ranked by how often the words occur.

## Limitations

- Syncing is not tied to transactions (see above), and query-builder mass updates are not synced.
- The database engine searches one table. To search across relations, use `toSearchable()` with an external engine, or SQLite FTS5 in `engine` mode.
- MySQL full-text search follows InnoDB's rules: words shorter than `innodb_ft_min_token_size` (3) and stopwords are ignored.
- Without `sortable`, Typesense can only sort numeric fields, and Elasticsearch can't sort `text` fields.
