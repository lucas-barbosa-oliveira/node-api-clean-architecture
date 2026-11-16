import type { Express } from 'express';
import request from 'supertest';
import { waitUntil } from './wait.until.ts';

/** Consulta GET /jobs/:id até o job terminar (succeeded ou failed). */
export async function waitForJob(app: Express, id: string, timeoutMs = 5000) {
  return waitUntil(
    async () => (await request(app).get(`/jobs/${id}`)).body,
    job => job.status === 'succeeded' || job.status === 'failed',
    timeoutMs,
  );
}
