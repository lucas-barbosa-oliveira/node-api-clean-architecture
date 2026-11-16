import { Entity } from '../../domain/model/entity.ts'

export interface IEntityMapper<M extends Entity, EM> {
  transform(item: any): any;
  modelToModelEntity(item: M): EM;
  jsonToModel(json: any): M;
}

export abstract class BaseMapper<M extends Entity, EM> implements IEntityMapper<M, EM> {
  public abstract modelToModelEntity(item: M): EM
  public abstract jsonToModel(json: any): M

  // Overloads: dão tipos corretos a quem chama; a interface continua com `any`.
  public transform(item: M): EM
  public transform(item: M[]): EM[]
  public transform(item: EM[]): M[]
  public transform(item: EM | null | undefined): M | null
  /**
   * Conversão bidirecional: model -> documento do banco e documento -> model.
   * Aceita também lista e null/undefined.
   */
  public transform(item: any): any {
      if (item == null) return null
      if (Array.isArray(item)) return item.map(i => this.transform(i))
      return item instanceof Entity ? this.modelToModelEntity(item as M) : this.jsonToModel(item)
  }
}
