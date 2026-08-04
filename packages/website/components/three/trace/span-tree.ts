/* The VERIFIED span tree from FINDINGS.md, laid out as a tidy tree.
   Root: agent.session → 3× agent.turn → each: 2× agent.step + 1×
   agent.turn.terminal → each step: ai.streamText → ai.streamText.doStream.
   25 nodes, 24 edges — small enough that GPGPU would be malpractice. */

export interface TraceNode {
  depth: number;
  x: number;
  y: number;
  seed: number;
}

export interface TraceEdge {
  from: number;
  to: number;
}

export function buildSpanTree(): { nodes: TraceNode[]; edges: TraceEdge[] } {
  interface T {
    depth: number;
    children: T[];
    index?: number;
    y?: number;
  }
  const step = (): T => ({
    depth: 2,
    children: [{ depth: 3, children: [{ depth: 4, children: [] }] }],
  });
  const turn = (): T => ({
    depth: 1,
    children: [step(), step(), { depth: 2, children: [] }],
  });
  const root: T = { depth: 0, children: [turn(), turn(), turn()] };

  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  let leafY = 0;

  // tidy layout: leaves stacked evenly, parents centered on children
  const place = (node: T): number => {
    let y: number;
    if (node.children.length === 0) {
      y = leafY;
      leafY += 1;
    } else {
      const ys = node.children.map(place);
      y = ys.reduce((a, b) => a + b, 0) / ys.length;
    }
    node.y = y;
    node.index = nodes.length;
    nodes.push({ depth: node.depth, x: node.depth, y, seed: Math.abs(Math.sin(nodes.length * 12.9898)) });
    node.children.forEach((child) => {
      // child was placed before parent — indices already assigned
    });
    return y;
  };
  place(root);

  // second pass for edges (parents have indices now)
  const wire = (node: T) => {
    node.children.forEach((child) => {
      edges.push({ from: node.index!, to: child.index! });
      wire(child);
    });
  };
  wire(root);

  // normalize into scene units: x spread 8.4, y spread 4.6, centered
  const leafCount = leafY - 1;
  for (const n of nodes) {
    n.x = (n.x / 4 - 0.5) * 8.4;
    n.y = (n.y / leafCount - 0.5) * -4.6;
  }
  return { nodes, edges };
}
