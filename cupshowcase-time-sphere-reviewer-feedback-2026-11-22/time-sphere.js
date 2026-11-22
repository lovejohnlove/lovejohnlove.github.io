export const SPHERE_POINTS = Object.freeze([
  Object.freeze({ id: 'A', x: 260, y: 62 }),
  Object.freeze({ id: 'B', x: 352, y: 116 }),
  Object.freeze({ id: 'C', x: 330, y: 230 }),
  Object.freeze({ id: 'D', x: 190, y: 230 }),
  Object.freeze({ id: 'E', x: 168, y: 116 }),
]);

/** Return one schematic drawing point. This does not represent measured time or events. */
export function getTimeSpherePoint(value) {
  const numeric = Number(value);
  const requestedIndex = Number.isFinite(numeric) ? Math.trunc(numeric) - 1 : 0;
  const index = Math.max(0, Math.min(SPHERE_POINTS.length - 1, requestedIndex));
  return { ...SPHERE_POINTS[index], number: index + 1 };
}
