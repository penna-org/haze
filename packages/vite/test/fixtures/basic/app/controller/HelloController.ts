import { Config, definePersistent, inject } from '@hazejs/core'
import { GreetService } from '~/app/service/GreetService'

const visits = definePersistent('visits', () => ({ count: 0 }))

export class HelloController {
  private greeter = inject(GreetService)
  private config = inject(Config)

  index() {
    return {
      message: this.greeter.greet(),
    }
  }

  name() {
    return {
      name: this.config.get('app.name'),
    }
  }

  visits() {
    return { count: ++visits.count }
  }

  async slow() {
    await new Promise(resolve => setTimeout(resolve, 300))
    return {
      message: this.greeter.greet(),
    }
  }
}
