import { Injectable } from '@angular/core';
import { NgQlClient, NgQlResource } from 'ng-ql';
import type { Todo } from '../model/todo.model';

@Injectable({ providedIn: 'root' })
export class TodoResource extends NgQlResource<Todo, number> {
  constructor(client: NgQlClient) {
    super(client, { endpoint: 'todos', cacheTags: ['todos'] });
  }
}
