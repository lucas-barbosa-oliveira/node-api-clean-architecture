import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { JOB_QUERY_SCHEMA } from '../../src/application/query/job.query.schema.ts';
import { and } from '../../src/application/query/list.query.ts';
import { USER_QUERY_SCHEMA } from '../../src/application/query/user.query.schema.ts';
import { ValidationError } from '../../src/domain/error/index.ts';
import { queryDocs } from '../../src/infrastructure/repository/in-memory/in.memory.query.ts';
import { parseListQuery } from '../../src/presentation/http/query/list.query.parser.ts';

const parse = (url: string, schema = JOB_QUERY_SCHEMA) => parseListQuery({ originalUrl: url } as Request, schema);
const issuesOf = (fn: () => unknown) => {
  try { fn(); } catch (err) {
    assert.ok(err instanceof ValidationError);
    return (err.issues as { path: string[] }[]).map(issue => issue.path[0]);
  }
  assert.fail('deveria lançar ValidationError');
};

test('sem parâmetros: filtro vazio, ordenação padrão e primeira página', () => {
  assert.deepEqual(parse('/jobs'), { filter: {}, sort: { createdAt: -1 }, fields: [], limit: 20, page: 1, skip: 0 });
});

test('filtros, OU por vírgula, ordenação, campos e página', () => {
  const query = parse('/jobs?status=pending,running&type=report.generate&sort=-finishedAt,status&fields=status,type&page=3&limit=10');
  assert.deepEqual(query.filter, { $or: [{ status: 'pending' }, { status: 'running' }], type: 'report.generate' });
  assert.deepEqual(query.sort, { finishedAt: -1, status: 1 });
  assert.deepEqual(query.fields, ['status', 'type']);
  assert.equal(query.limit, 10);
  assert.equal(query.skip, 20);
});

test('datas viram Date: operadores, start_at/end_at e period no campo de data do recurso', () => {
  const ops = parse('/jobs?createdAt=gte:2026-10-01&finishedAt=lt:2026-11-01T10:00:00');
  assert.deepEqual(ops.filter, {
    createdAt: { $gte: new Date('2026-10-01T00:00:00') },
    finishedAt: { $lt: new Date('2026-11-01T10:00:00') },
  });

  const range = parse('/jobs?start_at=2026-10-01&end_at=2026-11-01');
  assert.deepEqual(range.filter, {
    $and: [{ createdAt: { $lt: new Date('2026-11-01T00:00:00') } }, { createdAt: { $gte: new Date('2026-10-01T00:00:00') } }],
  });

  const period = parse('/jobs?period=7d').filter.$and as Record<string, { $lt?: Date; $gte?: Date }>[];
  assert.ok(period[0].createdAt.$lt instanceof Date && period[1].createdAt.$gte instanceof Date);
});

test('ids com cara de número continuam string; busca com * vira regex só em texto', () => {
  assert.deepEqual(parse('/jobs?clientId=123').filter, { clientId: '123' });
  const users = parse('/users?name=*ana*', USER_QUERY_SCHEMA);
  assert.equal((users.filter.name as { $options: string }).$options, 'i');
  assert.ok(new RegExp((users.filter.name as { $regex: string }).$regex, 'i').test('Juliana'));
  assert.ok(new RegExp((users.filter.name as { $regex: string }).$regex, 'i').test('ANÁ'));
  assert.deepEqual(issuesOf(() => parse('/jobs?clientId=*1*')), ['clientId']);
});

test('campos fora do schema são recusados (inclusive o hash da senha e operadores do Mongo)', () => {
  assert.deepEqual(issuesOf(() => parse('/users?passwordHash=*a*', USER_QUERY_SCHEMA)), ['passwordHash']);
  assert.deepEqual(issuesOf(() => parse('/users?$where=1', USER_QUERY_SCHEMA)), ['where']);
  assert.deepEqual(issuesOf(() => parse('/jobs?payload=x')), ['payload']);
  assert.deepEqual(issuesOf(() => parse('/jobs?sort=payload')), ['sort']);
  assert.deepEqual(issuesOf(() => parse('/users?fields=passwordHash', USER_QUERY_SCHEMA)), ['fields']);
});

test('valores são validados pelo tipo do campo', () => {
  assert.deepEqual(issuesOf(() => parse('/jobs?status=pronto')), ['status']);
  assert.deepEqual(issuesOf(() => parse('/jobs?createdAt=gte:ontem')), ['createdAt']);
  assert.deepEqual(issuesOf(() => parse('/jobs?status=gt:pending')), ['status']);
});

test('metacaracteres de regex são recusados antes de chegar à biblioteca (ReDoS)', () => {
  assert.deepEqual(issuesOf(() => parse('/users?name=*(a%2B)%2B*', USER_QUERY_SCHEMA)), ['name']);
  assert.deepEqual(issuesOf(() => parse('/users?name=a|b', USER_QUERY_SCHEMA)), ['name']);
});

test('paginação: limite máximo e valores inválidos caem no padrão', () => {
  assert.equal(parse('/jobs?limit=100000').limit, 100);
  assert.equal(parse('/jobs?limit=abc').limit, 20);
  assert.equal(parse('/jobs?page=0').page, 1);
});

test('and() combina filtros ignorando os vazios', () => {
  assert.deepEqual(and({}, {}), {});
  assert.deepEqual(and({ a: 1 }, {}), { a: 1 });
  assert.deepEqual(and({ a: 1 }, { b: 2 }), { $and: [{ a: 1 }, { b: 2 }] });
});

test('avaliador em memória: mesmos operadores do Mongo, ordenação e paginação', () => {
  const docs = [
    { _id: '1', name: 'Ana', age: 30, createdAt: new Date('2026-01-01') },
    { _id: '2', name: 'Bruno', age: 20, createdAt: new Date('2026-02-01') },
    { _id: '3', name: 'Juliana', age: 40, createdAt: new Date('2026-03-01') },
  ];
  const run = (filter: Record<string, unknown>, sort: Record<string, 1 | -1> = { createdAt: 1 }, skip = 0, limit = 10) =>
    queryDocs(docs, { filter, sort, fields: [], skip, limit, page: 1 });

  assert.deepEqual(run({ id: '2' }).items.map(d => d._id), ['2']);
  assert.deepEqual(run({ age: { $gte: 30 } }).items.map(d => d._id), ['1', '3']);
  assert.deepEqual(run({ createdAt: { $lt: new Date('2026-02-15') } }).items.map(d => d._id), ['1', '2']);
  assert.deepEqual(run({ $or: [{ name: 'Ana' }, { age: 40 }] }).items.map(d => d._id), ['1', '3']);
  assert.deepEqual(run({ name: { $regex: 'ana', $options: 'i' } }).items.map(d => d._id), ['1', '3']);
  assert.deepEqual(run({ name: { $ne: 'Ana' } }, { age: -1 }).items.map(d => d._id), ['3', '2']);
  const page = run({}, { name: 1 }, 1, 1);
  assert.deepEqual([page.items.map(d => d._id), page.total], [['2'], 3]);
});
