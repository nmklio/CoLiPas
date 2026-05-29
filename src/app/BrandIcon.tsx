import { useId, type SVGProps } from 'react';

interface BrandIconProps extends SVGProps<SVGSVGElement> {
  title?: string;
}

export function BrandIcon({ title, ...props }: BrandIconProps) {
  const id = useId().replace(/:/g, '');
  const bgId = `${id}-colipas-bg`;
  const edgeId = `${id}-colipas-edge`;

  return (
    <svg
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      <defs>
        <linearGradient id={bgId} x1="8" y1="4" x2="58" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0f172a" />
          <stop offset="0.48" stopColor="#0f766e" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <linearGradient id={edgeId} x1="16" y1="13" x2="48" y2="49" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ecfeff" />
          <stop offset="1" stopColor="#bae6fd" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="58" height="58" rx="16" fill={`url(#${bgId})`} />
      <path
        d="M18.6 41.5h27.2c5.3 0 9.5-3.8 9.5-8.7 0-4.4-3.4-8-7.8-8.6C45.8 17.8 40.2 13 33.5 13c-7.2 0-13.2 5.1-14.3 11.9C13.4 25.7 9 30.4 9 36c0 3.2 1.4 5.8 3.9 7.2"
        fill="none"
        stroke={`url(#${edgeId})`}
        strokeWidth="4.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22.2 31.8l5 4.2-5 4.2"
        fill="none"
        stroke="#5eead4"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M32.4 40.2h10.8" fill="none" stroke="#f8fafc" strokeWidth="4" strokeLinecap="round" />
      <circle cx="45.4" cy="23.2" r="3.2" fill="#67e8f9" />
    </svg>
  );
}
