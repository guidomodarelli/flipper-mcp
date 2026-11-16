import {describe, expect, it} from 'vitest';
import * as fx from '../test-support/fixtures.js';
import {UiStore} from './UiStore.js';

const APP = 'A#Android#Pixel#emulator-5554';

type Result = {root?: unknown; nodes?: unknown[]};

function storeWith(nodes: unknown[]) {
  const ui = new UiStore();
  ui.handle({clientId: APP, api: 'ui-debugger', method: 'metadataUpdate', params: fx.uiMetadata, ts: Date.now()});
  ui.handle({clientId: APP, api: 'ui-debugger', method: 'subtreeUpdate', params: {...fx.subtreeUpdate, nodes}, ts: Date.now()});
  return ui;
}

describe('UiStore', () => {
  it('treats a subtree under an inactive activeChild branch as hidden', () => {
    const nodes = fx.subtreeUpdate.nodes.map((n) => (n.id === 2 ? {...n, activeChild: 3} : n));
    const ui = storeWith(nodes);

    expect((ui.hierarchy(APP, {rootId: 4}) as Result).root).toBeUndefined();
    expect((ui.hierarchy(APP, {rootId: 4, includeHidden: true}) as Result).root).toMatchObject({id: 4, visible: false});
    expect((ui.hierarchy(APP, {rootId: 2, filter: 'Ingresar'}) as Result).nodes).toEqual([]);
  });

  it('treats a subtree under an invisible ancestor as hidden', () => {
    const nodes = fx.subtreeUpdate.nodes.map((n) => (n.id === 2 ? {...n, hiddenAttributes: {invisible: true}} : n));
    const ui = storeWith(nodes);

    expect((ui.hierarchy(APP, {rootId: 3, filter: 'Hola'}) as Result).nodes).toEqual([]);
  });
});
