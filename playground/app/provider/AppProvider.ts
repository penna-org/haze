export default defineProvider({
  register(container) {
    container.singleton(UserRepository)
  },

  boot(app) {
    const users = app.make(UserRepository)
    users.create({ name: 'Admin', email: 'admin@example.com' })
    app.make(Logger).debug(`seeded ${users.all().length} user(s)`)
  },
})
