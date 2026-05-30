import { useId, type SVGProps } from 'react';

interface BrandIconProps extends SVGProps<SVGSVGElement> {
  title?: string;
}

export function BrandIcon({ title, ...props }: BrandIconProps) {
  const id = useId().replace(/:/g, '');
  const bgId = `${id}-colipas-bg`;
  const cloudId = `${id}-colipas-cloud`;

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
        <linearGradient id={bgId} x1="7" y1="5" x2="57" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0f766e" />
          <stop offset="0.48" stopColor="#0ea5a5" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <linearGradient id={cloudId} x1="16" y1="17" x2="50" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dff9ff" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="14" fill={`url(#${bgId})`} />
      <rect x="4" y="4" width="56" height="56" rx="14" fill="none" stroke="rgba(255,255,255,.34)" strokeWidth="2" />
      <path
        d="M19.2 43.5h26.6c5.9 0 10.7-4.2 10.7-9.8 0-5.1-3.9-9.2-8.9-9.7C45.4 18 39.8 14.2 33.2 14.2c-7.2 0-13.1 4.8-14.7 11.4C12.4 26.2 7.8 31 7.8 36.9c0 3.8 1.9 7.1 4.8 9.1 1.9-1.6 4.1-2.5 6.6-2.5Z"
        fill={`url(#${cloudId})`}
        opacity="0.96"
      />
      <path
        d="M21.6 33.1 27 37.2l-5.4 4.1"
        fill="none"
        stroke="#0f766e"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M33.2 41.2h11.5" fill="none" stroke="#2563eb" strokeWidth="4.2" strokeLinecap="round" />
      <circle cx="45.5" cy="22.8" r="3.4" fill="#67e8f9" />
      <circle cx="45.5" cy="22.8" r="1.5" fill="#0f766e" />
    </svg>
  );
}
