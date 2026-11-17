import type { DeviceStatusSample, Passage, PassageWindow } from '../../domain/model/passage.ts'
import type { Filter, ListQuery, Page } from '../query/list.query.ts'
import type { TimeWindow } from '../query/time.window.ts'

/**
 * Armazenamento de séries temporais das passagens (InfluxDB em produção, memória em desenvolvimento/testes).
 * Gravar o mesmo evento duas vezes (mesmo dispositivo, sentido e instante) sobrescreve: a gravação é idempotente.
 */
export interface IPassageStore {
  write(passages: Passage[], status?: DeviceStatusSample): Promise<void>;
  /** Filtro, ordenação e paginação já validados (ver PASSAGE_QUERY_SCHEMA). */
  list(query: ListQuery): Promise<Page<Passage>>;
  /** Contagem por sentido em janelas de tempo. O filtro precisa ter limite inferior em occurredAt. */
  summarize(filter: Filter, window: TimeWindow): Promise<PassageWindow[]>;
  close(): Promise<void>;
}
