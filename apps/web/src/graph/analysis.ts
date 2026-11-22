import type { ArchCategory, ArchGraph } from '@eyrie/core';
import type { Focus } from '@eyrie/lens';

// Trace, impact and search live in @eyrie/lens, shared with the engine side (the MCP server).
export { focusSet, impactOf, matches, type Focus, type Impact } from '@eyrie/lens';

export function visibleMap({ nodes, edges }: ArchGraph, hidden: ReadonlySet<ArchCategory>, focus?: Focus): ArchGraph {
  const visibleNodes = nodes.filter((node) => !hidden.has(node.category) && (!focus || focus.nodes.has(node.id)));
  const ids = new Set(visibleNodes.map((node) => node.id));
  return {
    nodes: visibleNodes,
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && (!focus || focus.edges.has(edge.id))),
  };
}
