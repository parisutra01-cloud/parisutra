import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';

const FALLBACK = [
  'FREE SHIPPING ON ORDERS ABOVE ₹999',
  'PREMIUM QUALITY TRIMS',
  'PAN INDIA DELIVERY',
];

function TruckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z" />
      <circle cx="7" cy="17.5" r="1.5" />
      <circle cx="17" cy="17.5" r="1.5" />
    </svg>
  );
}

function CrownIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 16h16M5 16l1.2-8 3.8 3.6L12 4l2 7.6 3.8-3.6L19 16" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M12 3.5 19 6.2v5.6c0 4.2-2.8 7.2-7 8.7-4.2-1.5-7-4.5-7-8.7V6.2L12 3.5z" />
    </svg>
  );
}

const ICONS = [TruckIcon, CrownIcon, ShieldIcon];

export default function TopBar() {
  const [items, setItems] = useState(FALLBACK);

  useEffect(() => {
    api('/cms/public/announcements')
      .then((data) => {
        const texts = (data.announcements || []).map((item) => item.text).filter(Boolean);
        if (texts.length) setItems(texts);
      })
      .catch(() => {});
  }, []);

  const loop = [];
  while (loop.length < 8) loop.push(...items);

  return (
    <div className="overflow-hidden bg-maroon text-[10px] tracking-[0.08em] text-white sm:text-[11px]">
      <div className="ticker-track flex w-max py-2">
        {[0, 1].map((copy) => (
          <div key={copy} className="flex min-w-[100vw] shrink-0 items-center">
            {loop.map((text, i) => {
              const Icon = ICONS[i % ICONS.length];
              return (
                <span key={`${copy}-${text}-${i}`} className="inline-flex items-center gap-1.5 whitespace-nowrap px-8 uppercase">
                  <Icon />
                  <span>{text}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
