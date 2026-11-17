import type { ILogger } from '../../application/port/logger.ts'
import type { AuthService } from '../../application/service/auth.service.ts'
import type { BackgroundTask } from '../task.ts'

/** Remove sessões expiradas ou revogadas há mais de 7 dias (mantidas um tempo para auditoria). Todo dia às 03:30. */
export function purgeEndedSessionsTask(authService: AuthService, log: ILogger): BackgroundTask {
    return {
        name: 'purge-ended-sessions',
        schedule: '30 3 * * *',
        run: async () => {
            const removed = await authService.purgeSessionsEndedBefore(new Date(Date.now() - 7 * 86_400_000))
            log.info(`${removed} sessão(ões) removida(s)`)
        },
    }
}
