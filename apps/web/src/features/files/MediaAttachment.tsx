// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { mediaKindOf, t } from '@bines/shared';
import { Skeleton } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { formatSize } from '../../lib/upload';
import { useInlineUrl } from './FileViewer';
import { MediaPlayer } from './MediaPlayer';
import { TranscriptPanel } from './Transcript';

/** Whether a file plays in place (audio / video, by type or extension) —. */
export const isMedia = (f: { name: string; mime: string }) => mediaKindOf(f) !== null;

/**
 * An audio / video file attached to an update: played right there, its name below — a press on the name
 * opens it in the file viewer (comments, versions, download). A format the browser cannot play shows as a file.
 */
export const MediaAttachment = ({
  accountId,
  file,
  onOpen,
}: {
  accountId: string;
  file: { id: string; name: string; mime: string; size: number };
  onOpen: () => void;
}) => {
  const kind = mediaKindOf(file) ?? 'audio';
  const url = useInlineUrl(accountId, file.id);
  const [failed, setFailed] = useState(false);
  const src = url.data?.download_url;
  return (
    <div
      className={kind === 'video' ? 'flex max-w-full flex-col gap-1' : 'flex w-full max-w-md flex-col gap-1'}
      data-testid="update-media"
      data-kind={kind}
    >
      {failed ? null : src ? (
        <MediaPlayer key={src} src={src} kind={kind} name={file.name} compact onError={() => setFailed(true)} />
      ) : (
        <Skeleton className={kind === 'video' ? 'h-44 w-80 max-w-full' : 'h-10 w-full'} />
      )}
      <button
        type="button"
        onClick={onOpen}
        data-testid="update-file"
        title={t('media.openInViewer')}
        className="flex min-w-0 items-center gap-1.5 self-start rounded-[6px] px-1 text-xs text-muted hover:text-fg"
      >
        <Icon name={kind === 'video' ? 'play' : 'volume'} size={13} />
        <span className="truncate">{file.name}</span>
        <span dir="ltr">· {formatSize(file.size)}</span>
        {failed ? <span>· {t('media.cannotPlayShort')}</span> : null}
      </button>
      {/*: its text only on request, kept on the file and editable by whoever may edit its update. */}
      <TranscriptPanel accountId={accountId} fileId={file.id} />
    </div>
  );
};
