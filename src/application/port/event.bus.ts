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

/**
 * Barramento de mensagens entre microsserviços (publish/subscribe e RPC).
 * Assinaturas e recursos podem ser registrados antes de start(): são aplicados quando a conexão abrir.
 */
export interface IEventBus {
    readonly isConnected: boolean;
    /** Começa a conectar em segundo plano; não espera conseguir (a API sobe mesmo com o barramento fora do ar). */
    start(): void;
    /**
     * Publica em uma exchange do tipo topic. Se o barramento estiver fora do ar, o evento fica em um buffer
     * (limitado) e é enviado quando a conexão voltar.
     */
    publish(exchange: string, routingKey: string, event: IntegrationEvent): Promise<void>;
    subscribe(subscription: EventSubscription): void;
    provideResource(resource: RpcResource): void;
    /** Chama um recurso RPC de outro serviço. Falha se o barramento estiver fora do ar ou o tempo esgotar. */
    executeResource(service: string, resource: string, ...params: unknown[]): Promise<unknown>;
    /** Tenta enviar o que estiver no buffer e fecha as conexões. */
    close(): Promise<void>;
}
