import { useId, type SVGProps } from 'react';

interface BrandIconProps extends SVGProps<SVGSVGElement> {
  title?: string;
}

export function BrandIcon({ title, ...props }: BrandIconProps) {
  const id = useId().replace(/:/g, '');
  const bgId = `${id}-colipas-bg`;

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
        <linearGradient id={bgId} x1="8" y1="6" x2="56" y2="59" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0f766e" />
          <stop offset="0.52" stopColor="#0d9488" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="58" height="58" rx="15" fill={`url(#${bgId})`} />
      <rect x="3" y="3" width="58" height="58" rx="15" fill="none" stroke="#ffffff" strokeOpacity="0.26" strokeWidth="1.6" />
      <path
        d="M13 47C7.2 47 4.4 42.2 7 37.6c1.8-3.1 5.1-4.5 8.5-4 1.3-9.1 8.8-15.9 17.9-15.9 8.5 0 15.7 6.2 17.1 14.8 4.8-.2 8.4 3.2 8.4 7.4 0 4.1-3.3 7.1-7.7 7.1Z"
        fill="#ffffff"
        fillOpacity="0.18"
      />
      <path
        d="M18 23 31 32l-13 9"
        fill="none"
        stroke="#ffffff"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M37 41h12" fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}
