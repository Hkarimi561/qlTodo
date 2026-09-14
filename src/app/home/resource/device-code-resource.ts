import { Injectable } from '@angular/core';
import { NgQlClient, NgQlResource } from 'ng-ql';
import type { DeviceCode } from '../model/device-code.model';

/** Registers/resolves the short 5-digit codes devices use to find each other's uuid. */
@Injectable({ providedIn: 'root' })
export class DeviceCodeResource extends NgQlResource<DeviceCode, string> {
  constructor(client: NgQlClient) {
    super(client, { endpoint: 'device_codes', primaryKey: 'code' });
  }
}
