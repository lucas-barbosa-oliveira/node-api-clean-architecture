import { Redis } from 'ioredis'

/** Cria e fecha as conexões Redis usadas pelo BullMQ (uma para filas, outra para workers). */
export class RedisConnections {
    #url: string
    #all: Redis[] = []

    constructor(url: string) {
        this.#url = url
    }

    /** Falha rápido se o Redis cair, para não segurar a requisição HTTP. */
    public forQueue(): Redis {
        return this.#track(new Redis(this.#url))
    }

    /** O Worker do BullMQ exige maxRetriesPerRequest: null. */
    public forWorker(): Redis {
        return this.#track(new Redis(this.#url, { maxRetriesPerRequest: null }))
    }

    public async close(): Promise<void> {
        await Promise.allSettled(this.#all.map(connection => connection.quit()))
    }

    #track(connection: Redis): Redis {
        connection.on('error', err => console.error('[redis]', err.message))
        this.#all.push(connection)
        return connection
    }
}
