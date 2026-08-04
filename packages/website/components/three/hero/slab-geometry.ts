import * as THREE from "three";
import { SLAB } from "./slab-data";

export { SLAB, SLABS, type SlabSpec } from "./slab-data";

/* One shared chamfered-slab geometry for all four quadrants of the ▚ mark.
   1-segment bevel = flat 45° chamfer — a crisp linear rim-light streak,
   deliberately NOT a fillet. Procedural: zero asset bytes. */

function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const w = width / 2;
  const h = height / 2;
  shape.moveTo(-w + radius, -h);
  shape.lineTo(w - radius, -h);
  shape.absarc(w - radius, -h + radius, radius, -Math.PI / 2, 0, false);
  shape.lineTo(w, h - radius);
  shape.absarc(w - radius, h - radius, radius, 0, Math.PI / 2, false);
  shape.lineTo(-w + radius, h);
  shape.absarc(-w + radius, h - radius, radius, Math.PI / 2, Math.PI, false);
  shape.lineTo(-w, -h + radius);
  shape.absarc(-w + radius, -h + radius, radius, Math.PI, Math.PI * 1.5, false);
  return shape;
}

export function createSlabGeometry(): THREE.ExtrudeGeometry {
  const { size, depth, chamfer, corner } = SLAB;
  const shape = roundedRectShape(size - 2 * chamfer, size - 2 * chamfer, corner);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    steps: 1,
    depth: depth - 2 * chamfer,
    bevelEnabled: true,
    bevelThickness: chamfer,
    bevelSize: chamfer,
    bevelSegments: 1,
  });
  geometry.center();
  geometry.computeVertexNormals();
  return geometry;
}
