import {compact, textMatcher} from '../buffer/filters.js';
import type {PluginMessage} from '../flipper/FlipperBridge.js';

type Id = number | string;

interface Inspectable {
  type: string;
  value?: unknown;
  fields?: Record<string, Inspectable>;
  items?: Inspectable[];
}

interface ClientNode {
  id: Id;
  parent?: Id;
  qualifiedName: string;
  name: string;
  attributes?: Record<string, Inspectable>;
  inlineAttributes?: Record<string, string>;
  hiddenAttributes?: Record<string, unknown>;
  children: Id[];
  bounds: {x: number; y: number; width: number; height: number};
  tags?: string[];
  activeChild?: Id;
}

interface Metadata {
  id: number | string;
  name: string;
  namespace?: string;
}

interface Frame {
  rootId?: Id;
  txId?: number;
  nodes: Map<Id, ClientNode>;
  receivedAt: number;
}

interface ClientUi {
  metadata: Map<string, Metadata>;
  frame?: Frame;
  initRootId?: Id;
}

/** Pruned node returned to agents. Bounds are absolute screen pixels [x, y, w, h]. */
export interface PrunedNode {
  id: Id;
  cls: string;
  text?: string;
  desc?: string;
  resId?: string;
  b: [number, number, number, number];
  visible?: false;
  children?: PrunedNode[];
  /** Children omitted because of maxDepth/maxNodes. */
  more?: number;
}

export interface HierarchyQuery {
  maxDepth?: number;
  /** Substring or /regex/ matched against class, resource id, text and content description. */
  filter?: string;
  rootId?: Id;
  includeHidden?: boolean;
  maxNodes?: number;
}

const TEXT_ATTRS = new Set(['text']);
const DESC_ATTRS = new Set(['contentdescription', 'content description']);

/**
 * ui-debugger pushes a whole frame (all nodes) on every change; we keep only
 * the latest one per app plus the attribute metadata needed to read it.
 */
export class UiStore {
  private readonly clients = new Map<string, ClientUi>();

  private ui(clientId: string): ClientUi {
    let ui = this.clients.get(clientId);
    if (!ui) {
      ui = {metadata: new Map()};
      this.clients.set(clientId, ui);
    }
    return ui;
  }

  handle(message: PluginMessage): void {
    if (message.api !== 'ui-debugger') return;
    const ui = this.ui(message.clientId);
    const params = message.params as Record<string, unknown>;
    switch (message.method) {
      case 'init':
        // A (re)connected plugin restarts its txId counter and resends a full frame.
        ui.initRootId = params.rootId as Id;
        ui.frame = undefined;
        break;
      case 'metadataUpdate': {
        const metadata = (params.attributeMetadata ?? {}) as Record<string, Metadata>;
        for (const [id, meta] of Object.entries(metadata)) ui.metadata.set(String(id), meta);
        break;
      }
      case 'subtreeUpdate':
      case 'frameScan': {
        const nodes = (params.nodes ?? []) as ClientNode[];
        const txId = (params.txId ?? params.frameTime) as number | undefined;
        if (ui.frame?.txId !== undefined && txId !== undefined && txId < ui.frame.txId) return;
        ui.frame = {
          rootId: (params.rootId as Id | undefined) ?? ui.initRootId,
          txId,
          nodes: new Map(nodes.map((node) => [node.id, node])),
          receivedAt: message.ts,
        };
        break;
      }
      default:
        break;
    }
  }

  forget(clientId: string): void {
    this.clients.delete(clientId);
  }

  hasFrame(clientId: string): boolean {
    return Boolean(this.clients.get(clientId)?.frame);
  }

  hierarchy(clientId: string, query: HierarchyQuery = {}) {
    const ui = this.clients.get(clientId);
    const frame = ui?.frame;
    if (!ui || !frame) return undefined;
    const maxDepth = query.maxDepth ?? 12;
    const maxNodes = query.maxNodes ?? 300;
    const includeHidden = query.includeHidden ?? false;
    const match = textMatcher(query.filter);
    const rootId = query.rootId ?? this.findRoot(frame);
    if (rootId === undefined || !frame.nodes.has(rootId)) {
      throw new Error(`Node ${String(rootId)} is not in the latest frame.`);
    }
    const origin = this.absoluteOrigin(frame, rootId);
    const rootHidden = this.hiddenByAncestors(ui, frame, rootId);
    let emitted = 0;

    if (match) {
      // Flat list of matches with their ancestor path, cheaper than a tree.
      const results: (PrunedNode & {path: string})[] = [];
      const walk = (id: Id, ox: number, oy: number, path: string[], hidden: boolean) => {
        const node = frame.nodes.get(id);
        if (!node || results.length >= maxNodes) return;
        const pruned = this.prune(ui, node, ox, oy, hidden);
        if (pruned.visible === false && !includeHidden) return;
        const fields = [node.qualifiedName, node.name, pruned.resId, pruned.text, pruned.desc];
        if (fields.some((field) => match(field))) results.push({...pruned, path: path.join(' > ')});
        for (const child of this.childrenOf(node)) {
          walk(child.id, pruned.b[0], pruned.b[1], [...path, node.name], pruned.visible === false || child.inactive);
        }
      };
      walk(rootId, origin.x, origin.y, [], rootHidden);
      return {
        txId: frame.txId,
        frameAgeMs: Date.now() - frame.receivedAt,
        matches: results.length,
        truncated: results.length >= maxNodes || undefined,
        nodes: results.map(({children: _children, ...rest}) => rest),
      };
    }

    const build = (id: Id, ox: number, oy: number, depth: number, hidden: boolean): PrunedNode | undefined => {
      const node = frame.nodes.get(id);
      if (!node) return undefined;
      const pruned = this.prune(ui, node, ox, oy, hidden);
      if (pruned.visible === false && !includeHidden) return undefined;
      emitted += 1;
      const children = this.childrenOf(node);
      if (children.length === 0) return pruned;
      if (depth >= maxDepth || emitted >= maxNodes) return {...pruned, more: children.length};
      const built: PrunedNode[] = [];
      let skipped = 0;
      for (const child of children) {
        if (emitted >= maxNodes) {
          skipped += 1;
          continue;
        }
        const sub = build(child.id, pruned.b[0], pruned.b[1], depth + 1, pruned.visible === false || child.inactive);
        if (sub) built.push(sub);
      }
      return compact({...pruned, children: built, more: skipped || undefined}) as PrunedNode;
    };

    const root = build(rootId, origin.x, origin.y, 0, rootHidden);
    return {
      txId: frame.txId,
      frameAgeMs: Date.now() - frame.receivedAt,
      nodeCount: frame.nodes.size,
      emitted,
      root,
      ...(emitted >= maxNodes ? {truncated: true, hint: 'maxNodes reached; use filter or rootId to narrow'} : {}),
    };
  }

  private findRoot(frame: Frame): Id | undefined {
    if (frame.rootId !== undefined && frame.nodes.has(frame.rootId)) return frame.rootId;
    for (const node of frame.nodes.values()) {
      if (node.parent === undefined || !frame.nodes.has(node.parent)) return node.id;
    }
    return undefined;
  }

  /** True when an ancestor of `id` is hidden or `id` sits in an inactive `activeChild` branch. */
  private hiddenByAncestors(ui: ClientUi, frame: Frame, id: Id): boolean {
    let childId = id;
    let current = frame.nodes.get(id)?.parent;
    const seen = new Set<Id>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const node = frame.nodes.get(current);
      if (!node) break;
      if (node.activeChild !== undefined && node.activeChild !== childId) return true;
      if (this.prune(ui, node, 0, 0, false).visible === false) return true;
      childId = current;
      current = node.parent;
    }
    return false;
  }

  /** Bounds are relative to the parent; add up the ancestors of `id`. */
  private absoluteOrigin(frame: Frame, id: Id): {x: number; y: number} {
    let x = 0;
    let y = 0;
    let current = frame.nodes.get(id)?.parent;
    const seen = new Set<Id>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const node = frame.nodes.get(current);
      if (!node) break;
      x += node.bounds?.x ?? 0;
      y += node.bounds?.y ?? 0;
      current = node.parent;
    }
    return {x, y};
  }

  private childrenOf(node: ClientNode): {id: Id; inactive: boolean}[] {
    return (node.children ?? []).map((id) => ({
      id,
      inactive: node.activeChild !== undefined && node.activeChild !== id,
    }));
  }

  private prune(ui: ClientUi, node: ClientNode, ox: number, oy: number, ancestorHidden: boolean): PrunedNode {
    const {text, desc, hidden: notVisible} = this.readAttributes(ui, node.attributes);
    const bounds = node.bounds ?? {x: 0, y: 0, width: 0, height: 0};
    const hidden =
      ancestorHidden ||
      notVisible === true ||
      node.hiddenAttributes?.invisible === true ||
      bounds.width <= 0 ||
      bounds.height <= 0;
    return compact({
      id: node.id,
      cls: node.name || node.qualifiedName,
      text,
      desc,
      resId: node.inlineAttributes?.id,
      b: [ox + bounds.x, oy + bounds.y, bounds.width, bounds.height] as [number, number, number, number],
      visible: hidden ? (false as const) : undefined,
    }) as PrunedNode;
  }

  private readAttributes(ui: ClientUi, attributes: Record<string, Inspectable> | undefined) {
    const found: {text?: string; desc?: string; hidden?: boolean} = {};
    const visit = (fields: Record<string, Inspectable> | undefined, depth: number) => {
      if (!fields || depth > 3) return;
      for (const [metadataId, value] of Object.entries(fields)) {
        const name = ui.metadata.get(metadataId)?.name?.toLowerCase();
        // Namespace sections (e.g. TextView) arrive as {fields} without a type.
        if (value?.fields) {
          visit(value.fields, depth + 1);
          continue;
        }
        if (!name || typeof value?.value !== 'string' || value.value === '') continue;
        if (TEXT_ATTRS.has(name)) found.text ??= value.value;
        else if (DESC_ATTRS.has(name)) found.desc ??= value.value;
        else if (name === 'visibility' && value.value !== 'VISIBLE') found.hidden = true;
      }
    };
    visit(attributes, 0);
    return found;
  }
}
