import type { IntegrationEvent } from './event.bus.ts'

/** Um evento a publicar: para onde vai e o conteúdo. */
export type OutboxMessage = {
    exchange: string;
    routingKey: string;
    event: IntegrationEvent;
}

/**
 * Outbox transacional: em vez de publicar direto no barramento, o service grava o evento no mesmo banco (e, dentro de
 * IUnitOfWork.run, na mesma transação) que o dado que mudou. Um relay publica depois, com novas tentativas.
 * Resultado: o evento só existe se a mudança foi gravada, e não se perde se o barramento estiver fora do ar.
 * Entrega "pelo menos uma vez": o consumidor descarta repetidos pelo messageId.
 */
export interface IOutbox {
    add(...messages: OutboxMessage[]): Promise<void>;
}
