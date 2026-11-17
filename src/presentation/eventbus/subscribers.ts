import type { EventSubscription } from '../../application/port/event.bus.ts'

/**
 * Eventos de outros microsserviços que este serviço consome (o equivalente às rotas HTTP, para mensagens).
 * Cada subscriber chama um serviço da aplicação; a lista é registrada na inicialização e aparece nos logs.
 *
 * Exemplo:
 *   {
 *       eventName: 'UserDeleteEvent',
 *       exchange: 'users',
 *       routingKey: 'users.delete',
 *       handle: async event => { await deps.authService.revokeUserSessions(String((event.user as { id: string }).id)) },
 *   }
 */
export function subscribers(): EventSubscription[] {
    return []
}
