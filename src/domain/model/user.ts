import { Entity, type EntityProps } from './entity.ts'

export type UserProps = EntityProps & { name: string; email: string }

export class User extends Entity {
    public readonly name: string
    public readonly email: string

    constructor(props: UserProps) {
        super(props)
        this.name = props.name
        this.email = props.email
    }

    public static create(data: { name: string; email: string }): User {
        return new User(data)
    }
}
