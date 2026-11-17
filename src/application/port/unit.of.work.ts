/**
 * Agrupa gravações em uma transação: dentro de run(), tudo é gravado junto ou nada é
 * (ex.: o usuário e o evento UserCreatedEvent no outbox).
 */
export interface IUnitOfWork {
    run<T>(work: () => Promise<T>): Promise<T>;
}

/** Sem transação (repositórios em memória, ou MongoDB sem replica set). */
export const noTransaction: IUnitOfWork = { run: work => work() }
