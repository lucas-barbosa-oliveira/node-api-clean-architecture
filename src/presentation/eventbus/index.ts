import type { IEventBus } from '../../application/port/event.bus.ts'
import type { JobService } from '../../application/service/job.service.ts'
import type { UserService } from '../../application/service/user.service.ts'
import { rpcResources } from './rpc.resources.ts'
import { subscribers } from './subscribers.ts'

/** Registra subscribers e recursos RPC no barramento (aplicados quando a conexão abrir). */
export function registerEventBus(bus: IEventBus, deps: { userService: UserService; jobService: JobService }): void {
    for (const subscription of subscribers()) bus.subscribe(subscription)
    for (const resource of rpcResources(deps)) bus.provideResource(resource)
}
