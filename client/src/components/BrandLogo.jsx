import { Link } from 'react-router-dom';

const lockupOnCream = '/images/parisutra-logo-maroon.png';
const lockupOnMaroon = '/images/parisutra-logo-gold.png';

const heights = {
  header: 'h-[72px] w-auto max-w-[min(100%,240px)] md:h-[88px] md:max-w-[280px]',
  admin: 'h-[64px] w-auto max-w-[200px]',
  footer: 'h-[120px] w-auto max-w-[260px]',
};

export default function BrandLogo({ linked = true, to = '/', size = 'header' }) {
  const onDark = size === 'footer';
  const img = (
    <img
      src={onDark ? lockupOnMaroon : lockupOnCream}
      alt="parisutra — India's First Lace Brand"
      className={`object-contain object-center ${heights[size] || heights.header}`}
      width={280}
      height={onDark ? 120 : 88}
      decoding="async"
    />
  );

  if (!linked) return <span className="inline-flex justify-center">{img}</span>;
  return (
    <Link to={to} className="inline-flex justify-center transition hover:opacity-90">
      {img}
    </Link>
  );
}
