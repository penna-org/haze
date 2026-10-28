# @hazejs/orm

Models, query builder, migrations and seeders for hazejs on top of [drizzle](https://orm.drizzle.team) — MySQL, PostgreSQL, SQLite, Turso, Cloudflare D1 — plus a MongoDB adapter (`@hazejs/orm/mongo`).

## Install

```bash
pnpm add @hazejs/orm
```

## Usage

```ts
// app/model/Post.ts — columns and types come from database/schema/posts.ts
export class Post extends Model.define(posts) {
  static override softDelete = true
  static override hidden = ['secret']
}

const page = await Post.where('published', true).paginate(1, 20)
const post = await Post.findOrFail(id)
```

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
