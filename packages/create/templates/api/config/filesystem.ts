import { defineFilesystemConfig, env } from '@think-h3/core'

/**
 * 文件存储：Storage.put('reports/a.csv', csv)、Storage.disk('public').putFile('avatars', file)、
 * 上传文件 `await file.store('avatars', 'public')`。
 * public 磁盘的文件经 /storage/<path> 访问；私有文件用 Storage.temporaryUrl(path, '10m') 生成签名链接。
 */
export default defineFilesystemConfig(() => ({
  default: env('FILESYSTEM_DISK', 'local'),
  disks: {
    local: { driver: 'local', root: 'storage/app' },
    public: {
      driver: 'local',
      root: 'storage/app/public',
      url: '/storage',
      serve: true,
    },
    // AWS S3 与 S3 兼容服务（R2 的 S3 接口、MinIO、RustFS 等），需要 pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
    s3: {
      driver: 's3',
      bucket: env('S3_BUCKET', ''),
      region: env('S3_REGION', 'us-east-1'),
      endpoint: env('S3_ENDPOINT', '') || undefined,
      accessKeyId: env('S3_ACCESS_KEY_ID', ''),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
      // 公共读的桶 / CDN 地址；私有桶用 temporaryUrl() 预签名
      url: env('S3_URL', '') || undefined,
    },
    // Cloudflare Workers：R2 绑定（wrangler.json 的 r2_buckets）
    // r2: { driver: 'r2', binding: 'BUCKET', url: 'https://files.example.com' },
  },
}))
