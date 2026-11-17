import type { Connection } from 'mongoose'
import type { IUnitOfWork } from '../../application/port/unit.of.work.ts'

/**
 * Transação do MongoDB. Com transactionAsyncLocalStorage, todas as operações dentro de work() usam a sessão da
 * transação sem que os repositórios saibam disso. Em conflito transitório (TransientTransactionError), o Mongoose
 * repete o callback inteiro: work() precisa poder rodar de novo.
 */
export class MongoUnitOfWork implements IUnitOfWork {
    #connection: Connection

    constructor(connection: Connection) {
        this.#connection = connection
    }

    public async run<T>(work: () => Promise<T>): Promise<T> {
        let result!: T
        await this.#connection.transaction(async () => {
            result = await work()
        })
        return result
    }
}
