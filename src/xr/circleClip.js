import { ShaderChunk } from 'three';

/**
 * Makes the map table's four side clipping planes cut a circle instead of a
 * square.
 *
 * A clipping plane only cuts straight, so the round window is still four
 * planes (mapTable.js keeps them first, in the order -x, +x, -z, +z). Each
 * plane's signed distance to a fragment is available in the shader, and the
 * two on an axis give the fragment's position across the table: with
 * d0 = x + h and d1 = h - x, x is (d0 - d1) / 2 and the window's half-width
 * h, at whatever scale the table is, is (d0 + d1) / 2. Anything farther from
 * the centre than h is discarded, which leaves the inscribed circle. It reads
 * only the planes, so it needs no uniform and follows the table as it is
 * carried.
 *
 * This appends to three's shared chunk, so it must run before the first
 * clipped material compiles. It applies to materials clipped by four or more
 * planes; the map table's are the only ones.
 */
export const CIRCLE_CLIP = /* glsl */ `
#if NUM_CLIPPING_PLANES >= 4
	{
		float d0 = - dot( vClipPosition, clippingPlanes[ 0 ].xyz ) + clippingPlanes[ 0 ].w;
		float d1 = - dot( vClipPosition, clippingPlanes[ 1 ].xyz ) + clippingPlanes[ 1 ].w;
		float d2 = - dot( vClipPosition, clippingPlanes[ 2 ].xyz ) + clippingPlanes[ 2 ].w;
		float d3 = - dot( vClipPosition, clippingPlanes[ 3 ].xyz ) + clippingPlanes[ 3 ].w;
		vec2 across = vec2( d0 - d1, d2 - d3 ) * 0.5;
		float reach = ( d0 + d1 ) * 0.5;
		if ( dot( across, across ) > reach * reach ) discard;
	}
#endif
`;

export function installCircleClip() {
  if (ShaderChunk.clipping_planes_fragment.includes('float reach')) return;
  ShaderChunk.clipping_planes_fragment += CIRCLE_CLIP;
}
