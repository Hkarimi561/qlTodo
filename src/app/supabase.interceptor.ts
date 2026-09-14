import type { HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { HttpHeaders, HttpParams, HttpResponse } from '@angular/common/http';
import { map } from 'rxjs';
import { environment } from '../environments/environment';
import type { Todo } from './home/model/todo.model';
import { getUserId } from './home/user-id';

const API_PREFIX = '/api/';

/**
 * `single: true` adds PostgREST's "return exactly one JSON object, not an
 * array" header — required for `create()`/`patch()`/`find()`, whose response
 * adapter expects a bare item, not a one-element array. PostgREST otherwise
 * always wraps affected/matched rows in an array, even for a single row.
 *
 * `countExact: true` additionally asks PostgREST to compute the exact total
 * row count (returned via the `Content-Range` response header) — needed to
 * translate a paginated GET's response into `{ data, meta }` below.
 */
function supabaseHeaders(existing: HttpHeaders, { single = false, countExact = false } = {}): HttpHeaders {
  const preferDirectives = ['return=representation', ...(countExact ? ['count=exact'] : [])];
  let headers = existing
    .set('apikey', environment.supabaseAnonKey)
    .set('Authorization', `Bearer ${environment.supabaseAnonKey}`)
    .set('Content-Type', 'application/json')
    .set('Prefer', preferDirectives.join(','));
  if (single) headers = headers.set('Accept', 'application/vnd.pgrst.object+json');
  return headers;
}

/** Total row count from a PostgREST `Content-Range: 0-4/23` response header (`null` if absent or the total is unknown). */
function totalFromContentRange(header: string | null): number | null {
  if (!header) return null;
  const total = header.split('/')[1];
  return total && total !== '*' ? Number(total) : null;
}

/** `page[number]` / `page[size]` as sent by `paginateSignal`/`page()`, translated to PostgREST's `limit`/`offset`. */
function readPageInfo(params: HttpParams): { page: number; perPage: number } | null {
  const perPage = params.get('page[size]');
  if (!perPage) return null;
  const page = Number(params.get('page[number]') ?? 1);
  return { page, perPage: Number(perPage) };
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

  const pageInfo = readPageInfo(req.params);
  if (pageInfo) {
    params = params
      .set('limit', String(pageInfo.perPage))
      .set('offset', String((pageInfo.page - 1) * pageInfo.perPage));
  }

  return params;
}

const LINK_REQUEST_FIELDS = ['id', 'requesterId', 'targetUserId', 'status'] as const;
const DEVICE_CODE_FIELDS = ['code', 'userId'] as const;

/**
 * Rewrites every `/api/todos`, `/api/link_requests`, and `/api/device_codes`
 * call into the equivalent Supabase PostgREST request — table columns are
 * named to match the TS models exactly (`createdAt`, `requesterId`, ...), so
 * no snake_case translation is needed; see the SQL in README.md. Because
 * this calls `next()` with the rewritten request instead of
 * short-circuiting, the real HTTP call goes out and shows up in DevTools'
 * Network tab like any other request — and `HttpTestingController` can
 * intercept it in tests exactly as it would a hand-written `HttpClient` call.
 */
export const supabaseInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(API_PREFIX)) return next(req);

  if (req.url.startsWith(`${API_PREFIX}todos`)) {
    const id = req.url.split(`${API_PREFIX}todos/`)[1];

    if (req.method === 'GET') {
      const pageInfo = id ? null : readPageInfo(req.params);
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
          headers: supabaseHeaders(req.headers, { single: !!id, countExact: !!pageInfo }),
        }),
      ).pipe(
        map((event) => {
          // Translate PostgREST's bare-array response + `Content-Range` header
          // into the `{ data, meta }` shape `adaptPaginated` expects, so
          // `hasMore()`/`loadMore()` see the real total instead of treating
          // whatever came back as the entire (one-page) result set.
          if (pageInfo && event instanceof HttpResponse && Array.isArray(event.body)) {
            const total = totalFromContentRange(event.headers.get('content-range')) ?? event.body.length;
            const meta = {
              currentPage: pageInfo.page,
              perPage: pageInfo.perPage,
              total,
              lastPage: Math.max(1, Math.ceil(total / pageInfo.perPage)),
            };
            return event.clone({ body: { data: event.body, meta } });
          }
          return event;
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

  if (req.url.startsWith(`${API_PREFIX}device_codes`)) {
    const code = req.url.split(`${API_PREFIX}device_codes/`)[1];

    if (req.method === 'GET') {
      const params = code
        ? new HttpParams().set('code', `eq.${code}`)
        : mapEquality(req.params, new HttpParams(), DEVICE_CODE_FIELDS);
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/device_codes`,
          params,
          headers: supabaseHeaders(req.headers, { single: !!code }),
        }),
      );
    }

    if (req.method === 'POST') {
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/device_codes`,
          headers: supabaseHeaders(req.headers, { single: true }),
        }),
      );
    }

    if ((req.method === 'PATCH' || req.method === 'DELETE') && code) {
      const params = new HttpParams().set('code', `eq.${code}`);
      return next(
        req.clone({
          url: `${environment.supabaseUrl}/rest/v1/device_codes`,
          params,
          headers: supabaseHeaders(req.headers, { single: req.method === 'PATCH' }),
        }),
      );
    }
  }

  return next(req);
};
