/**
 * The toolbar action that opens the mixed-reality globe (xr.html), facing
 * the place the camera is over, so a headset user picks up where the desktop
 * view left off.
 */

export const MIXED_REALITY_PAGE = 'xr.html';

/**
 * The mixed-reality page URL for a camera position in radians
 * (`{ latitude, longitude }`, as Cesium's Cartographic), relative to `base`.
 */
export function mixedRealityHref(cartographic, base = 'http://localhost/') {
  const url = new URL(MIXED_REALITY_PAGE, base);
  const lat = (Number(cartographic?.latitude) * 180) / Math.PI;
  const lon = (Number(cartographic?.longitude) * 180) / Math.PI;
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  ) {
    url.searchParams.set('lat', lat.toFixed(4));
    url.searchParams.set('lon', lon.toFixed(4));
  }
  return url.href;
}
