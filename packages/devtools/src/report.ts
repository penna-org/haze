import type { DevtoolsSource } from './hub'
import { resolve } from 'node:path'
import process from 'node:process'
import { buildHub } from '@devframes/hub/build'
import { jsonRenderUiRenderer } from '@devframes/json-render-ui/hub'
import { createHazeFrame } from './frame'
import { createHazeUi, normalizeBase } from './hub'
import { FRAME_DOCK, registerPanels } from './panels'

export interface ReportOptions {
  /** 已启动的应用（只读取结构，不需要监听端口） */
  source: DevtoolsSource
  /** 输出目录 */
  outDir: string
  /** 部署时的路径前缀，默认 `/` */
  base?: string
  /** 项目根目录，默认 `process.cwd()` */
  root?: string
}

/**
 * 静态报告：把应用结构（概览、模块联动图、路由、容器与事件）烘焙成可直接部署的静态站点，
 * 例如在 CI 中生成后作为制品存档、在评审中分享。不含运行时记录（请求、AI 调用等）。
 */
export async function buildReport(options: ReportOptions): Promise<string> {
  const outDir = resolve(options.root ?? process.cwd(), options.outDir)
  const base = normalizeBase(options.base ?? '/')
  await buildHub({
    name: 'hazejs-report',
    base,
    outDir,
    cwd: options.root,
    devframes: [
      {
        devframe: createHazeFrame({ source: options.source }),
        dock: FRAME_DOCK,
      },
    ],
    renderers: [
      jsonRenderUiRenderer(),
    ],
    ui: createHazeUi(),
    configure: ctx => registerPanels(ctx, { source: options.source, live: false }),
  })
  return outDir
}
