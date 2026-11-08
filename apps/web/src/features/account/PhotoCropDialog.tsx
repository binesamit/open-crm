// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { t } from '@bines/shared';
import { Button, Dialog } from '@bines/ui';
import { Icon } from '../../lib/icons';

export const CROP_MIN_ZOOM = 1;
export const CROP_MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const OUT_PX = 512;

/**
 * The chosen square of the photo, drawn at most 512px (WebP where the browser writes it, else PNG). `area` is in
 * the image's own pixels (react-easy-crop's `croppedAreaPixels`).
 */
export const cropToSquare = async (src: Blob, area: Area, size = OUT_PX): Promise<File> => {
  const bitmap = await createImageBitmap(src);
  const out = Math.max(1, Math.min(size, Math.round(area.width)));
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw { code: 'avatar_not_image' };
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, out, out);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92));
  if (!blob) throw { code: 'avatar_not_image' };
  const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
  return new File([blob], `avatar.${ext}`, { type: blob.type });
};

/**
 * r15 — the profile photo's crop step: the photo under a round mask; drag to move it, zoom with the
 * slider, the − / + buttons, the mouse wheel or a pinch; "שמירה" uploads the square inside the circle.
 */
export const PhotoCropDialog = ({
  source,
  busy,
  onCancel,
  onSave,
}: {
  /** The picked (or current) photo. */
  source: Blob;
  busy?: boolean;
  onCancel: () => void;
  onSave: (file: File) => void | Promise<void>;
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [saving, setSaving] = useState(false);
  // Read as a data URL (nothing to revoke — safe under StrictMode's double effects).
  useEffect(() => {
    const reader = new FileReader();
    reader.onload = () => setUrl(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(source);
    return () => reader.abort();
  }, [source]);
  const clamp = (z: number) => Math.min(CROP_MAX_ZOOM, Math.max(CROP_MIN_ZOOM, z));
  const save = async () => {
    if (!area) return;
    setSaving(true);
    try {
      await onSave(await cropToSquare(source, area));
    } finally {
      setSaving(false);
    }
  };
  const pct = Math.round(((zoom - CROP_MIN_ZOOM) / (CROP_MAX_ZOOM - CROP_MIN_ZOOM)) * 100);
  return (
    <Dialog
      open
      onClose={onCancel}
      title={t('profile.crop.title')}
      subtitle={t('profile.crop.hint')}
      className="md:max-w-[440px]"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} data-testid="photo-crop-cancel">
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} busy={saving || busy} disabled={!area} data-testid="photo-crop-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div
        dir="ltr"
        className="relative mx-auto aspect-square w-full max-w-[360px] overflow-hidden rounded-[var(--radius)] bg-[#0b1f1c]"
        data-testid="photo-crop"
        data-zoom={zoom.toFixed(2)}
      >
        {url ? (
          <Cropper
            image={url}
            crop={crop}
            zoom={zoom}
            minZoom={CROP_MIN_ZOOM}
            maxZoom={CROP_MAX_ZOOM}
            aspect={1}
            cropShape="round"
            showGrid={false}
            zoomSpeed={0.5}
            onCropChange={setCrop}
            onZoomChange={(z) => setZoom(clamp(z))}
            onCropComplete={(_, px) => setArea(px)}
            mediaProps={{ alt: '' }}
          />
        ) : null}
      </div>
      <div dir="ltr" className="mx-auto flex w-full max-w-[360px] items-center gap-2">
        <button
          type="button"
          className="grid size-8 shrink-0 place-items-center rounded-[8px] text-fg-2 hover:bg-surface-2 disabled:opacity-40"
          aria-label={t('profile.crop.zoomOut')}
          title={t('profile.crop.zoomOut')}
          disabled={zoom <= CROP_MIN_ZOOM}
          data-testid="photo-crop-zoom-out"
          onClick={() => setZoom((z) => clamp(z - ZOOM_STEP))}
        >
          <span aria-hidden className="text-lg leading-none">
            −
          </span>
        </button>
        <input
          type="range"
          min={CROP_MIN_ZOOM}
          max={CROP_MAX_ZOOM}
          step={0.01}
          value={zoom}
          aria-label={t('profile.crop.zoom')}
          aria-valuetext={`${pct}%`}
          data-testid="photo-crop-zoom"
          onChange={(e) => setZoom(clamp(Number(e.target.value)))}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--primary)]"
        />
        <button
          type="button"
          className="grid size-8 shrink-0 place-items-center rounded-[8px] text-fg-2 hover:bg-surface-2 disabled:opacity-40"
          aria-label={t('profile.crop.zoomIn')}
          title={t('profile.crop.zoomIn')}
          disabled={zoom >= CROP_MAX_ZOOM}
          data-testid="photo-crop-zoom-in"
          onClick={() => setZoom((z) => clamp(z + ZOOM_STEP))}
        >
          <Icon name="plus" size={15} />
        </button>
      </div>
    </Dialog>
  );
};
