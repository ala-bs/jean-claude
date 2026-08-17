export function normalizeRotationDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

export function mapRotatedSurfacePoint({
  x,
  y,
  width,
  height,
  rotationDegrees,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
}) {
  const rotation = normalizeRotationDegrees(rotationDegrees);
  if (rotation === 90) {
    return { x: y, y: height - x };
  }
  if (rotation === 180) {
    return { x: width - x, y: height - y };
  }
  if (rotation === 270) {
    return { x: width - y, y: x };
  }
  return { x, y };
}
