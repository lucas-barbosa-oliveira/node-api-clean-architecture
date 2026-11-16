import { Entity, type EntityProps } from './entity.ts'

export const USER_ROLES = ['admin', 'manager', 'client'] as const
export type UserRole = (typeof USER_ROLES)[number]

export type UserProps = EntityProps & { name: string; email: string; role: UserRole; passwordHash: string }

export class User extends Entity {
    public readonly name: string
    public readonly email: string
    public readonly role: UserRole
    public readonly passwordHash: string

    constructor(props: UserProps) {
        super(props)
        this.name = props.name
        this.email = props.email
        this.role = props.role
        this.passwordHash = props.passwordHash
    }

    public static create(data: { name: string; email: string; role: UserRole; passwordHash: string }): User {
        return new User(data)
    }

    /** Usado pelo JSON.stringify (respostas HTTP): o hash da senha nunca sai da aplicação. */
    public toJSON(): Omit<UserProps, 'passwordHash'> {
        const { passwordHash: _omit, ...rest } = this
        return rest
    }
}
