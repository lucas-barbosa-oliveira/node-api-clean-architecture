import mongoose, { type Model, type QueryFilter } from 'mongoose'
import { ConflictError, ValidationError } from '../../../domain/error/index.ts'
import type { Entity } from '../../../domain/model/entity.ts'
import type { IEntityMapper } from '../../mapper/entity.mapper.ts'

export type FindOptions = { sort?: Record<string, 1 | -1>; limit?: number; skip?: number }

/**
 * Operações genéricas para repositórios baseados em Mongo (Mongoose).
 * M = model de domínio, D = documento persistido (formato do schema).
 */
export abstract class BaseMongoRepository<M extends Entity, D extends { _id: string }> {
    protected readonly model: Model<D>
    protected readonly mapper: IEntityMapper<M, D>

    constructor(model: Model<D>, mapper: IEntityMapper<M, D>) {
        this.model = model
        this.mapper = mapper
    }

    // ---- API pública ----

    public create(entity: M): Promise<M> {
        return this.run(async () => {
            await this.model.create(this.mapper.transform(entity))
            return entity
        })
    }

    public findById(id: string): Promise<M | null> {
        return this.findOne({ _id: id } as QueryFilter<D>)
    }

    /** Substitui o documento. Retorna false se o id não existir. */
    public update(entity: M): Promise<boolean> {
        return this.run(async () => {
            const { _id, ...rest } = this.mapper.transform(entity) as D
            const res = await this.model.replaceOne({ _id } as QueryFilter<D>, rest)
            return res.matchedCount > 0
        })
    }

    /** Cria ou substitui (usado por save). */
    public upsert(entity: M): Promise<void> {
        return this.run(async () => {
            const { _id, ...rest } = this.mapper.transform(entity) as D
            await this.model.replaceOne({ _id } as QueryFilter<D>, rest, { upsert: true })
        })
    }

    public delete(id: string): Promise<boolean> {
        return this.run(async () => {
            const res = await this.model.deleteOne({ _id: id } as QueryFilter<D>)
            return res.deletedCount > 0
        })
    }

    // ---- consultas com filtro do Mongoose: protegidas para o Mongo não vazar para fora da infraestrutura ----

    protected findOne(filter: QueryFilter<D>): Promise<M | null> {
        return this.run(async () => this.mapper.transform(await this.model.findOne(filter).lean()) as M | null)
    }

    protected find(filter: QueryFilter<D> = {}, options: FindOptions = {}): Promise<M[]> {
        return this.run(async () => this.mapper.transform(await this.model.find(filter, null, options).lean()) as M[])
    }

    protected count(filter: QueryFilter<D> = {}): Promise<number> {
        return this.run(() => this.model.countDocuments(filter))
    }

    protected deleteMany(filter: QueryFilter<D>): Promise<number> {
        return this.run(async () => (await this.model.deleteMany(filter)).deletedCount)
    }

    // ---- tratamento de erros ----

    /** Traduz erros do Mongo/Mongoose em erros da aplicação. Subclasses podem sobrescrever. */
    protected mongoDBErrorListener(err: unknown): Error {
        const e = err as { code?: number; keyValue?: Record<string, unknown> } | null
        if (e?.code === 11000) {
            const fields = Object.keys(e.keyValue ?? {}).join(', ')
            return new ConflictError(fields ? `Valor duplicado em: ${fields}` : 'Registro duplicado')
        }
        if (err instanceof mongoose.Error.ValidationError) {
            return new ValidationError(
                'Documento inválido para persistência',
                Object.values(err.errors).map(item => item.message),
            )
        }
        if (err instanceof mongoose.Error.CastError) {
            return new ValidationError(`Valor inválido para "${err.path}"`)
        }
        return err instanceof Error ? err : new Error(String(err))
    }

    protected async run<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation()
        } catch (err) {
            throw this.mongoDBErrorListener(err)
        }
    }
}
