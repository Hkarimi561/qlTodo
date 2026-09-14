import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DefaultNgQlQuerySerializer, provideNgQl } from 'ng-ql';
import { supabaseInterceptor } from '../supabase.interceptor';
import { App } from './app';

describe('App', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(withInterceptors([supabaseInterceptor])),
        provideHttpClientTesting(),
        provideNgQl({
          baseUrl: '/api',
          querySerializer: new DefaultNgQlQuerySerializer({ filterPrefix: null }),
        }),
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  /** The app fires a todos GET and a link_requests GET as soon as it's constructed. */
  function flushInitialRequests(): void {
    for (const req of httpMock.match(() => true)) {
      req.flush([]);
    }
  }

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    flushInitialRequests();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the todo list heading', async () => {
    const fixture = TestBed.createComponent(App);
    flushInitialRequests();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('ng-ql Todo example');
  });
});
