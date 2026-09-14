import type { HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { HttpHeaders, HttpParams } from '@angular/common/http';
import { environment } from '../environments/environment';
import type { Todo } from './home/model/todo.model';
import { getUserId } from './home/user-id';

const API_PREFIX = '/api/';

/**
 * `single: true` adds PostgREST's "return exactly one JSON object, not an
 * array" header — required for `create()`/`patch()`/`find()`, whose response
 * adapter expects a bare item, not a one-element array. PostgREST otherwise
 * always wraps affected/matched rows in an array, even for a single row.
 */
function supabaseHeaders(existing: HttpHeaders, { single = false } = {}): HttpHeaders {
  let headers = existing
    .set('apikey', environment.supabaseAnonKey)
    .set('Authorization', `Bearer ${environment.supabaseAnonKey}`)
    .set('Content-Type', 'application/json')
    .set('Prefer', 'return=representation');
  if (single) headers = headers.set('Accept', 'application/vnd.pgrst.object+json');
  return headers;
}

/** `field=eq.value` for every one of `fields` present (as a bare equality param) on `params`. */
function mapEquality(params: HttpParams, out: HttpParams, fields: readonly string[]): HttpParams {
  for (const field of fields) {
    const value = params.get(field);
    if (value !== null) out = out.set(field, `eq.${value}`);
  }
  return out;
}

function rewriteTodosGet(req: HttpRequest<unknown>): HttpParams {
  let params = new HttpParams()
    .set('select', 'id,title,done,createdAt')
    .set('user_id', `eq.${getUserId()}`);

  const done = req.params.get('done');
  if (done !== null) params = params.set('done', `eq.${done}`);

  const titleLike = req.params.get('title[like]');
  if (titleLike) params = params.set('title', `ilike.*${titleLike}*`);

  const between = req.params.get('createdAt[between]');
  if (between) {
    const [start, end] = between.split(',');
    params = params.append('createdAt', `gte.${start}`).append('createdAt', `lte.${end}`);
  }

  const sort = req.params.get('sort');
  if (sort === '-createdAt') params = params.set('order', 'createdAt.desc');
  else if (sort === 'createdAt') params = params.set('order', 'createdAt.asc');

  return params;
}

const LINK_REQUEST_FIELDS = ['id', 'requesterId', 'targetUserId', 'status'] as const;

/**
 * Rewrites every `/api/todos` and `/api/link_requests` call into the
 * equivalent Supabase PostgREST request — table columns are named to match
 * the TS models exactly (`createdAt`, `requesterId`, ...), so no snake_case
 * translation is needed; see the SQL in README.md. Because this calls
 * `next()` with the rewritten request instead of short-circuiting, the real
 * HTTP call goes out and shows up in DevTools' Network tab like any other
 * request — and `HttpTestingController` can intercept it in tests exactly
 * as it would a hand-written `HttpClient` call.
 */
export const supabaseInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(API_PREFIX)) return next(req);

  if (req.url.startsWith(`${API_PREFIX}todos`)) {
    const id = req.url.split(`${API_PREFIX}todos/`)[1];

    if (req.method === 'GET') {
      const params = id
        ? new HttpParams()
            .set('select', 'id,title,done,createdAt')
            .set('id', `eq.${id}`)
            .set('user_id', `eq.${getUserId()}`)
        : rewriteTodosGet(req);
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/todos`,
          params,
          headers: supabaseHeaders(req.headers, { single: !!id }),
        }),
      );
    }

    if (req.method === 'POST') {
      const payload = req.body as Partial<Todo> | null;
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/todos`,
          body: { title: payload?.title ?? '', done: payload?.done ?? false, user_id: getUserId() },
          headers: supabaseHeaders(req.headers, { single: true }),
        }),
      );
    }

    if ((req.method === 'PATCH' || req.method === 'DELETE') && id) {
      const params = new HttpParams().set('id', `eq.${id}`).set('user_id', `eq.${getUserId()}`);
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/todos`,
          params,
          headers: supabaseHeaders(req.headers, { single: req.method === 'PATCH' }),
        }),
      );
    }
  }

  if (req.url.startsWith(`${API_PREFIX}link_requests`)) {
    const id = req.url.split(`${API_PREFIX}link_requests/`)[1];

    if (req.method === 'GET') {
      const params = id
        ? new HttpParams().set('id', `eq.${id}`)
        : mapEquality(req.params, new HttpParams(), LINK_REQUEST_FIELDS).set(
            'order',
            'createdAt.desc',
          );
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/link_requests`,
          params,
          headers: supabaseHeaders(req.headers, { single: !!id }),
        }),
      );
    }

    if (req.method === 'POST') {
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/link_requests`,
          headers: supabaseHeaders(req.headers, { single: true }),
        }),
      );
    }

    if ((req.method === 'PATCH' || req.method === 'DELETE') && id) {
      const params = new HttpParams().set('id', `eq.${id}`);
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/link_requests`,
          params,
          headers: supabaseHeaders(req.headers, { single: req.method === 'PATCH' }),
        }),
      );
    }
  }

  return next(req);
};
