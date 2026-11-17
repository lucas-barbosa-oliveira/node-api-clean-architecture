export const PASSAGE_DIRECTIONS = ['in', 'out', 'unknown'] as const
export type PassageDirection = (typeof PASSAGE_DIRECTIONS)[number]

/** Evento como a ESP32 envia: uma pessoa cruzou a passagem. */
export type PassageEvent = {
    /** UUID gerado no dispositivo: reenviar o mesmo evento não conta duas vezes. */
    eventId: string;
    occurredAt: Date;
    direction: PassageDirection;
    /** Contador crescente do dispositivo (mostra eventos perdidos). */
    sequence?: number;
}

/** Ponto da série temporal: o evento mais quem enviou e quando chegou. */
export type Passage = PassageEvent & {
    deviceId: string;
    clientId: string;
    receivedAt: Date;
}

/** Saúde do dispositivo enviada junto com o lote. */
export type DeviceStatusSample = {
    deviceId: string;
    clientId: string;
    receivedAt: Date;
    firmware?: string;
    uptimeSeconds?: number;
    rssi?: number;
}

/** Contagem de passagens por janela de tempo. */
export type PassageWindow = { start: Date; in: number; out: number; unknown: number }
