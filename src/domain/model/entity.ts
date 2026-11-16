export type EntityProps = { id?: string; createdAt?: Date; updatedAt?: Date }

/** Base de todos os models: campos comuns id, createdAt e updatedAt. */
export abstract class Entity {
    public readonly id: string
    public readonly createdAt: Date
    public updatedAt: Date

    constructor(props: EntityProps = {}) {
        const now = new Date()
        this.id = props.id ?? crypto.randomUUID()
        this.createdAt = props.createdAt ?? now
        this.updatedAt = props.updatedAt ?? now
    }

    /** Toda mutação do model deve passar por um método que chama touch(). */
    protected touch(): void {
        this.updatedAt = new Date()
    }
}
