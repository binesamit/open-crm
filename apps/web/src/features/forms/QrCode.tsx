// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from 'react';
import { encode } from 'uqr';

/** A QR code drawn in the browser (nothing leaves it). Dark on white for cameras. Forms and two-factor set-up. */
export const QrCode = ({
  value,
  size = 160,
  label,
  testId = 'form-qr',
}: {
  value: string;
  size?: number;
  label: string;
  testId?: string;
}) => {
  const qr = useMemo(() => encode(value, { ecc: 'M', border: 2 }), [value]);
  const path = useMemo(() => {
    let d = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return d;
  }, [qr]);
  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      data-testid={testId}
      className="rounded-[var(--radius)] border border-line bg-white"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
};

/** Saves the QR code as an SVG file (for print or a flyer). */
export const downloadQr = (value: string, fileName: string) => {
  const qr = encode(value, { ecc: 'M', border: 2 });
  let d = '';
  qr.data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.size} ${qr.size}" width="512" height="512" shape-rendering="crispEdges"><rect width="${qr.size}" height="${qr.size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
