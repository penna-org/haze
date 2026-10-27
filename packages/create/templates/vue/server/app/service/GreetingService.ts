/** 业务层：规则与流程，不感知 HTTP */
export class GreetingService {
  greet(name: string): string {
    return `Hello, ${name}!`
  }
}
