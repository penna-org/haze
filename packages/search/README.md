# @hazejs/search

Full-text search for hazejs models: the database engine (MySQL `FULLTEXT`, PostgreSQL `tsvector`, SQLite FTS5 or `LIKE`), Meilisearch, Typesense and Elasticsearch / OpenSearch, all over `fetch` with no SDK dependencies. Indexes stay in sync with model events (optionally through the queue), and searches return models in relevance order.

## Install

```bash
pnpm add @hazejs/search
```

## Usage

```ts
// app/provider/SearchProvider.ts
import { searchProvider } from '@hazejs/search'

export default searchProvider()
```

```ts
// app/model/Post.ts
import { Model } from '@hazejs/orm'
import { searchable } from '@hazejs/search'
import { posts } from '../../database/schema/posts'

export class Post extends Model.define(posts) {}

searchable(Post, {
  settings: {
    searchable: ['title', 'body'],
    filterable: ['status'],
    sortable: ['views']
  },
})
```

```ts
import { search } from '@hazejs/search'

const page = await search(Post, 'haze').where('status', 'published').paginate(1, 20)
```

```bash
haze search:sync-settings   # create indexes (FULLTEXT / GIN / FTS5 on the database engine)
haze search:import Post     # index existing records
```

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
