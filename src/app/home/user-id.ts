const STORAGE_KEY = 'ng-ql-todo-user-id';

/**
 * The current device's anonymous identity — every todo it reads/writes is
 * scoped to this id. Generated once with `crypto.randomUUID()` and kept in
 * `localStorage`, so there's nothing to log in with. "Linking" a device
 * (see link-request-resource.ts) works by replacing this value with another
 * device's id once that device approves the request.
 */
export function getUserId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

export function setUserId(id: string): void {
  localStorage.setItem(STORAGE_KEY, id);
}
