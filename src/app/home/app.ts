import {
  Component,
  DestroyRef,
  EnvironmentInjector,
  inject,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { NgQlRequestState } from 'ng-ql';
import type { DeviceCode } from './model/device-code.model';
import { DeviceCodeResource } from './resource/device-code-resource';
import type { LinkRequest } from './model/link-request.model';
import { LinkRequestResource } from './resource/link-request-resource';
import type { Todo } from './model/todo.model';
import { TodoResource } from './resource/todo-resource';
import { RelativeTimePipe } from './relative-time.pipe';
import { getUserId, setUserId } from './user-id';

type Filter = 'all' | 'active' | 'done';
type LinkState = 'idle' | 'sending' | 'waiting' | 'denied' | 'error';

const SEARCH_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 4000;

@Component({
  selector: 'app-root',
  imports: [FormsModule, RelativeTimePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly injector = inject(EnvironmentInjector);
  private readonly todos = inject(TodoResource);
  private readonly linkRequests = inject(LinkRequestResource);
  private readonly deviceCodes = inject(DeviceCodeResource);
  private searchDebounce?: ReturnType<typeof setTimeout>;

  protected readonly filter = signal<Filter>('all');
  protected readonly searchTitle = signal('');
  protected readonly searchDate = signal(''); // yyyy-mm-dd, from <input type="date">
  protected readonly newTitle = signal('');

  /**
   * Rebuilt from scratch every time a filter/search input changes.
   * `getSignal()` requires an injection context, so this runs inside
   * `runInInjectionContext` rather than a component field initializer —
   * unlike a fixed set of filters, title/date search inputs are open-ended.
   */
  protected readonly list = signal<NgQlRequestState<Todo[]>>(this.runQuery());

  // -- Device identity & linking --------------------------------------------

  protected readonly userId = signal(getUserId());
  protected readonly linkTargetCode = signal('');
  protected readonly linkState = signal<LinkState>('idle');
  private outgoingRequestId: string | null = null;

  /** Whether this device is currently discoverable via `deviceCode`. */
  protected readonly listening = signal(false);
  /** The short code other devices can enter to find this device, while listening. */
  protected readonly deviceCode = signal<string | null>(null);

  /** Pending requests from other devices asking to adopt *this* device's id. */
  protected readonly incomingRequests = signal<NgQlRequestState<LinkRequest[]>>(
    this.buildIncomingRequests(),
  );

  constructor() {
    const handle = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(handle);
      const code = this.deviceCode();
      if (code) this.deviceCodes.destroy(code).subscribe();
    });
  }

  // -- Filtering & search ----------------------------------------------------

  setFilter(filter: Filter): void {
    this.filter.set(filter);
    this.list.set(this.runQuery());
  }

  onSearchTitleInput(value: string): void {
    this.searchTitle.set(value);
    clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => this.list.set(this.runQuery()), SEARCH_DEBOUNCE_MS);
  }

  onSearchDateChange(value: string): void {
    this.searchDate.set(value);
    this.list.set(this.runQuery());
  }

  clearSearch(): void {
    this.searchTitle.set('');
    this.searchDate.set('');
    this.list.set(this.runQuery());
  }

  private runQuery(): NgQlRequestState<Todo[]> {
    return runInInjectionContext(this.injector, () => {
      let query = this.todos.query().orderBy('createdAt', 'desc');

      if (this.filter() === 'active') query = query.where('done', false);
      if (this.filter() === 'done') query = query.where('done', true);

      const title = this.searchTitle().trim();
      if (title) query = query.where('title', 'like', title);

      const date = this.searchDate();
      if (date) query = query.whereBetween('createdAt', [`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`]);

      return query.getSignal({ cache: 'no-store' });
    });
  }

  // -- CRUD --------------------------------------------------------------

  add(): void {
    const title = this.newTitle().trim();
    if (!title) return;
    this.todos.create({ title }).subscribe(() => {
      this.newTitle.set('');
      this.list().refresh();
    });
  }

  toggle(id: number, done: boolean): void {
    this.todos.patch(id, { done: !done }).subscribe(() => this.list().refresh());
  }

  remove(id: number): void {
    this.todos.destroy(id).subscribe(() => this.list().refresh());
  }

  // -- Export / import -----------------------------------------------------

  export(): void {
    this.todos.all().subscribe((allTodos) => {
      const payload = { userId: this.userId(), exportedAt: new Date().toISOString(), todos: allTodos };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ng-ql-todos-${this.userId().slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let items: Partial<Todo>[];
      try {
        items = (JSON.parse(String(reader.result)) as { todos?: Partial<Todo>[] }).todos ?? [];
      } catch {
        return;
      }
      for (const item of items) {
        if (!item.title) continue;
        this.todos.create({ title: item.title, done: item.done ?? false }).subscribe();
      }
      setTimeout(() => this.list().refresh(), 300);
    };
    reader.readAsText(file);
  }

  // -- Settings dialog ---------------------------------------------------

  /** Closes the <dialog> when its ::backdrop (the element itself, padding included) is clicked. */
  onDialogBackdropClick(event: MouseEvent, dialog: HTMLDialogElement): void {
    if (event.target === dialog) dialog.close();
  }

  // -- Device linking --------------------------------------------------------

  /** Registers a fresh 5-digit code for this device, retrying on a (rare) collision. */
  startListening(attempt = 0): void {
    if (attempt >= 5) {
      this.linkState.set('error');
      return;
    }
    const code = String(Math.floor(10_000 + Math.random() * 90_000));
    this.deviceCodes.create({ code, userId: this.userId() } as Partial<DeviceCode>).subscribe({
      next: () => {
        this.deviceCode.set(code);
        this.listening.set(true);
      },
      error: () => this.startListening(attempt + 1),
    });
  }

  stopListening(): void {
    const code = this.deviceCode();
    this.listening.set(false);
    this.deviceCode.set(null);
    if (code) this.deviceCodes.destroy(code).subscribe();
  }

  async copyDeviceCode(): Promise<void> {
    const code = this.deviceCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard API unavailable; ignore.
    }
  }

  /** Resolves the entered 5-digit code to a device id, then sends that device a link request. */
  requestLink(): void {
    const code = this.linkTargetCode().trim();
    if (!code) return;

    this.linkState.set('sending');
    this.deviceCodes
      .query()
      .where({ code })
      .get()
      .subscribe({
        next: (matches) => {
          const targetUserId = matches[0]?.userId;
          if (!targetUserId || targetUserId === this.userId()) {
            this.linkState.set('error');
            return;
          }
          this.linkRequests
            .create({ requesterId: this.userId(), targetUserId, status: 'pending' })
            .subscribe({
              next: (row) => {
                this.outgoingRequestId = row.id;
                this.linkState.set('waiting');
              },
              error: () => this.linkState.set('error'),
            });
        },
        error: () => this.linkState.set('error'),
      });
  }

  cancelLink(): void {
    const id = this.outgoingRequestId;
    this.outgoingRequestId = null;
    this.linkState.set('idle');
    this.linkTargetCode.set('');
    if (id) this.linkRequests.destroy(id).subscribe();
  }

  approve(request: LinkRequest): void {
    this.linkRequests
      .patch(request.id, { status: 'approved' })
      .subscribe(() => this.incomingRequests().refresh());
  }

  deny(request: LinkRequest): void {
    this.linkRequests
      .patch(request.id, { status: 'denied' })
      .subscribe(() => this.incomingRequests().refresh());
  }

  private buildIncomingRequests(): NgQlRequestState<LinkRequest[]> {
    return runInInjectionContext(this.injector, () =>
      this.linkRequests
        .query()
        .where({ targetUserId: this.userId(), status: 'pending' })
        .getSignal({ cache: 'no-store' }),
    );
  }

  private poll(): void {
    if (this.listening()) this.incomingRequests().refresh();

    const id = this.outgoingRequestId;
    if (!id) return;

    this.linkRequests.find(id).subscribe((row) => {
      if (!row) return;

      if (row.status === 'approved') {
        if (this.listening()) this.stopListening();
        setUserId(row.targetUserId);
        this.userId.set(row.targetUserId);
        this.outgoingRequestId = null;
        this.linkState.set('idle');
        this.linkTargetCode.set('');
        this.incomingRequests.set(this.buildIncomingRequests());
        this.list.set(this.runQuery());
        this.linkRequests.destroy(id).subscribe();
      } else if (row.status === 'denied') {
        this.outgoingRequestId = null;
        this.linkState.set('denied');
        this.linkRequests.destroy(id).subscribe();
      }
    });
  }
}
