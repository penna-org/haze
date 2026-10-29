import type { MaintenanceState } from './config'
import { defineEvent } from '../events/event'

/** 进入维护模式（haze down / Maintenance.down()），在执行命令的进程中触发 */
export const MaintenanceModeEnabled = defineEvent<{ state: MaintenanceState }>({ name: 'maintenance:enabled' })

/** 退出维护模式（haze up / Maintenance.up()），在执行命令的进程中触发 */
export const MaintenanceModeDisabled = defineEvent<{ time: number }>({ name: 'maintenance:disabled' })
