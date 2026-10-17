/**
 * A Pro's nameplate: the row takes the art's own colour, the piece melts in from the right behind a
 * soft dark wash, and sparkles twinkle around the face in the avatar's glow. The art is one canvas
 * on the plate painter; the rest is CSS (`theme.css`, "Pro nameplate").
 */
import type { CSSProperties, JSX, ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { type PlateRecipe, plateRecipe } from "../../shared/plate-recipe.ts";
import { type PlateHandle, mountPlate } from "./plate-painter.ts";
import { usePlateVariant } from "./plate-variant.ts";

/** How many sparkles twinkle around the face. */
const SPARKLES = 4;

/** The plate an account shows, from its id and the variant it rolled on this Mac. */
export function useNameplate(accountId: string): PlateRecipe {
  const variant = usePlateVariant(accountId);
  return useMemo(() => plateRecipe(accountId, variant), [accountId, variant]);
}

/** The plate's colours as the CSS reads them. */
function plateStyle(recipe: PlateRecipe): CSSProperties {
  return {
    "--plate-glow": recipe.colors.glow,
    "--plate-tint": recipe.tint,
  } as CSSProperties;
}

/** The art: one canvas the painter draws the piece into. */
function NameplateArt({ recipe }: { recipe: PlateRecipe }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<PlateHandle | null>(null);
  const shown = useRef(recipe);
  shown.current = recipe;
  useEffect(() => {
    if (!canvas.current) return;
    const mounted = mountPlate(canvas.current, shown.current);
    handle.current = mounted;
    return () => {
      mounted.dispose();
      handle.current = null;
    };
  }, []);
  useEffect(() => {
    handle.current?.set(recipe);
  }, [recipe]);
  return (
    <span className="nameplate-art" aria-hidden="true">
      <canvas ref={canvas} data-nameplate-scene={recipe.scene} />
    </span>
  );
}

/** A four-point star. */
function Sparkle(): JSX.Element {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M5 0C5.5 3.6 6.4 4.5 10 5 6.4 5.5 5.5 6.4 5 10 4.5 6.4 3.6 5.5 0 5 3.6 4.5 4.5 3.6 5 0z" />
    </svg>
  );
}

/** The sparkles around the face, staggered so they never twinkle together. */
function Sparkles(): JSX.Element {
  return (
    <span className="nameplate-sparkles" aria-hidden="true">
      {Array.from({ length: SPARKLES }, (_, at) => (
        <i key={at}>
          <Sparkle />
        </i>
      ))}
    </span>
  );
}

/** The plate around its row's contents (the face, the name, the credits); `sparkles` around the face, on by default. */
export function Nameplate({
  recipe,
  className,
  sparkles = true,
  children,
}: {
  recipe: PlateRecipe;
  className?: string;
  sparkles?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={className ? `nameplate ${className}` : "nameplate"} style={plateStyle(recipe)} data-nameplate>
      <NameplateArt recipe={recipe} />
      <span className="nameplate-wash" aria-hidden="true" />
      {sparkles && <Sparkles />}
      {children}
    </div>
  );
}
