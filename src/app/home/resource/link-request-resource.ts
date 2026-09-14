import { Injectable } from '@angular/core';
import { NgQlClient, NgQlResource } from 'ng-ql';
import type { LinkRequest } from '../model/link-request.model';

/**
 * The "device linking" handshake: a new device creates a pending row here
 * naming the device it wants to copy todos from; that other device approves
 * or denies it. See app.ts for the actual flow.
 */
@Injectable({ providedIn: 'root' })
export class LinkRequestResource extends NgQlResource<LinkRequest, string> {
  constructor(client: NgQlClient) {
    super(client, { endpoint: 'link_requests' });
  }
}
