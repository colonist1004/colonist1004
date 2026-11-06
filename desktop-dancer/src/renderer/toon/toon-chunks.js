// GLSL pieces for toon.js. Each anchor is copied from three-vrm 3.x's MToon fragment shader; if one
// is not found (another three-vrm version), toon.js leaves that shader untouched.

export const CHUNKS = {
  anchorUniforms: 'uniform float giEqualizationFactor;',
  uniforms: /* glsl */ `
// ---- Desktop Dancer toon ----
uniform float uToonStrength;
uniform vec3 uHeadCenter;
uniform float uHeadRadius;
uniform vec3 uShadeWarm;
uniform float uHairShadowOn;
uniform vec2 uHairShadowOffset;
uniform vec2 uResolution;
uniform sampler2D uHairDepth;
#ifdef TOON_LIGHTMAP
  uniform sampler2D uToonLightmap;
#endif

float toonLit = 1.0; // shading of the last light, for the extras after lighting

// Face: shade as if the head were a sphere around the head bone (face meshes are flat or odd).
vec3 toonNormal( vec3 n, vec3 viewPos ) {
  #ifdef TOON_FACE
    vec3 sphereN = normalize( viewPos - uHeadCenter );
    return normalize( mix( n, sphereN, 0.75 * uToonStrength ) );
  #else
    return n;
  #endif
}

// Face: hair in front of this spot, seen a little toward the light, casts a shadow.
float toonHairShadow() {
  #ifdef TOON_FACE
    if ( uHairShadowOn < 0.5 ) return 1.0;
    vec2 suv = gl_FragCoord.xy / uResolution + uHairShadowOffset;
    if ( suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0 ) return 1.0;
    float d = texture2D( uHairDepth, suv ).r;
    return 1.0 - step( d, gl_FragCoord.z - 0.0005 ) * uToonStrength;
  #else
    return 1.0;
  #endif
}

// The shade color: models whose shade equals the lit color get a darker tinted one; skin goes warm.
vec3 toonShadeColor( vec3 shade, vec3 lit ) {
  const vec3 L = vec3( 0.299, 0.587, 0.114 );
  float flatness = smoothstep( 0.85, 0.97, dot( shade, L ) / max( dot( lit, L ), 1e-4 ) );
  vec3 s = mix( shade, lit * uShadeWarm * 0.72, flatness );
  #if defined( TOON_SKIN ) || defined( TOON_FACE )
    s *= mix( vec3( 1.0 ), uShadeWarm, 0.35 );
  #endif
  return mix( shade, s, uToonStrength );
}
// ---- /Desktop Dancer toon ----
`,

  getShadingOrig: `float getShading(
  const in float dotNL,
  const in float shadow,
  const in float shadingShift
) {
  float shading = dotNL;
  shading = shading + shadingShift;
  shading = linearstep( -1.0 + shadingToonyFactor, 1.0 - shadingToonyFactor, shading );
  shading *= shadow;
  return shading;
}`,

  getShadingToon: /* glsl */ `float getShading(
  const in float dotNL,
  const in float shadow,
  const in float shadingShift
) {
  float orig = linearstep( -1.0 + shadingToonyFactor, 1.0 - shadingToonyFactor, dotNL + shadingShift ) * shadow;
  float shift = shadingShift;
  #ifdef TOON_FACE
    shift += 0.25; // faces lean to the lit side
  #endif
  float s = dotNL + shift;
  float edge = fwidth( s ) + 0.02;
  float lit = mix( smoothstep( -edge, edge, s ), smoothstep( -0.25, 0.25, s ), 0.15 ); // one crisp step
  float toon = lit * shadow * toonHairShadow();
  float shading = mix( orig, toon, uToonStrength );
  toonLit = shading;
  return shading;
}`,

  getDiffuseMix: 'vec3 col = lightColor * BRDF_Lambert( mix( material.shadeColor, material.diffuseColor, shading ) );',
  getDiffuseMixToon:
    'vec3 col = lightColor * BRDF_Lambert( mix( toonShadeColor( material.shadeColor, material.diffuseColor ), material.diffuseColor, shading ) );',

  dotNL: 'float dotNL = clamp( dot( geometryNormal, directLight.direction ), -1.0, 1.0 );',
  dotNLToon: 'float dotNL = clamp( dot( toonNormal( geometryNormal, geometryPosition ), directLight.direction ), -1.0, 1.0 );',

  shadingShift: 'material.shadingShift = shadingShiftFactor;',
  shadingShiftToon: /* glsl */ `material.shadingShift = shadingShiftFactor;
  #ifdef TOON_LIGHTMAP
    material.shadingShift += ( texture2D( uToonLightmap, uv ).g - 0.5 ) * uToonStrength;
  #endif`,

  colSum: 'vec3 col = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
  colSumToon: /* glsl */ `vec3 col = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  #if defined( TOON_HAIR ) && !defined( OUTLINE )
  {
    // a highlight band that slides over the hair as the head moves (the camera looks along -Z)
    float nv = normal.z;
    float band = smoothstep( 0.82, 0.86, nv ) * ( 1.0 - smoothstep( 0.92, 0.96, nv ) );
    col += diffuseColor.rgb * band * 0.35 * toonLit * uToonStrength;
  }
  #endif
  #if ( defined( TOON_SKIN ) || defined( TOON_FACE ) ) && !defined( OUTLINE )
  {
    // a thin warm line where light turns into shade (fainter on the face, where it reads as a blush)
    float band = smoothstep( 0.1, 0.3, toonLit ) * ( 1.0 - smoothstep( 0.3, 0.55, toonLit ) );
    #ifdef TOON_FACE
      vec3 warm = vec3( 0.07, 0.02, 0.015 );
    #else
      vec3 warm = vec3( 0.16, 0.045, 0.03 );
    #endif
    col += diffuseColor.rgb * warm * band * uToonStrength;
  }
  #endif`,
};
