import {
  Component,
  DestroyRef,
  effect,
  ElementRef,
  EnvironmentInjector,
  inject,
  runInInjectionContext,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { NgQlPaginatedRequestState, NgQlRequestState } from 'ng-ql';
import { finalize } from 'rxjs';
import type { DeviceCode } from './model/device-code.model';
import { DeviceCodeResource } from './resource/device-code-resource';
import type { LinkRequest } from './model/link-request.model';
import { LinkRequestResource } from './resource/link-request-resource';
import type { Todo } from './model/todo.model';
import { TodoResource } from './resource/todo-resource';
import { RelativeTimePipe } from './relative-time.pipe';
import { getUserId, setUserId } from './user-id';
import { getBrowserLabel, getPublicIp } from './device-info';
import { Icon } from './icon';
import { Spinner } from './spinner';

type Filter = 'all' | 'active' | 'done';
type DateFilter = 'none' | 'today' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'custom';
type LinkState = 'idle' | 'sending' | 'waiting' | 'denied' | 'error';
type Direction = 'ltr' | 'rtl';

const POLL_INTERVAL_MS = 4000;
const PAGE_SIZE = 10;
const DARK_MODE_STORAGE_KEY = 'ng-ql-todo-dark-mode';
const DIRECTION_STORAGE_KEY = 'ng-ql-todo-direction';

const pad = (n: number) => String(n).padStart(2, '0');
const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Resolves a preset/custom date filter to a `[fromDateStr, toDateStr]` (yyyy-mm-dd) range. */
function computeDateRange(filter: DateFilter, customFrom: string, customTo: string): [string, string] | null {
  const today = startOfDay(new Date());

  switch (filter) {
    case 'today':
      return [toDateStr(today), toDateStr(today)];
    case 'this-week': {
      const monday = new Date(today);
      monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return [toDateStr(monday), toDateStr(sunday)];
    }
    case 'last-week': {
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      const lastMonday = new Date(thisMonday);
      lastMonday.setDate(thisMonday.getDate() - 7);
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastMonday.getDate() + 6);
      return [toDateStr(lastMonday), toDateStr(lastSunday)];
    }
    case 'this-month': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return [toDateStr(first), toDateStr(last)];
    }
    case 'last-month': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return [toDateStr(first), toDateStr(last)];
    }
    case 'custom':
      return customFrom && customTo ? [customFrom, customTo] : null;
    default:
      return null;
  }
}

@Component({
  selector: 'app-root',
  imports: [FormsModule, RelativeTimePipe, Icon, Spinner],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly injector = inject(EnvironmentInjector);
  private readonly todos = inject(TodoResource);
  private readonly linkRequests = inject(LinkRequestResource);
  private readonly deviceCodes = inject(DeviceCodeResource);

  protected readonly darkToggleBtn = viewChild<ElementRef<HTMLButtonElement>>('darkToggleBtn');
  protected readonly scrollSentinel = viewChild<ElementRef<HTMLElement>>('scrollSentinel');

  protected readonly filter = signal<Filter>('active');
  protected readonly dateFilter = signal<DateFilter>('none');
  protected readonly customFrom = signal(''); // yyyy-mm-dd, from <input type="date">
  protected readonly customTo = signal('');
  protected readonly newTitle = signal('');
  protected readonly creating = signal(false);
  protected readonly infoOpen = signal(false);
  protected readonly darkMode = signal(localStorage.getItem(DARK_MODE_STORAGE_KEY) === 'true');
  protected readonly direction = signal<Direction>(
    (localStorage.getItem(DIRECTION_STORAGE_KEY) as Direction) || 'ltr',
  );

  /**
   * Rebuilt from scratch every time a filter/search input changes.
   * `paginateSignal()` requires an injection context, so this runs inside
   * `runInInjectionContext` rather than a component field initializer —
   * unlike a fixed set of filters, title/date search inputs are open-ended.
   * Starts back at page 1 (5 items) each time; further pages are appended
   * via `loadMore()` as the scroll sentinel below the list comes into view.
   */
  protected readonly list = signal<NgQlPaginatedRequestState<Todo>>(this.runQuery());

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
    document.documentElement.classList.toggle('dark', this.darkMode());
    document.documentElement.setAttribute('dir', this.direction());

    const handle = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(handle);
      const code = this.deviceCode();
      if (code) this.deviceCodes.destroy(code).subscribe();
    });

    // Infinite scroll: re-observe the sentinel `<div>` at the bottom of the
    // list (rendered only while `hasMore()`) each time it appears, and load
    // the next page of 5 once it's within 200px of the viewport.
    effect((onCleanup) => {
      const target = this.scrollSentinel()?.nativeElement;
      if (!target) return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) this.list().loadMore();
        },
        { rootMargin: '200px' },
      );
      observer.observe(target);
      onCleanup(() => observer.disconnect());
    });
  }

  // -- Filtering ---------------------------------------------------------

  setFilter(filter: Filter): void {
    this.filter.set(filter);
    this.list.set(this.runQuery());
  }

  /** Selecting the already-active date filter clears it back to 'none'. */
  setDateFilter(value: DateFilter): void {
    const next = this.dateFilter() === value ? 'none' : value;
    this.dateFilter.set(next);
    if (next === 'custom') return; // wait for both From/To to be picked
    this.list.set(this.runQuery());
  }

  onCustomFromChange(value: string): void {
    this.customFrom.set(value);
    this.applyCustomRangeIfComplete();
  }

  onCustomToChange(value: string): void {
    this.customTo.set(value);
    this.applyCustomRangeIfComplete();
  }

  private applyCustomRangeIfComplete(): void {
    if (this.customFrom() && this.customTo()) this.list.set(this.runQuery());
  }

  private runQuery(): NgQlPaginatedRequestState<Todo> {
    return runInInjectionContext(this.injector, () => {
      let query = this.todos.query().orderBy('createdAt', 'desc');

      if (this.filter() === 'active') query = query.where('done', false);
      if (this.filter() === 'done') query = query.where('done', true);

      const range = computeDateRange(this.dateFilter(), this.customFrom(), this.customTo());
      if (range) query = query.whereBetween('createdAt', [`${range[0]}T00:00:00.000Z`, `${range[1]}T23:59:59.999Z`]);

      return query.paginateSignal(1, PAGE_SIZE, { cache: 'no-store' });
    });
  }

  // -- CRUD --------------------------------------------------------------

  add(): void {
    const title = this.newTitle().trim();
    if (!title || this.creating()) return;

    this.creating.set(true);
    this.todos
      .create({ title })
      .pipe(finalize(() => this.creating.set(false)))
      .subscribe(() => {
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

  /**
   * Toggles dark mode with a circular reveal that expands from the toggle icon
   * across the whole page, via the View Transitions API (falls back to an
   * instant switch on browsers that don't support it, e.g. Firefox/Safari <18).
   *
   * Uses the button's own `getBoundingClientRect()` center rather than the
   * click/tap event's coordinates — on mobile, touch-synthesized click events
   * can report coordinates that don't match the icon's actual position
   * (e.g. (0,0)), which made the reveal appear to start from the top-left
   * corner instead of the icon.
   */
  toggleDarkMode(): void {
    const enabled = !this.darkMode();
    const apply = () => this.applyDarkMode(enabled);

    const startViewTransition = (
      document as Document & {
        startViewTransition?: (cb: () => void) => {
          ready: Promise<void>;
          finished: Promise<void>;
        };
      }
    ).startViewTransition?.bind(document);

    if (!startViewTransition) {
      apply();
      return;
    }

    const rect = this.darkToggleBtn()?.nativeElement.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const noop = () => {
      // The transition can be skipped/aborted (e.g. a second toggle fires before
      // the first finishes, the tab is backgrounded, or the browser lacks real
      // compositor support) — `apply()` already landed (or lands below), so
      // there's nothing to redo.
    };

    try {
      const transition = startViewTransition(apply);
      transition.finished.catch(noop);
      transition.ready
        .then(() => {
          document.documentElement.animate(
            {
              clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
            },
            { duration: 600, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' },
          );
        })
        .catch(noop);
    } catch {
      apply();
    }
  }

  private applyDarkMode(enabled: boolean): void {
    this.darkMode.set(enabled);
    document.documentElement.classList.toggle('dark', enabled);
    localStorage.setItem(DARK_MODE_STORAGE_KEY, String(enabled));
  }

  setDirection(direction: Direction): void {
    this.direction.set(direction);
    document.documentElement.setAttribute('dir', direction);
    localStorage.setItem(DIRECTION_STORAGE_KEY, direction);
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
        next: async (matches) => {
          const targetUserId = matches[0]?.userId;
          if (!targetUserId || targetUserId === this.userId()) {
            this.linkState.set('error');
            return;
          }
          const requesterDevice = getBrowserLabel();
          const requesterIp = await getPublicIp();
          this.linkRequests
            .create({
              requesterId: this.userId(),
              requesterDevice,
              requesterIp,
              targetUserId,
              status: 'pending',
            })
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
