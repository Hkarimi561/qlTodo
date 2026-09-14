import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { DefaultNgQlQuerySerializer, provideNgQl } from 'ng-ql';
import { supabaseInterceptor } from './supabase.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([supabaseInterceptor])),
    provideNgQl({
      baseUrl: '/api',
      defaultCachePolicy: 'cache-first',
      defaultCacheTtl: 30_000,
      // Bare field names (done=true) instead of the filter[...] envelope (filter[done]=true).
      querySerializer: new DefaultNgQlQuerySerializer({ filterPrefix: null }),
    }),
  ],
};
