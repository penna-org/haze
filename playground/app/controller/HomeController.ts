import { Config, inject, Router } from '@think-h3/core'

export class HomeController {
  private config = inject(Config)
  private router = inject(Router)

  index() {
    return {
      name: this.config.get('app.name'),
      routes: this.router.list().map(route => `${route.method} ${route.path}`),
    }
  }
}
