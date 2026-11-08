// SPDX-License-Identifier: AGPL-3.0-only
import { newId, type ItemTemplateNode } from '@bines/shared';

/**
 * Pure edits of a template tree (the editor): every change returns a new tree. Nodes are found by
 * their `id`; the root never moves or goes.
 */
export const newNode = (name: string): ItemTemplateNode => ({
  id: newId().slice(-10).toLowerCase(),
  name,
  cells: {},
  updates: [],
  children: [],
});

export const findNode = (root: ItemTemplateNode, id: string): ItemTemplateNode | null => {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
};

/** The node's depth (root 0) and its parent, or null when not found. */
export const locate = (
  root: ItemTemplateNode,
  id: string,
  depth = 0,
  parent: ItemTemplateNode | null = null,
): { depth: number; parent: ItemTemplateNode | null } | null => {
  if (root.id === id) return { depth, parent };
  for (const c of root.children) {
    const hit = locate(c, id, depth + 1, root);
    if (hit) return hit;
  }
  return null;
};

export const mapNode = (
  root: ItemTemplateNode,
  id: string,
  fn: (n: ItemTemplateNode) => ItemTemplateNode,
): ItemTemplateNode =>
  root.id === id ? fn(root) : { ...root, children: root.children.map((c) => mapNode(c, id, fn)) };

export const addChild = (root: ItemTemplateNode, parentId: string, child: ItemTemplateNode) =>
  mapNode(root, parentId, (n) => ({ ...n, children: [...n.children, child] }));

export const removeNode = (root: ItemTemplateNode, id: string): ItemTemplateNode => ({
  ...root,
  children: root.children.filter((c) => c.id !== id).map((c) => removeNode(c, id)),
});

/** Up (-1) or down (+1) among its siblings. */
export const moveNode = (root: ItemTemplateNode, id: string, step: -1 | 1): ItemTemplateNode => {
  const i = root.children.findIndex((c) => c.id === id);
  if (i >= 0) {
    const j = i + step;
    if (j < 0 || j >= root.children.length) return root;
    const children = [...root.children];
    [children[i], children[j]] = [children[j]!, children[i]!];
    return { ...root, children };
  }
  return { ...root, children: root.children.map((c) => moveNode(c, id, step)) };
};

/** One level in: under the sibling above it (last). */
export const indentNode = (root: ItemTemplateNode, id: string): ItemTemplateNode => {
  const i = root.children.findIndex((c) => c.id === id);
  if (i > 0) {
    const node = root.children[i]!;
    const prev = root.children[i - 1]!;
    const children = root.children.filter((c) => c.id !== id);
    return {
      ...root,
      children: children.map((c) => (c.id === prev.id ? { ...c, children: [...c.children, node] } : c)),
    };
  }
  return { ...root, children: root.children.map((c) => indentNode(c, id)) };
};

/** One level out: right after its parent (never above the root's children). */
export const outdentNode = (root: ItemTemplateNode, id: string): ItemTemplateNode => {
  for (const [i, c] of root.children.entries()) {
    const k = c.children.findIndex((x) => x.id === id);
    if (k >= 0) {
      const node = c.children[k]!;
      const parent = { ...c, children: c.children.filter((x) => x.id !== id) };
      const children = [...root.children];
      children.splice(i, 1, parent, node);
      return { ...root, children };
    }
  }
  return { ...root, children: root.children.map((c) => outdentNode(c, id)) };
};

/** Flattened for the tree pane: each node with its depth, in order. */
export const flatten = (root: ItemTemplateNode, depth = 0): { node: ItemTemplateNode; depth: number }[] => [
  { node: root, depth },
  ...root.children.flatMap((c) => flatten(c, depth + 1)),
];
