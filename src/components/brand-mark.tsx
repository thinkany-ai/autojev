import { useId } from 'react';
import mascot from '../brand/mascot.json';

type BrandMarkProps = { className?: string };

// Rendered inline rather than through <img>: WebKit rasterises filtered SVG
// images at 1x, and inline markup lets the eyes blink with CSS.
export function BrandMark({ className }: BrandMarkProps) {
  const id = useId().replace(/:/g, '');
  const { tile, body, notch, eyes, blush } = mascot;
  return (
    <svg aria-hidden="true" className={'brand-mascot' + (className ? ' ' + className : '')} viewBox={`${tile.x} ${tile.y} ${tile.size} ${tile.size}`}>
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0.35" y2="1"><stop stopColor={tile.from}/><stop offset="1" stopColor={tile.to}/></linearGradient>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#FFFFFF"/><stop offset="1" stopColor="#FFE6D6"/></linearGradient>
        <mask id={`${id}-notch`}><rect width="1024" height="1024" fill="#fff"/><path d={notch} fill="#000"/></mask>
      </defs>
      <rect x={tile.x} y={tile.y} width={tile.size} height={tile.size} rx={tile.radius} fill={`url(#${id}-tile)`}/>
      <path d={body} mask={`url(#${id}-notch)`} transform="translate(0 18)" fill="#A82E08" opacity=".22"/>
      <path d={body} mask={`url(#${id}-notch)`} fill={`url(#${id}-body)`}/>
      <g fill="#FF8A5C" opacity=".35">{blush.map(([cx, cy]) => <ellipse key={cx} cx={cx} cy={cy} rx="40" ry="22"/>)}</g>
      <g className="brand-mascot-eyes">
        {eyes.map(eye => <g key={eye.cx}>
          <ellipse cx={eye.cx} cy={eye.cy} rx={eye.rx} ry={eye.ry} transform={`rotate(${eye.rotate} ${eye.cx} ${eye.cy})`} fill="#1B1D22"/>
          <circle cx={eye.glint[0]} cy={eye.glint[1]} r={eye.glint[2]} fill="#fff"/>
        </g>)}
      </g>
    </svg>
  );
}
