/**
 * SVG filter defs for the liquid-glass material, rendered once at the root so
 * `.btn-primary` can reference `url(#walkie-liquid-glass)` from its CSS
 * `backdrop-filter`. On Chromium this warps the backdrop through a soft
 * turbulence displacement map (the refractive "liquid lens" on primary
 * actions); engines that don't resolve `backdrop-filter: url()` keep the plain
 * frosted blur via the `@supports` guard in styles/base.css, so this is purely
 * additive. Ported from an earlier in-house liquid-glass design system.
 */
export function GlassFilters() {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}>
      <defs>
        <filter id="walkie-liquid-glass" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.013" numOctaves="2" seed="7" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="1.1" result="softNoise" />
          <feDisplacementMap in="SourceGraphic" in2="softNoise" scale="22" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}
