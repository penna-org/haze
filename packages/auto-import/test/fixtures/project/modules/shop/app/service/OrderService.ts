export class OrderService {
  total(): number {
    return 42
  }
}

/** 与 app/service/shared 中的重名：app/service 排在前面，保留那一个 */
export function formatName(name: string): string {
  return name
}
