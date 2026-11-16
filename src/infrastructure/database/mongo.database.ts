import mongoose from 'mongoose'
import { jobSchema, userSchema, type IJobModel, type IUserModel } from './schema/index.ts'

/** Abre uma conexão própria (sem estado global) e compila os models a partir dos schemas. */
export async function connectMongo(uri: string, dbName: string) {
    const connection = await mongoose
        .createConnection(uri, { dbName, ignoreUndefined: true })
        .asPromise()

    const models = {
        User: connection.model<IUserModel>('User', userSchema),
        Job: connection.model<IJobModel>('Job', jobSchema),
    }

    // O Mongoose já chama init() ao criar o model; aguardar garante os índices antes de atender requisições.
    await Promise.all(Object.values(models).map(model => model.init()))

    return { models, close: () => connection.close() }
}
