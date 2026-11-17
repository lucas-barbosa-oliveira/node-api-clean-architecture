/**
 * Mensagem trocada entre microsserviços pelo barramento.
 * O formato segue o padrão dos outros serviços: event_name + timestamp + dados do evento.
 */
export type IntegrationEvent = {
    /** Ex.: RequestAuditEvent, UserDeleteEvent. */
    event_name: string;
    /** ISO 8601. */
    timestamp: string;
    [field: string]: unknown;
}

/** Um assinante: em qual exchange e routing key escuta, e o que fazer com o evento. */
export type EventSubscription = {
    /** Nome usado nos logs e para despachar pelo event_name, ex.: UserDeleteEvent. */
    eventName: string;
    /** Exchange do tipo topic, ex.: users. */
    exchange: string;
    /** Aceita curingas de tópico: * (uma palavra) e # (zero ou mais), ex.: users.delete ou users.#. */
    routingKey: string;
    handle(event: IntegrationEvent): Promise<void>;
}

/** Recurso exposto por RPC: outro serviço chama executeResource(<este serviço>, name, ...params). */
export type RpcResource = {
    name: string;
    handle(...params: unknown[]): Promise<unknown>;
}

export type PublishOptions = {
    /** Id da mensagem (o outbox usa o id do registro: o consumidor descarta reentregas pelo messageId). */
    messageId?: string;
}

/** O barramento está fora do ar: quem publica deve tentar de novo depois (o outbox faz isso). */
export class EventBusUnavailableError extends Error {
    constructor(message = 'Barramento indisponível') {
        super(message)
        this.name = 'EventBusUnavailableError'
    }
}

/**
 * Barramento de mensagens entre microsserviços (publish/subscribe e RPC).
 * Assinaturas e recursos podem ser registrados antes de start(): são aplicados quando a conexão abrir.
 */
export interface IEventBus {
    readonly isConnected: boolean;
    /** Começa a conectar em segundo plano; não espera conseguir (a API sobe mesmo com o barramento fora do ar). */
    start(): void;
    /**
     * Publica em uma exchange do tipo topic e só resolve quando o broker confirmar o recebimento.
     * Com o barramento fora do ar, rejeita com EventBusUnavailableError. Os services não chamam direto:
     * gravam no outbox (IOutbox), e o relay publica com novas tentativas.
     */
    publish(exchange: string, routingKey: string, event: IntegrationEvent, options?: PublishOptions): Promise<void>;
    subscribe(subscription: EventSubscription): void;
    provideResource(resource: RpcResource): void;
    /** Chama um recurso RPC de outro serviço. Falha se o barramento estiver fora do ar ou o tempo esgotar. */
    executeResource(service: string, resource: string, ...params: unknown[]): Promise<unknown>;
    /** Estado de cada conexão, para o /health/ready (ex.: { publish: true, consume: false }). */
    status(): Record<string, boolean>;
    close(): Promise<void>;
}
